package com.wag2api.ag

import okhttp3.Headers
import okhttp3.Response
import org.json.JSONArray
import org.json.JSONObject
import java.io.InterruptedIOException
import java.util.UUID
import java.util.concurrent.ConcurrentHashMap

/**
 * PR1：上游失败处理策略（移植自 src/upstream-policy.mjs；降级可见 + 少降级 + 重试收敛）
 *
 * 顺序（降级是最后手段）：
 *  1. 400 类：不换号、不降级，直接返回（上下文超长仍走 bumpSessionOnOverflow 换一代 sessionId 重试一次）。
 *  2. 429 / RESOURCE_EXHAUSTED：retryDelay ≤ 5s 时等待后原账号重试 1 次；否则给「账号 + 上游模型」记冷却，同模型换下一个未冷却的账号。429 不换 host。
 *  3. 5xx / 网络错误 / 响应头超时：同模型换 host 重试 1 次，再换账号重试 1 次。
 *  4. 以上都失败才降级；降级链每个模型只试 1 次。allowDowngrade=false 时直接返回真实错误。
 *  5. 缓存亲和：优先用当前活跃账号；只有它在冷却或本次失败时才换号。降级不粘住。
 *
 * 本模块不做网络请求，send / buildPayload 等由调用方注入（同步阻塞，在请求线程里跑）。
 */
object UpstreamPolicy {
    const val SAME_ACCOUNT_RETRY_MAX_MS = 5000L
    const val DEFAULT_COOLDOWN_MS = 60000L
    const val MAX_QUOTA_COOLDOWN_MS = 5 * 60 * 60 * 1000L // 5 小时上限

    private fun textOf(body: Any?): String = when {
        body is String -> body
        JsCompat.truthy(body) -> JsCompat.stringify(body) ?: ""
        else -> ""
    }

    // ---------- 错误分类 ----------

    private val VALIDATION_RE = Regex("Verify your account|further action is required|validation_url|appeal_url|VALIDATION_REQUIRED", RegexOption.IGNORE_CASE)

    /** 判断是否为人工验证封禁 */
    @JvmStatic
    fun isValidationRequired(body: Any?): Boolean {
        val text = textOf(body)
        if (text.isEmpty()) return false
        return VALIDATION_RE.containsMatchIn(text)
    }

    private fun unescapeUrl(u: Any?): String {
        if (u !is String || u.isEmpty()) return ""
        return u.replace("\\u0026", "&").replace("&amp;", "&")
    }

    private val HTTPS_RE = Regex("https://[^\\s\"'\\\\<>{}]*")

    /** 提取人工验证 URL（优先 details metadata validation_url/appeal_url，其次 links[0].url，最后正则匹配 https URL） */
    @JvmStatic
    fun extractValidationUrl(body: Any?): String {
        if (!JsCompat.truthy(body)) return ""
        var parsed: Any? = null
        val rawText = if (body is String) body else (JsCompat.stringify(body) ?: "")
        if (body is JSONObject || body is JSONArray) parsed = body
        else try { parsed = JsCompat.parse(body as? String ?: "") } catch (e: Exception) {}

        val po = parsed as? JSONObject
        if (po != null) {
            val details = po.optJSONObject("error")?.opt("details").let { if (JsCompat.truthy(it)) it else po.opt("details") }
            if (details is JSONArray) {
                for (i in 0 until details.length()) {
                    val d = details.optJSONObject(i) ?: continue
                    val md = d.optJSONObject("metadata")
                    val u = JsCompat.or(md?.opt("validation_url"), md?.opt("appeal_url"), d.opt("validation_url"), d.opt("appeal_url"), null)
                    if (JsCompat.truthy(u)) return unescapeUrl(u)
                }
                for (i in 0 until details.length()) {
                    val d = details.optJSONObject(i) ?: continue
                    val links = d.opt("links")
                    if (links is JSONArray) {
                        val url = links.optJSONObject(0)?.opt("url")
                        if (JsCompat.truthy(url)) return unescapeUrl(url)
                    }
                }
            }
            val links = po.opt("links")
            if (links is JSONArray) {
                val url = links.optJSONObject(0)?.opt("url")
                if (JsCompat.truthy(url)) return unescapeUrl(url)
            }
        }
        val text = rawText.replace("\\u0026", "&")
        val m = HTTPS_RE.find(text)
        if (m != null) return unescapeUrl(m.value)
        return ""
    }

