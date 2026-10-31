package com.wag2api.ag

import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.util.concurrent.ConcurrentHashMap

/**
 * 移植自 src/account-pool.mjs
 *
 * Multi-Account Pool & Smart Scheduler：
 * 1. 冷却与人工验证封禁管理（与 upstream-policy 联动）；
 * 2. 会话粘滞（带 TTL 与 1000 条 LRU 上限）；
 * 3. 四种调度模式：cache_first / balance / performance / fixed；
 * 4. 兼容老接口 switchAccount(email)。
 *
 * 存盘：accountsDir 下每个账号一个 <邮箱非字母数字换成_>.json（即 TokenManager 的 tokenData），
 * scheduling.json 与 Node 版字段一致：{mode, fixed_email, prewarm_weekly}。
 *
 * 并发：managers 是写时复制的只读 Map（遍历安全）；其余状态用 ConcurrentHashMap / 对象锁。
 */
class AccountPool @JvmOverloads constructor(val accountsDir: String, schedulingFile: String? = null) {

    val schedulingFile: String = schedulingFile ?: run {
        val d = File(accountsDir)
        if (d.name == "accounts") File(d.parentFile, "scheduling.json").path else File(d, "scheduling.json").path
    }

    @get:JvmName("schedulingModeField") @set:JvmName("schedulingModeFieldSet")
    @Volatile var schedulingMode: String = "cache_first"
    @get:JvmName("fixedEmailField") @set:JvmName("fixedEmailFieldSet")
    @Volatile var fixedEmail: String = ""
    @Volatile var prewarmWeekly: Boolean = false
    @get:JvmName("quotaRefreshStatusField") @set:JvmName("quotaRefreshStatusFieldSet")
    @Volatile var quotaRefreshStatus: JSONObject = JSONObject()
        .put("interval_min", 15).put("last_run_at", JSONObject.NULL).put("next_run_at", JSONObject.NULL)

    private class Perf { val records = ArrayList<Pair<Boolean, Long>>(); var failStreak = 0 }
    private class Block(val reason: String, val url: String, val until: Long)
    private class Bound(val email: String, @Volatile var expireAt: Long)

    private val perfHistory = ConcurrentHashMap<String, Perf>()
    private val quotaMap = ConcurrentHashMap<String, JSONObject>()        // email -> {gemini, claude, argon}

    /** email -> TokenManager（插入顺序；写时复制，可放心遍历） */
    @Volatile var managers: Map<String, TokenManager> = LinkedHashMap()
        private set
    @Volatile var activeEmail: String = ""
    @get:JvmName("selectedEmailField") @set:JvmName("selectedEmailFieldSet")
    @Volatile var selectedEmail: String = ""
    private val cooldownUntil = ConcurrentHashMap<String, Long>()
    private val validationBlocks = ConcurrentHashMap<String, Block>()
    private val sessionAffinity = LinkedHashMap<String, Bound>()           // 受 this 锁保护
    private val lastUsed = ConcurrentHashMap<String, Long>()

    init {
        init()
    }

    private inline fun mutateManagers(f: (LinkedHashMap<String, TokenManager>) -> Unit) {
        synchronized(this) {
            val m = LinkedHashMap(managers)
            f(m)
            managers = m
        }
    }

    private fun init() {
        loadScheduling()
        val dir = File(accountsDir)
        if (!dir.exists()) dir.mkdirs()
        val files = dir.list()?.sorted() ?: emptyList()   // fs.readdirSync 返回排序后的文件名
        for (f in files) {
            if (f.endsWith(".json")) {
                val tm = TokenManager(File(dir, f).path)
                if (tm.tokenData.email.isNotEmpty()) {
                    val email = tm.tokenData.email.trim()
                    mutateManagers { it[email] = tm }
                    if (activeEmail.isEmpty()) activeEmail = email
                } else {
                    tm.stopKeepAlive()
                }
            }
        }

        // 环境变量注入（与 Node 版一致；安卓上一般没有）
        val envAg = System.getenv("AG_ACCOUNTS") ?: System.getenv("AG_TOKENS") ?: System.getenv("GOOGLE_ACCOUNTS")
        if (!envAg.isNullOrEmpty()) {
            try {
                val items = ArrayList<JSONObject>()
                try {
                    when (val parsed = M2Json.parse(envAg)) {
                        is JSONArray -> for (i in 0 until parsed.length()) parsed.optJSONObject(i)?.let { items.add(it) }
                        is JSONObject -> items.add(parsed)
                    }
                } catch (e: Exception) {
                    val parts = envAg.split(':')
                    if (parts.size >= 2) items.add(JSONObject().put("email", parts[0]).put("refreshToken", parts.drop(1).joinToString(":")))
                }
                for (it in items) {
                    val rt = it.optString("refreshToken", "")
                    val em = it.optString("email", "")
                    if (rt.isNotEmpty() && em.isNotEmpty()) {
                        addAccount(rt, em.trim(), it.optString("projectId", ""))
                        M2Log.i("[AccountPool] 成功从环境变量注入 AG 账号: $em")
                    }
                }
            } catch (e: Exception) {
                M2Log.w("[AccountPool] 环境变量注入 AG 账号失败: ${e.message}")
            }
        }
    }