    private val TIMEOUT_MSG_RE = Regex("header timeout|aborted|timed? ?out", RegexOption.IGNORE_CASE)
    private val QUOTA_RE = Regex("RESOURCE_EXHAUSTED")
    private val QUOTA_AUTH_RE = Regex("RESOURCE_EXHAUSTED|quota", RegexOption.IGNORE_CASE)

    /** 返回 "bad_request" | "quota" | "auth" | "validation" | "server" | "network" | "timeout" */
    @JvmStatic
    @JvmOverloads
    fun classifyFailure(status: Int = 0, body: Any? = "", error: Throwable? = null): String {
        if (error != null) {
            val msg = error.message ?: error.toString()
            if (error is UpstreamFetch.AbortError || error is UpstreamFetch.TimeoutError || error is InterruptedIOException ||
                TIMEOUT_MSG_RE.containsMatchIn(msg)) return "timeout"
            return "network"
        }
        val text = if (JsCompat.truthy(body)) JsCompat.str(body) else ""
        if (isValidationRequired(text)) return "validation"
        if (status == 429 || QUOTA_RE.containsMatchIn(text)) return "quota"
        if (status == 401 || status == 403) return if (QUOTA_AUTH_RE.containsMatchIn(text)) "quota" else "auth"
        if (status >= 500) return "server"
        if (status == 408) return "timeout"
        return "bad_request"
    }

    private fun headerGet(headers: Any?, name: String): String? = when (headers) {
        null -> null
        is Headers -> headers[name]
        is Map<*, *> -> (headers[name] ?: headers.entries.firstOrNull { (it.key as? String)?.equals(name, true) == true }?.value)?.toString()
        is JSONObject -> headers.opt(name)?.let { JsCompat.str(it) }
        else -> null
    }

    private val RA_SEC = Regex("^([\\d.]+)\\s*s?$", RegexOption.IGNORE_CASE)
    private val RETRY_DELAY_Q = Regex("\"retryDelay\"\\s*:\\s*\"([\\d.]+)s?\"", RegexOption.IGNORE_CASE)
    private val RETRY_DELAY_N = Regex("\"retryDelay\"\\s*:\\s*([\\d.]+)", RegexOption.IGNORE_CASE)

    /** 从 RetryInfo.retryDelay（"35s" / "3.5s"）或 Retry-After 头取等待毫秒数；取不到返回 null。headers：okhttp Headers / Map / JSONObject */
    @JvmStatic
    @JvmOverloads
    fun parseRetryDelayMs(body: Any? = "", headers: Any? = null): Long? {
        val ra = headerGet(headers, "retry-after")
        if (ra != null && ra != "") {
            val s = JsCompat.number(ra)
            if (!s.isNaN() && !s.isInfinite()) return Math.max(0L, JsCompat.round(s * 1000))
            val mh = RA_SEC.find(JsCompat.trim(ra))
            if (mh != null) return Math.max(0L, JsCompat.round(JsCompat.parseFloat(mh.groupValues[1]) * 1000))
            val t = JsCompat.dateParse(ra)
            if (t != null) return Math.max(0L, t - System.currentTimeMillis())
        }
        val text = textOf(body)
        val m = RETRY_DELAY_Q.find(text) ?: RETRY_DELAY_N.find(text)
        if (m != null) {
            val v = JsCompat.parseFloat(m.groupValues[1])
            if (v.isNaN()) return null // Math.round(NaN) 在 JS 里是 NaN，这里按取不到处理
            return JsCompat.round(v * 1000)
        }
        return null
    }

    private val EXHAUSTED_RE = Regex("RESOURCE_EXHAUSTED|QUOTA_EXHAUSTED|quota exceeded|quota limit hit|out of quota|quota.*exhausted", RegexOption.IGNORE_CASE)
    private val RESET_DELAY_Q = Regex("\"quotaResetDelay\"\\s*:\\s*\"([\\d.]+)\\s*(s|sec|m|min|h|hours?)?\"", RegexOption.IGNORE_CASE)
    private val RESET_DELAY_N = Regex("\"quotaResetDelay\"\\s*:\\s*([\\d.]+)", RegexOption.IGNORE_CASE)
    private val RESET_TIME = Regex("\"(?:quotaResetTime|resetTime|reset_time)\"\\s*:\\s*\"([^\"]+)\"", RegexOption.IGNORE_CASE)
    private val TEXT_SEC = Regex("quota will reset in (\\d+)\\s*sec", RegexOption.IGNORE_CASE)
    private val TEXT_IN = Regex("resets? in ([\\d.]+)\\s*(s|sec|seconds?|m|min|minutes?|h|hours?)\\b", RegexOption.IGNORE_CASE)

    private fun unitMs(v: Double, unit: String): Long = when {
        unit.startsWith("h") -> JsCompat.round(v * 3600 * 1000)
        unit.startsWith("m") -> JsCompat.round(v * 60 * 1000)
        else -> JsCompat.round(v * 1000)
    }

    /**
     * 解析 429 冷却时长：
     * 1. body/headers 带 retry-after 或 retryDelay 时按它冷却；
     * 2. 带 quota 重置时间时冷却到重置时间（上限 5 小时）；
     * 3. 否则默认冷却 DEFAULT_COOLDOWN_MS。
     */
    @JvmStatic
    @JvmOverloads
    fun calculateCooldownMs(body: Any? = "", headers: Any? = null, now: () -> Long = { System.currentTimeMillis() }): Long {
        val currentNow = now()
        val delay = parseRetryDelayMs(body, headers)
        if (delay != null) return Math.max(1000L, delay)

        val text = textOf(body)
        val isQuotaExhausted = EXHAUSTED_RE.containsMatchIn(text)
        var resetMs: Long? = null

        val mrd = RESET_DELAY_Q.find(text) ?: RESET_DELAY_N.find(text)
        if (mrd != null) {
            val v = JsCompat.parseFloat(mrd.groupValues[1])
            val unit = (mrd.groupValues.getOrNull(2)?.takeIf { it.isNotEmpty() } ?: "s").lowercase()
            if (!v.isNaN()) resetMs = unitMs(v, unit)
        }
        if (resetMs == null) {
            val mrt = RESET_TIME.find(text)
            if (mrt != null) {
                val parsed = JsCompat.dateParse(mrt.groupValues[1])
                if (parsed != null && parsed > currentNow) resetMs = parsed - currentNow
            }
        }
        if (resetMs == null) {
            val ms = TEXT_SEC.find(text)
            if (ms != null) {
                resetMs = ms.groupValues[1].toLongOrNull()?.times(1000)
            } else {
                val mi = TEXT_IN.find(text)
                if (mi != null) {
                    val v = JsCompat.parseFloat(mi.groupValues[1])
                    if (!v.isNaN()) resetMs = unitMs(v, mi.groupValues[2].lowercase())
                }
            }
        }
        if (resetMs != null && (isQuotaExhausted || resetMs > 0)) {
            return Math.min(Math.max(1000L, resetMs), MAX_QUOTA_COOLDOWN_MS)
        }
        return DEFAULT_COOLDOWN_MS
    }

    // ---------- 冷却表（账号 + 上游模型） ----------

    class Cooldowns @JvmOverloads constructor(private val now: () -> Long = { System.currentTimeMillis() }) {
        private val map = ConcurrentHashMap<String, Long>()
        fun key(email: String?, model: String?) = "${email ?: ""}\u0000${model ?: ""}"

        @Synchronized
        fun set(email: String?, model: String?, ms: Long?) {
            val v = if (ms == null || ms == 0L) DEFAULT_COOLDOWN_MS else ms
            val until = now() + Math.max(1000L, v)
            val k = key(email, model)
            if ((map[k] ?: 0L) < until) map[k] = until
        }