    private fun fileFor(email: String) = File(accountsDir, email.replace(Regex("[^a-zA-Z0-9]"), "_") + ".json")

    /** 添加/更新账号；换票与项目探测在后台线程进行（与 Node 版不 await 一致） */
    @JvmOverloads
    fun addAccount(refreshToken: String, email: String?, projectId: String? = ""): TokenManager {
        val cleanEmail = (email ?: "").trim()
        val tm = TokenManager(fileFor(cleanEmail).path)
        // setRefreshToken 的同步部分
        tm.tokenData.refreshToken = refreshToken
        if (cleanEmail.isNotEmpty()) tm.tokenData.email = cleanEmail
        tm.save()
        if (!projectId.isNullOrEmpty()) tm.tokenData.projectId = projectId
        M2Exec.bg {
            val t = tm.refreshAccessToken()
            if (!t.isNullOrEmpty()) tm.ensureProjectId()
        }
        var old: TokenManager? = null
        mutateManagers { old = it.put(cleanEmail, tm) }
        if (old != null && old !== tm) old?.stopKeepAlive()
        if (activeEmail.isEmpty() || !managers.containsKey(activeEmail)) activeEmail = cleanEmail

        // 云端持久化（安卓版 DbVault 未启用，等同 Node 版未配置 SQL_DSN）
        try {
            dbVault.save(cleanEmail, "ag_account", JSONObject().put("email", cleanEmail).put("refreshToken", refreshToken).put("projectId", projectId ?: ""))
        } catch (_: Exception) {}
        return tm
    }

    /** 兼容别名，防 /api/accounts/switch 报 500 */
    fun switchAccount(email: String?): TokenManager? {
        setSelectedEmail(email)
        return getActiveManager()
    }

    fun removeAccount(email: String?): Boolean {
        val clean = (email ?: "").trim()
        val tm = managers[clean] ?: return false
        try { tm.stopKeepAlive() } catch (_: Exception) {}
        mutateManagers { it.remove(clean) }
        cooldownUntil.remove(clean)
        validationBlocks.remove(clean)
        lastUsed.remove(clean)
        perfHistory.remove(clean)
        quotaMap.remove(clean)
        synchronized(this) {
            val it = sessionAffinity.entries.iterator()
            while (it.hasNext()) if (it.next().value.email == clean) it.remove()
        }
        val f = fileFor(clean)
        if (f.exists()) try { f.delete() } catch (_: Exception) {}
        if (selectedEmail == clean) selectedEmail = ""
        if (activeEmail == clean) activeEmail = managers.keys.firstOrNull() ?: ""
        try { dbVault.remove(clean) } catch (_: Exception) {}
        return true
    }

    fun clearAccounts() {
        val old = managers
        mutateManagers { it.clear() }
        for (tm in old.values) try { tm.stopKeepAlive() } catch (_: Exception) {}
        activeEmail = ""
        selectedEmail = ""
        cooldownUntil.clear()
        validationBlocks.clear()
        synchronized(this) { sessionAffinity.clear() }
        lastUsed.clear()
        perfHistory.clear()
        quotaMap.clear()
        val dir = File(accountsDir)
        if (dir.exists()) {
            dir.listFiles()?.forEach { f -> if (f.name.endsWith(".json")) try { f.delete() } catch (_: Exception) {} }
        }
    }

    // ───────── 冷却管理 ─────────
    @JvmOverloads
    fun markCooling(email: String?, ms: Long = AG_DEFAULT_COOLDOWN_MS) {
        val clean = (email ?: "").trim()
        cooldownUntil[clean] = System.currentTimeMillis() + ms
        M2Log.i("[AccountPool] 账号 $clean 进入冷却 (${Math.round(ms / 1000.0)}秒)")
    }