        fun isCooling(email: String?, model: String?): Boolean {
            val k = key(email, model)
            val until = map[k] ?: return false
            if (until == 0L) return false
            if (until <= now()) { map.remove(k, until); return false }
            return true
        }

        fun remainingMs(email: String?, model: String?): Long = Math.max(0L, (map[key(email, model)] ?: 0L) - now())

        fun clearAccount(email: String?) {
            val clean = (email ?: "").trim()
            val prefix = "$clean\u0000"
            map.keys.removeIf { it.startsWith(prefix) }
        }

        fun clear() = map.clear()

        fun list(): JSONArray {
            val out = JSONArray()
            val n = now()
            for ((k, until) in map) {
                val i = k.indexOf('\u0000')
                val email = if (i >= 0) k.substring(0, i) else k
                val model = if (i >= 0) k.substring(i + 1).substringBefore('\u0000') else ""
                val ms = until - n
                if (ms > 0) out.put(JSONObject().put("email", email).put("model", model).put("remaining_ms", ms))
            }
            return out
        }
    }

    // 降级提示行在 DowngradeNotice（ContentConverter 也要用）；这里转出同名入口，对应 mjs 的 re-export
    const val DOWNGRADE_NOTICE_PREFIX = DowngradeNotice.DOWNGRADE_NOTICE_PREFIX
    @JvmField val DOWNGRADE_REASON_LABELS: Map<String, String> = DowngradeNotice.DOWNGRADE_REASON_LABELS
    @JvmStatic fun buildDowngradeNotice(requested: String?, used: String?, reason: String?) = DowngradeNotice.buildDowngradeNotice(requested, used, reason)
    @JvmStatic fun stripDowngradeNotice(text: String?) = DowngradeNotice.stripDowngradeNotice(text)
    @JvmStatic fun shouldInsertNotice(anthropicReq: JSONObject?) = DowngradeNotice.shouldInsertNotice(anthropicReq)

    // ---------- payload 改写（不重建） ----------

    /** 换号重试：复用已转换的 payload，只替换 sessionId / project / requestId。 */
    @JvmStatic
    fun swapAccountInPayload(payload: JSONObject, anthropicReq: JSONObject, email: String?, projectId: String?): JSONObject {
        anthropicReq.put("_gwEmail", email ?: JSONObject.NULL)
        payload.put("requestId", "agent-" + UUID.randomUUID().toString())
        payload.optJSONObject("request")?.put("sessionId", SessionRouter.resolveSessionId(anthropicReq, email ?: ""))
        if (!projectId.isNullOrEmpty() && projectId != "pending_detection") payload.put("project", projectId)
        else payload.remove("project")
        return payload
    }

    /** 降级 payload：历史里的 thoughtSignature 属于主模型，换成通用签名。只用于降级请求。 */
    @JvmStatic
    fun stripSignaturesForDowngrade(payload: JSONObject?): JSONObject? {
        val contents = payload?.optJSONObject("request")?.optJSONArray("contents") ?: return payload
        val fallback: Any = SignatureCache.FALLBACK_THOUGHT_SIGNATURE
        for (i in 0 until contents.length()) {
            val parts = contents.optJSONObject(i)?.optJSONArray("parts") ?: continue
            for (j in 0 until parts.length()) {
                val p = parts.optJSONObject(j) ?: continue
                if (JsCompat.truthy(p.opt("thoughtSignature"))) p.put("thoughtSignature", fallback)
            }
        }
        return payload
    }

    // ---------- 主流程 ----------

    class PolicyError(@JvmField val kind: String, @JvmField val status: Int, @JvmField val body: String)

    class PolicyResult<M>(
        @JvmField val ok: Boolean,
        @JvmField val response: Response?,
        @JvmField val mgr: M?,
        @JvmField val modelUsed: String,
        @JvmField val downgraded: Boolean,
        @JvmField val reason: String?,
        @JvmField val switchedAccount: Boolean,
        @JvmField val attempts: Int,
        @JvmField val error: PolicyError?,
    )