    fun isCooling(email: String?): Boolean {
        val clean = (email ?: "").trim()
        val until = cooldownUntil[clean] ?: return false
        if (until == 0L) return false
        if (System.currentTimeMillis() >= until) {
            cooldownUntil.remove(clean)
            return false
        }
        return true
    }

    fun cooldownRemainSec(email: String?): Long {
        val clean = (email ?: "").trim()
        val until = cooldownUntil[clean] ?: return 0
        if (until == 0L) return 0
        val left = until - System.currentTimeMillis()
        return if (left > 0) Math.ceil(left / 1000.0).toLong() else 0
    }

    fun clearCooldown(email: String?) {
        val clean = (email ?: "").trim()
        if (clean.isNotEmpty()) cooldownUntil.remove(clean)
    }

    fun clearAllCooldowns() = cooldownUntil.clear()

    // ───────── 人工验证封禁 ─────────
    @JvmOverloads
    fun markValidationBlocked(email: String?, reason: String? = "", url: String? = "", ms: Long = 10 * 60 * 1000L) {
        val clean = (email ?: "").trim()
        if (clean.isEmpty()) return
        validationBlocks[clean] = Block(reason ?: "", url ?: "", System.currentTimeMillis() + ms)
        M2Log.w("[AccountPool] 账号 $clean 进入人工验证封禁 (${Math.round(ms / 1000.0)}秒)")
    }

    fun isValidationBlocked(email: String?): Boolean {
        val clean = (email ?: "").trim()
        val info = validationBlocks[clean] ?: return false
        if (System.currentTimeMillis() >= info.until) {
            validationBlocks.remove(clean)
            return false
        }
        return true
    }

    fun clearValidationBlocked(email: String?) {
        validationBlocks.remove((email ?: "").trim())
    }

    /** {blocked, reason, url, until} */
    fun validationInfo(email: String?): JSONObject {
        val clean = (email ?: "").trim()
        val info = validationBlocks[clean]
        if (info == null || System.currentTimeMillis() >= info.until) {
            if (info != null) validationBlocks.remove(clean)
            return JSONObject().put("blocked", false).put("reason", "").put("url", "").put("until", 0)
        }
        return JSONObject().put("blocked", true).put("reason", info.reason).put("url", info.url).put("until", info.until)
    }

    fun clearAllValidationBlocks() = validationBlocks.clear()

    // ───────── 调度设置与持久化 ─────────
    fun loadScheduling() {
        try {
            val f = File(schedulingFile)
            if (f.exists()) {
                val data = M2Json.parse(f.readText(Charsets.UTF_8)) as? JSONObject
                if (data != null) {
                    val mode = data.opt("mode")
                    if (mode is String && mode in VALID_MODES) schedulingMode = mode
                    val fe = data.opt("fixed_email")
                    if (fe is String) {
                        fixedEmail = fe.trim()
                        if (schedulingMode == "fixed") selectedEmail = fixedEmail
                    }
                    val pw = data.opt("prewarm_weekly")
                    if (pw is Boolean) prewarmWeekly = pw
                }
            }
        } catch (e: Exception) {
            M2Log.w("[AccountPool] 读取 scheduling.json 失败: ${e.message}")
        }
    }

    fun saveScheduling() {
        try {
            val content = M2Json.stringify(
                JSONObject().put("mode", schedulingMode).put("fixed_email", fixedEmail).put("prewarm_weekly", prewarmWeekly), 2,
            )
            M2Json.writeFile(File(schedulingFile), content)
        } catch (e: Exception) {
            M2Log.w("[AccountPool] 保存 scheduling.json 失败: ${e.message}")
        }
    }

    fun getSchedulingMode(): String = schedulingMode
    fun getFixedEmail(): String = fixedEmail

    /** 合并更新 {interval_min, last_run_at, next_run_at, ...} */
    fun setQuotaRefreshStatus(status: JSONObject?) {
        if (status == null) return
        synchronized(this) {
            val merged = JSONObject(quotaRefreshStatus.toString())
            for (k in status.keys()) merged.put(k, status.opt(k))
            quotaRefreshStatus = merged
        }
    }

    fun getScheduling(): JSONObject = JSONObject()
        .put("mode", schedulingMode)
        .put("fixed_email", fixedEmail)
        .put("prewarm_weekly", prewarmWeekly)
        .put("modes", schedulingModesJson())
        .put("quota_refresh", quotaRefreshStatus)

    /**
     * Node：setScheduling({mode, fixed_email, prewarm_weekly})。
     * body 里没有的字段视为 undefined（fixed_email 为 null 时等同空串）。无效模式抛 IllegalArgumentException。
     */
    fun setScheduling(body: JSONObject?): JSONObject {
        val b = body ?: JSONObject()
        val mode = b.opt("mode").let { if (M2Json.truthy(it)) it.toString() else null }
        val hasFixed = b.has("fixed_email")
        val fixed = if (hasFixed) b.opt("fixed_email").let { if (M2Json.truthy(it)) it.toString() else "" } else null
        val pw = b.opt("prewarm_weekly") as? Boolean
        return setScheduling(mode, fixed, pw)
    }

    /** 参数为 null = 不修改 */
    fun setScheduling(mode: String?, fixed_email: String?, prewarm_weekly: Boolean?): JSONObject {
        synchronized(this) {
            val targetMode = if (!mode.isNullOrEmpty()) mode else schedulingMode
            if (targetMode !in VALID_MODES) throw IllegalArgumentException("无效的调度模式: $targetMode")
            schedulingMode = targetMode
            if (fixed_email != null) {
                fixedEmail = fixed_email.trim()
                if (schedulingMode == "fixed") selectedEmail = fixedEmail
                else if (selectedEmail == fixedEmail) selectedEmail = ""
            }
            if (prewarm_weekly != null) prewarmWeekly = prewarm_weekly
            saveScheduling()
        }
        M2Log.i("[AccountPool] 调度策略已更新 ➔ 模式: $schedulingMode${if (fixedEmail.isNotEmpty()) ", 固定账号: $fixedEmail" else ""}, 周预热: $prewarmWeekly")
        return getScheduling()
    }

    // ───────── 性能统计与配额 ─────────
    @JvmOverloads
    fun recordResult(email: String?, success: Boolean, latencyMs: Number? = 0) {
        val clean = (email ?: "").trim()
        if (clean.isEmpty()) return
        val h = perfHistory.getOrPut(clean) { Perf() }
        synchronized(h) {
            val lat = latencyMs?.toDouble()?.takeIf { !it.isNaN() } ?: 0.0
            h.records.add(success to maxOf(0L, Math.round(lat)))
            if (h.records.size > 20) h.records.removeAt(0)
            h.failStreak = if (success) 0 else h.failStreak + 1
        }
    }

    /** {success_rate, avg_latency_ms, fail_streak}（无记录时前两者为 null） */
    fun getPerfStats(email: String?): JSONObject {
        val clean = (email ?: "").trim()
        val h = perfHistory[clean]
        val o = JSONObject()
        if (h == null) return o.put("success_rate", JSONObject.NULL).put("avg_latency_ms", JSONObject.NULL).put("fail_streak", 0)
        synchronized(h) {
            if (h.records.isEmpty()) return o.put("success_rate", JSONObject.NULL).put("avg_latency_ms", JSONObject.NULL).put("fail_streak", 0)
            val n = h.records.size
            val successes = h.records.count { it.first }
            val rate = Math.round((successes.toDouble() / n) * 100) / 100.0
            val avg = Math.round(h.records.sumOf { it.second }.toDouble() / n)
            return o.put("success_rate", rate).put("avg_latency_ms", avg).put("fail_streak", h.failStreak)
        }
    }