    /**
     * 对应 runWithPolicy 的 ctx。M 是账号对象（TokenManager），emailOf / projectOf 取 mgr.tokenData.email / projectId。
     * send 返回 okhttp Response（成功时调用方负责读完/关闭；失败时本模块读错误体并关闭）；网络错误/超时抛异常。
     */
    class Ctx<M>(
        @JvmField val model: String,
        @JvmField val upstreamOf: (String) -> String,
        @JvmField val accounts: () -> List<M>,
        @JvmField val emailOf: (M) -> String?,
        @JvmField val projectOf: (M) -> String?,
        @JvmField val cooldowns: Cooldowns,
        @JvmField val buildPayload: (String, M) -> JSONObject,
        @JvmField val send: (JSONObject, M, String, Long) -> Response?,
        @JvmField val hosts: List<String>,
    ) {
        @JvmField var anthropicReq: JSONObject? = null
        @JvmField var activeEmail: String? = null
        @JvmField var quotaOf: ((String, String) -> Double?)? = null
        @JvmField var prepare: ((M) -> Boolean)? = null
        @JvmField var onBadRequest: ((String, M) -> Boolean)? = null
        @JvmField var onValidationRequired: ((M, String) -> Unit)? = null
        @JvmField var isBlocked: ((String) -> Boolean)? = null
        @JvmField var recordPerf: ((String, Boolean, Long) -> Unit)? = null
        @JvmField var onCooldown: ((String, Long, String) -> Unit)? = null
        @JvmField var chain: List<String> = emptyList()
        @JvmField var allowDowngrade: Boolean = true
        @JvmField var headerTimeoutMs: Long = 60000
        @JvmField var deadlineMs: Long = 45000
        @JvmField var minAttemptTimeoutMs: Long = 5000
        @JvmField var startedAt: Long? = null
        @JvmField var now: () -> Long = { System.currentTimeMillis() }
        @JvmField var sleep: (Long) -> Unit = { ms -> if (ms > 0) Thread.sleep(ms) }
        @JvmField var log: (String) -> Unit = {}
    }

    private class Attempt(val ok: Boolean, val response: Response?, val status: Int, val body: String, val headers: Headers?, val kind: String)