    /** quotaObj：数字（统一剩余比例）或 JSONObject（gemini/claude/argon 或 gemini_5h、claude_7d 等原始桶） */
    fun updateQuota(email: String?, quotaObj: Any?) {
        val clean = (email ?: "").trim()
        if (clean.isEmpty()) return
        if (quotaObj is Number) {
            fun entry() = JSONObject().put("fraction", quotaObj.toDouble()).put("reset_time", JSONObject.NULL)
            quotaMap[clean] = JSONObject().put("gemini", entry()).put("claude", entry()).put("argon", entry())
            return
        }
        val q: JSONObject = when (quotaObj) {
            is JSONObject -> quotaObj
            is Map<*, *> -> JSONObject(quotaObj)
            else -> return
        }
        val prev = quotaMap[clean] ?: JSONObject().put("gemini", JSONObject.NULL).put("claude", JSONObject.NULL).put("argon", JSONObject.NULL)

        val hasRaw = RAW_KEYS.any { q.has(it) }
        val gemini: Any?; val claude: Any?; val argon: Any?
        if (hasRaw) {
            gemini = parseBucketOrVal(null, jsGet(q, "gemini_5h"), jsGet(q, "gemini_7d"))
            claude = parseBucketOrVal(null, jsGet(q, "claude_5h"), jsGet(q, "claude_7d"))
            argon = parseBucketOrVal(null, jsGet(q, "argon_5h"), jsGet(q, "argon_7d"))
        } else {
            gemini = if (q.has("gemini")) parseBucketOrVal(jsGet(q, "gemini")) else prev.opt("gemini")
            claude = if (q.has("claude")) parseBucketOrVal(jsGet(q, "claude")) else prev.opt("claude")
            argon = if (q.has("argon")) parseBucketOrVal(jsGet(q, "argon")) else prev.opt("argon")
        }
        quotaMap[clean] = JSONObject()
            .put("gemini", gemini ?: JSONObject.NULL)
            .put("claude", claude ?: JSONObject.NULL)
            .put("argon", argon ?: JSONObject.NULL)
    }

    private object Undef

    /** 读取字段：缺失 → Undef，null → null */
    private fun jsGet(o: JSONObject, k: String): Any? = if (!o.has(k)) Undef else o.opt(k).let { if (it == JSONObject.NULL) null else it }

    /** a ?? b ?? null */
    private fun coalesce(vararg xs: Any?): Any? {
        for (x in xs) if (x != null && x !== Undef && x != JSONObject.NULL) return x
        return null
    }

    private fun parseBucketOrVal(v: Any?, f5hObj: Any? = Undef, f7dObj: Any? = Undef): JSONObject? {
        if (f5hObj !== Undef || f7dObj !== Undef) {
            fun getFrac(o: Any?): Any? = when (o) {
                is Number -> o
                is JSONObject -> coalesce(jsGet(o, "remaining_fraction"), jsGet(o, "fraction"))
                else -> null
            }
            fun getReset(o: Any?): Any? = if (o is JSONObject) {
                val a = o.opt("reset_time"); val b = o.opt("reset")
                if (M2Json.truthy(a)) a else if (M2Json.truthy(b)) b else null
            } else null
            return JSONObject()
                .put("f5h", getFrac(f5hObj) ?: JSONObject.NULL)
                .put("reset5h", getReset(f5hObj) ?: JSONObject.NULL)
                .put("f7d", getFrac(f7dObj) ?: JSONObject.NULL)
                .put("reset7d", getReset(f7dObj) ?: JSONObject.NULL)
        }
        if (v is Number) return JSONObject().put("fraction", v).put("reset_time", JSONObject.NULL)
        if (v is JSONObject) {
            if (v.has("f5h") || v.has("f7d")) return JSONObject(v.toString())
            val frac = coalesce(jsGet(v, "remaining_fraction"), jsGet(v, "fraction"))
            val a = v.opt("reset_time"); val b = v.opt("reset")
            val reset: Any? = if (M2Json.truthy(a)) a else if (M2Json.truthy(b)) b else null
            if (frac is Number) return JSONObject().put("fraction", frac).put("reset_time", reset ?: JSONObject.NULL)
        }
        return null
    }

    /** 某家族的有效剩余比例（已过重置时间按 1.0）；未知返回 null */
    @JvmOverloads
    fun getQuota(email: String?, family: String? = "gemini", now: Long = System.currentTimeMillis()): Double? {
        val clean = (email ?: "").trim()
        val entry = quotaMap[clean] ?: return null
        val fam = (if (family.isNullOrEmpty()) "gemini" else family).lowercase()
        val v = entry.opt(fam)
        if (v == null || v == JSONObject.NULL) return null
        if (v is Number) return v.toDouble()
        if (v is JSONObject && (v.has("f5h") || v.has("f7d"))) {
            fun isPassed(r: Any?): Boolean {
                if (!M2Json.truthy(r)) return false
                val t = M2Json.dateMs(r) ?: return false
                return t <= now
            }
            val f5 = v.opt("f5h"); val f7 = v.opt("f7d")
            val eff5h: Double? = if (f5 is Number) (if (isPassed(v.opt("reset5h"))) 1.0 else f5.toDouble()) else null
            val eff7d: Double? = if (f7 is Number) (if (isPassed(v.opt("reset7d"))) 1.0 else f7.toDouble()) else null
            if (eff5h != null && eff7d != null) return minOf(eff5h, eff7d)
            return eff5h ?: eff7d
        }
        if (v is JSONObject) {
            val fr = v.opt("fraction")
            if (fr is Number) {
                val rt = v.opt("reset_time")
                if (M2Json.truthy(rt)) {
                    val t = M2Json.dateMs(rt)
                    if (t != null && t <= now) return 1.0
                }
                return fr.toDouble()
            }
        }
        return null
    }

    @JvmOverloads
    fun isFamilyProtected(email: String?, family: String? = "gemini", now: Long = System.currentTimeMillis()): Boolean {
        val q = getQuota(email, family, now)
        return q != null && q <= 0.02
    }

    @JvmOverloads
    fun getProtectedFamilies(email: String?, now: Long = System.currentTimeMillis()): List<String> =
        listOf("gemini", "claude", "argon").filter { isFamilyProtected(email, it, now) }

    // ───────── 调度 ─────────
    fun getSelectedEmail(): String = selectedEmail

    fun setSelectedEmail(email: String?) {
        selectedEmail = (email ?: "").trim()
        if (selectedEmail.isNotEmpty() && managers.containsKey(selectedEmail)) activeEmail = selectedEmail
        M2Log.i("[AccountPool] 调度模式变更 ➔ ${if (selectedEmail.isNotEmpty()) "锁定账号: $selectedEmail" else "全自动智能轮询"}")
    }

    fun touch(email: String?) {
        if (email.isNullOrEmpty()) return
        lastUsed[email.trim()] = System.currentTimeMillis()
    }

    /** 会话亲和绑定（LRU，上限 MAX_AFFINITY_ENTRIES） */
    fun bindSession(sessionKey: String?, email: String?) {
        if (sessionKey.isNullOrEmpty() || email.isNullOrEmpty()) return
        val cleanEmail = email.trim()
        synchronized(this) {
            if (sessionAffinity.containsKey(sessionKey)) {
                sessionAffinity.remove(sessionKey)
            } else if (sessionAffinity.size >= MAX_AFFINITY_ENTRIES) {
                val oldest = sessionAffinity.keys.iterator().next()
                sessionAffinity.remove(oldest)
            }
            sessionAffinity[sessionKey] = Bound(cleanEmail, System.currentTimeMillis() + AG_SESSION_TTL_MS)
        }
    }

    private fun lu(e: String): Long = lastUsed[e] ?: 0L

    private fun pickBalanced(candidates: List<String>, family: String): String {
        if (candidates.size == 1) return candidates[0]
        class S(val email: String, val q: Double, val last: Long)
        val scored = candidates.map { e -> S(e, getQuota(e, family) ?: 0.5, lu(e)) }
        // 配额差距 > 0.15 时配额高者优先，否则最久未使用优先
        val sorted = jsSort(scored) { a, b ->
            val qDiff = b.q - a.q
            if (Math.abs(qDiff) > 0.15) qDiff else (a.last - b.last).toDouble()
        }
        return sorted[0].email
    }

    private fun pickPerformance(candidates: List<String>): String {
        if (candidates.size == 1) return candidates[0]
        class S(val email: String, val failStreak: Int, val successRate: Double, val latency: Double, val last: Long)
        val scored = candidates.map { e ->
            val p = getPerfStats(e)
            val sr = p.opt("success_rate"); val lat = p.opt("avg_latency_ms")
            S(e, p.optInt("fail_streak", 0),
                if (sr is Number) sr.toDouble() else 0.8,
                if (lat is Number) lat.toDouble() else 1500.0,
                lu(e))
        }
        val sorted = jsSort(scored) { a, b ->
            if (a.failStreak != b.failStreak) return@jsSort (a.failStreak - b.failStreak).toDouble()
            val srDiff = b.successRate - a.successRate
            if (Math.abs(srDiff) > 0.05) return@jsSort srDiff
            val latDiff = a.latency - b.latency
            if (Math.abs(latDiff) > 100) return@jsSort latDiff
            (a.last - b.last).toDouble()
        }
        return sorted[0].email
    }