    @JvmStatic
    fun <M> runWithPolicy(ctx: Ctx<M>): PolicyResult<M> {
        val now = ctx.now
        val log = ctx.log
        val startedAt = ctx.startedAt ?: now()
        val hosts = ctx.hosts
        val deadlineMs = ctx.deadlineMs
        val headerTimeoutMs = ctx.headerTimeoutMs
        val allowDowngrade = ctx.allowDowngrade
        val upMain = ctx.upstreamOf(ctx.model)

        var attempts = 0
        var lastError: PolicyError? = null
        var switchedAccount = false
        val kinds = LinkedHashSet<String>()

        fun pastDeadline() = attempts > 0 && now() - startedAt >= deadlineMs
        fun emailOf(m: M): String = ctx.emailOf(m) ?: ""

        val family: String = QuotaFetcher.getModelFamily(ctx.model).toString()

        fun order(upModel: String, exclude: Set<String>): List<M> {
            val all = ctx.accounts().filter { m ->
                val email = ctx.emailOf(m)
                if (email.isNullOrEmpty()) false
                else if (exclude.contains(email)) false
                else !(ctx.isBlocked?.invoke(email) ?: false)
            }
            val free = all.filter { !ctx.cooldowns.isCooling(emailOf(it), upModel) }
            val active = free.firstOrNull { emailOf(it) == ctx.activeEmail }

            fun getQuota(m: M): Double? = ctx.quotaOf?.invoke(emailOf(m), family)?.takeIf { !it.isNaN() }
            fun isProtected(m: M): Boolean { val q = getQuota(m); return q != null && q <= 0.02 }
            fun isLow(m: M): Boolean { val q = getQuota(m); return q != null && q < 0.05 }
            fun qScore(m: M): Double = getQuota(m) ?: 0.5 // 未知当作中性 0.5

            // 配额保护：已知额度 <= 2% 的号直接跳过；若所有号都被保护，则仍按额度排序全部
            val nonProtected = free.filter { !isProtected(it) }
            val candidateFree = if (nonProtected.isNotEmpty()) nonProtected else free
            val hasNonLow = candidateFree.any { !isLow(it) }

            val cmp = Comparator<Pair<M, Int>> { a, b ->
                if (hasNonLow) {
                    val la = if (isLow(a.first)) 1 else 0
                    val lb = if (isLow(b.first)) 1 else 0
                    if (la != lb) return@Comparator la - lb
                }
                val d = qScore(b.first) - qScore(a.first)
                if (d != 0.0) (if (d > 0) 1 else -1) else a.second - b.second
            }

            // active 号额度 <5% 且号池中有其他正常号时，不优先占首位
            if (active != null && candidateFree.contains(active) && (!hasNonLow || !isLow(active))) {
                val rest = candidateFree.filter { it !== active }.mapIndexed { i, m -> Pair(m, i) }.sortedWith(cmp).map { it.first }
                return listOf(active) + rest
            }
            return candidateFree.mapIndexed { i, m -> Pair(m, i) }.sortedWith(cmp).map { it.first }
        }

        fun attempt(payload: JSONObject, mgr: M, host: String): Attempt {
            val timeoutMs = headerTimeoutMs
            attempts++
            val attemptStart = now()
            try {
                val r = ctx.send(payload, mgr, host, timeoutMs)
                val latencyMs = now() - attemptStart
                try { ctx.recordPerf?.invoke(emailOf(mgr), r != null && r.isSuccessful, latencyMs) } catch (e: Exception) {}
                if (r != null && r.isSuccessful) return Attempt(true, r, r.code, "", r.headers, "")
                val headers = r?.headers
                val status = r?.code ?: 0
                val body = if (r != null) UpstreamFetch.textOf(r) else ""
                return Attempt(false, null, status, body, headers, classifyFailure(status, body, null))
            } catch (error: Exception) {
                if (error is InterruptedException) Thread.currentThread().interrupt()
                val latencyMs = now() - attemptStart
                try { ctx.recordPerf?.invoke(emailOf(mgr), false, latencyMs) } catch (e: Exception) {}
                return Attempt(false, null, 0, error.message ?: error.toString(), null, classifyFailure(0, "", error))
            }
        }

        fun success(response: Response?, mgr: M, modelUsed: String, reason: String?) = PolicyResult(
            true, response, mgr, modelUsed, modelUsed != ctx.model, if (modelUsed != ctx.model) reason else null,
            switchedAccount, attempts, null,
        )

        // ---------- 主模型 ----------
        val tried = HashSet<String>()
        val authFailed = HashSet<String>() // 凭据失效的账号：降级也不用它
        var mgr: M? = order(upMain, tried).firstOrNull()
        val allCoolingAtStart = mgr == null
        var payload: JSONObject? = null
        var sameAccountRetried = false
        var hostSwitched = false
        var serverAccountSwitched = false
        var badRequestRetried = false
        var host = hosts[0]

        fun nextAccount() {
            tried.add(emailOf(mgr!!))
            val n = order(upMain, tried).firstOrNull()
            if (n != null) switchedAccount = true
            mgr = n
            sameAccountRetried = false
            host = hosts[0]
        }

        while (mgr != null && !pastDeadline()) {
            val cur = mgr!!
            val prep = ctx.prepare
            if (prep != null && !prep(cur)) {
                lastError = PolicyError("auth", 401, "账号 ${emailOf(cur)} 凭据失效")
                kinds.add("auth")
                authFailed.add(emailOf(cur))
                nextAccount()
                continue
            }
            payload = if (payload != null) swapAccountInPayload(payload, ctx.anthropicReq ?: JSONObject(), emailOf(cur), ctx.projectOf(cur))
            else ctx.buildPayload(ctx.model, cur)
            val r = attempt(payload, cur, host)
            if (r.ok) return success(r.response, cur, ctx.model, null)
            lastError = PolicyError(r.kind, r.status, r.body)
            kinds.add(r.kind)

            if (r.kind == "bad_request") {
                val obr = ctx.onBadRequest
                if (!badRequestRetried && obr != null && obr(r.body, cur)) {
                    badRequestRetried = true
                    payload = ctx.buildPayload(ctx.model, cur)
                    continue
                }
                return PolicyResult(false, null, cur, ctx.model, false, null, switchedAccount, attempts, lastError)
            }
            if (r.kind == "quota") {
                val explicitDelay = parseRetryDelayMs(r.body, r.headers)
                if (explicitDelay != null && explicitDelay <= SAME_ACCOUNT_RETRY_MAX_MS && !sameAccountRetried) {
                    sameAccountRetried = true
                    log("[Policy] ${emailOf(cur)} 429，${explicitDelay}ms 后原账号重试")
                    try { ctx.sleep(explicitDelay) } catch (e: InterruptedException) { Thread.currentThread().interrupt() }
                    continue
                }
                val delay = calculateCooldownMs(r.body, r.headers, now)
                ctx.cooldowns.set(emailOf(cur), upMain, delay)
                try { ctx.onCooldown?.invoke(emailOf(cur), delay, upMain) } catch (e: Exception) {}
                log("[Policy] ${emailOf(cur)} × $upMain 冷却 ${JsCompat.round(delay / 1000.0)}s，换号")
                nextAccount()
                continue
            }
            if (r.kind == "validation") {
                authFailed.add(emailOf(cur))
                try { ctx.onValidationRequired?.invoke(cur, r.body) } catch (e: Exception) {}
                log("[Policy] ${emailOf(cur)} 触发人工验证封禁，换号")
                nextAccount()
                continue
            }
            if (r.kind == "auth") { authFailed.add(emailOf(cur)); nextAccount(); continue }
            // server / network / timeout：换 host 一次，再换账号一次
            if (!hostSwitched && hosts.size > 1) {
                hostSwitched = true
                host = hosts[1]
                log("[Policy] ${r.kind}(${r.status})，换 host 重试")
                continue
            }
            if (!serverAccountSwitched) {
                serverAccountSwitched = true
                log("[Policy] ${r.kind}(${r.status})，换账号重试")
                nextAccount()
                continue
            }
            break
        }

        // ---------- 降级 ----------
        val reason = if (allCoolingAtStart || (kinds.contains("quota") && order(upMain, emptySet()).isEmpty())) "quota_all_accounts"
        else if (kinds.contains("timeout")) "timeout"
        else if (kinds.contains("server")) "upstream_5xx"
        else if (kinds.contains("network")) "network"
        else if (kinds.contains("quota")) "quota"
        else if (kinds.contains("validation")) "validation"
        else if (kinds.contains("auth")) "auth" else "unknown"
        if (allCoolingAtStart && lastError == null) lastError = PolicyError("quota", 429, "所有账号对该模型都在冷却中")

        // 只是凭据或验证问题时换模型没用，不降级
        val onlyAuthOrValidation = kinds.isNotEmpty() && kinds.all { it == "auth" || it == "validation" }
        if (allowDowngrade && !onlyAuthOrValidation && !pastDeadline()) {
            for (dm in ctx.chain) {
                if (pastDeadline()) break
                val up = ctx.upstreamOf(dm)
                val m = order(up, authFailed).firstOrNull() ?: continue
                val prep = ctx.prepare
                if (prep != null && !prep(m)) continue
                val p = stripSignaturesForDowngrade(ctx.buildPayload(dm, m))!!
                val r = attempt(p, m, hosts[0])
                if (r.ok) {
                    if (emailOf(m) != ctx.activeEmail) switchedAccount = true
                    return success(r.response, m, dm, reason)
                }
                if (r.kind == "quota") {
                    val delay = calculateCooldownMs(r.body, r.headers, now)
                    ctx.cooldowns.set(emailOf(m), up, delay)
                    try { ctx.onCooldown?.invoke(emailOf(m), delay, up) } catch (e: Exception) {}
                }
                log("[Policy] 降级模型 $dm 失败：${r.kind}(${r.status})")
            }
        }

        return PolicyResult(false, null, mgr, ctx.model, false, reason, switchedAccount, attempts,
            lastError ?: PolicyError("unknown", 502, "Google 集群无响应"))
    }
}