    /**
     * 核心：智能选号（调度模式 + 会话粘滞 + 家族配额 + 冷却避障）
     * @param options 模型名（String），或 JSONObject/Map {model, family}
     */
    @JvmOverloads
    fun pickManager(sessionKey: String? = "", exclude: Set<String> = emptySet(), options: Any? = null): TokenManager? {
        val mgrs = managers
        if (mgrs.isEmpty()) return null
        val usable = mgrs.keys.filter { !exclude.contains(it) && !isValidationBlocked(it) }
        if (usable.isEmpty()) return null

        var family = "gemini"
        when (options) {
            is String -> family = QuotaFetcher.getModelFamily(options)
            is JSONObject -> {
                val model = options.optString("model", "")
                val fam = options.opt("family")
                family = if (M2Json.truthy(fam)) fam.toString() else if (model.isNotEmpty()) QuotaFetcher.getModelFamily(model) else "gemini"
            }
            is Map<*, *> -> {
                val model = (options["model"] as? String) ?: ""
                val fam = options["family"]
                family = if (M2Json.truthy(fam)) fam.toString() else if (model.isNotEmpty()) QuotaFetcher.getModelFamily(model) else "gemini"
            }
        }

        val healthy = usable.filter { !isCooling(it) }

        // 全员冷却：选剩余冷却最短的
        if (healthy.isEmpty()) {
            val chosen = usable.reduce { minE, e -> if (cooldownRemainSec(e) < cooldownRemainSec(minE)) e else minE }
            touch(chosen); activeEmail = chosen
            return mgrs[chosen]
        }

        // 配额保护：已知额度 <= 2% 的跳过
        val unprotected = healthy.filter { !isFamilyProtected(it, family) }

        // 全部被保护：仍选额度最高的（相同则最久未用）
        if (unprotected.isEmpty()) {
            val chosen = jsSort(healthy) { a, b ->
                val qA = getQuota(a, family) ?: -1.0
                val qB = getQuota(b, family) ?: -1.0
                if (qB != qA) qB - qA else (lu(a) - lu(b)).toDouble()
            }[0]
            touch(chosen); activeEmail = chosen
            return mgrs[chosen]
        }

        // 有 >=5% 或未知额度的号时，<5% 的号排后
        fun filterLowQuota(emails: List<String>): List<String> {
            val nonLow = emails.filter { val q = getQuota(it, family); q == null || q >= 0.05 }
            return if (nonLow.isNotEmpty()) nonLow else emails
        }

        var chosen = ""
        when (schedulingMode) {
            "fixed" -> {
                val target = (fixedEmail.ifEmpty { selectedEmail }).trim()
                chosen = if (target.isNotEmpty() && unprotected.contains(target)) target
                    else pickBalanced(filterLowQuota(unprotected), family)
            }
            "cache_first" -> {
                val sel = selectedEmail
                if (sel.isNotEmpty() && unprotected.contains(sel)) {
                    chosen = sel
                } else if (!sessionKey.isNullOrEmpty()) {
                    val bound = synchronized(this) { sessionAffinity[sessionKey] }
                    val now = System.currentTimeMillis()
                    if (bound != null && bound.expireAt > now && unprotected.contains(bound.email)) {
                        bound.expireAt = now + AG_SESSION_TTL_MS
                        chosen = bound.email
                    }
                }
                if (chosen.isEmpty()) {
                    val c = filterLowQuota(unprotected)
                    chosen = c.reduce { minE, e -> if (lu(e) < lu(minE)) e else minE }
                }
            }
            "balance" -> chosen = pickBalanced(filterLowQuota(unprotected), family)
            "performance" -> chosen = pickPerformance(filterLowQuota(unprotected))
        }

        if (chosen.isNotEmpty()) {
            touch(chosen)
            if (!sessionKey.isNullOrEmpty() && schedulingMode == "cache_first") bindSession(sessionKey, chosen)
            activeEmail = chosen
            return mgrs[chosen]
        }
        return null
    }

    fun getActiveManager(): TokenManager? {
        val mgrs = managers
        if (mgrs.isEmpty()) return null
        val sel = selectedEmail
        if (sel.isNotEmpty()) mgrs[sel]?.let { return it }
        val act = activeEmail
        if (act.isNotEmpty()) mgrs[act]?.let { return it }
        val first = mgrs.values.first()
        activeEmail = first.tokenData.email
        return first
    }

    fun getManager(email: String?): TokenManager? {
        if (email.isNullOrEmpty()) return getActiveManager()
        val clean = email.trim()
        val mgrs = managers
        mgrs[clean]?.let { return it }
        for ((k, v) in mgrs) if (k.equals(clean, ignoreCase = true)) return v   // 容差大小写
        return null
    }

    fun rotateToNext(): TokenManager? {
        val emails = managers.keys.toList()
        if (emails.size <= 1) return null
        val idx = emails.indexOf(activeEmail)
        activeEmail = emails[(idx + 1) % emails.size]
        M2Log.i("[AccountPool] 触发账号池轮换 ➔ 已切换至: $activeEmail")
        return getActiveManager()
    }

    fun poolStatus(): JSONArray {
        val arr = JSONArray()
        for ((email, tm) in managers) {
            val v = validationInfo(email)
            val perf = getPerfStats(email)
            val o = JSONObject()
                .put("email", email)
                .put("cooling", isCooling(email))
                .put("cooldown_sec", cooldownRemainSec(email))
                .put("last_used", lu(email))
                .put("isActive", email == selectedEmail.ifEmpty { activeEmail })
                .put("validation_blocked", v.optBoolean("blocked"))
                .put("validation_url", v.optString("url"))
                .put("validation_reason", v.optString("reason"))
                .put("success_rate", perf.opt("success_rate"))
                .put("avg_latency_ms", perf.opt("avg_latency_ms"))
                .put("fail_streak", perf.opt("fail_streak"))
                .put("protected_families", JSONArray(getProtectedFamilies(email)))
            val st = tm.getStatus()
            for (k in st.keys()) o.put(k, st.opt(k))
            arr.put(o)
        }
        return arr
    }

    fun getAllStatus(): JSONArray = poolStatus()

    companion object {
        const val AG_DEFAULT_COOLDOWN_MS = 10000L
        const val AG_SESSION_TTL_MS = 30 * 60 * 1000L   // 30 分钟会话亲和期
        const val MAX_AFFINITY_ENTRIES = 1000           // 最多 1000 个活跃会话

        private val VALID_MODES = setOf("cache_first", "balance", "performance", "fixed")
        private val RAW_KEYS = arrayOf("gemini_5h", "gemini_7d", "claude_5h", "claude_7d", "argon_5h", "argon_7d")

        /** [{id, label, desc}] */
        @JvmStatic
        val SCHEDULING_MODES: List<Map<String, String>> = listOf(
            mapOf("id" to "cache_first", "label" to "缓存优先", "desc" to "会话粘滞优先，最大限度复用 Prompt 缓存"),
            mapOf("id" to "balance", "label" to "均衡轮询", "desc" to "不粘性，综合配额与最近使用均衡调度"),
            mapOf("id" to "performance", "label" to "性能优先", "desc" to "不粘性，优先最近成功率高、延迟低的账号"),
            mapOf("id" to "fixed", "label" to "固定账号", "desc" to "固定使用指定账号，遇冷或失败时自动切换"),
        )

        @JvmStatic
        fun schedulingModesJson(): JSONArray {
            val a = JSONArray()
            for (m in SCHEDULING_MODES) a.put(JSONObject().put("id", m["id"]).put("label", m["label"]).put("desc", m["desc"]))
            return a
        }

        /**
         * 等价 V8 小数组 Array.prototype.sort（二分插入排序，稳定）。
         * Node 版的比较器带阈值、不满足传递性，Java 的 TimSort 可能直接抛异常，所以不用 sortedWith。
         */
        internal fun <T> jsSort(list: List<T>, cmp: (T, T) -> Double): List<T> {
            val a = ArrayList(list)
            for (i in 1 until a.size) {
                val pivot = a[i]
                var left = 0
                var right = i
                while (left < right) {
                    val mid = left + ((right - left) shr 1)
                    val order = cmp(pivot, a[mid])
                    if (order < 0) right = mid else left = mid + 1
                }
                var p = i
                while (p > left) { a[p] = a[p - 1]; p-- }
                a[left] = pivot
            }
            return a
        }
    }
}

/** 与 mjs 导出名一致的顶层常量 */
const val AG_DEFAULT_COOLDOWN_MS: Long = AccountPool.AG_DEFAULT_COOLDOWN_MS
const val AG_SESSION_TTL_MS: Long = AccountPool.AG_SESSION_TTL_MS
const val MAX_AFFINITY_ENTRIES: Int = AccountPool.MAX_AFFINITY_ENTRIES
val SCHEDULING_MODES: List<Map<String, String>> get() = AccountPool.SCHEDULING_MODES
