package com.wag2api.ag

import okhttp3.MediaType.Companion.toMediaType
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.text.DateFormat
import java.util.Calendar
import java.util.Date
import java.util.Locale
import java.util.TimeZone
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.ScheduledFuture
import java.util.concurrent.ScheduledThreadPoolExecutor
import java.util.concurrent.ThreadFactory
import java.util.concurrent.TimeUnit

/**
 * 移植自 src/quota-fetcher.mjs：Google Antigravity 实时配额拉取与解析。
 *
 * 核心原则：宁可显示 '--'，也绝不伪造 100%。
 * 内部配额记录用 JSONObject：{fraction, reset, source, observed_at?, inferred?}；
 * 对外（toPublic / buildBuckets / fetchRealQuota）字段与 Node 版一致。
 * quota_observed.json 存盘格式与 Node 版相同：{ email: { bucketKey: {fraction, reset, observed_at} } }。
 */
object QuotaFetcher {

    private const val WEEKLY_THRESHOLD_HOURS = 6.0
    private const val TIER_CACHE_TTL_MS = 6L * 60 * 60 * 1000
    private const val UA = "antigravity/4.3.0 linux/arm64"
    private val JSON_TYPE = "application/json".toMediaType()

    // ------------------------------------------------------------------ 时间

    /** ISO 8601 → 毫秒；解析失败返回 null（对应 JS 的 NaN）。只带日期按 UTC，带时间不带时区按本地时间（与 JS Date 一致）。 */
    @JvmStatic
    fun parseIsoMs(s: String?): Long? {
        if (s.isNullOrBlank()) return null
        val m = ISO.matchEntire(s.trim()) ?: return null
        val g = m.groupValues
        val y = g[1].toInt(); val mo = g[2].toInt(); val d = g[3].toInt()
        if (mo !in 1..12 || d !in 1..31) return null
        val hasTime = g[4].isNotEmpty()
        val h = if (hasTime) g[4].toInt() else 0
        val mi = if (hasTime) g[5].toInt() else 0
        val sec = if (g[6].isNotEmpty()) g[6].toInt() else 0
        val ms = if (g[7].isNotEmpty()) (g[7] + "00").substring(0, 3).toInt() else 0
        if (h > 24 || mi > 59 || sec > 60) return null
        val zone = g[8]
        val tz: TimeZone = when {
            zone.isEmpty() -> if (hasTime) TimeZone.getDefault() else TimeZone.getTimeZone("UTC")
            zone == "Z" || zone == "z" -> TimeZone.getTimeZone("UTC")
            else -> {
                val z = zone.replace(":", "")
                TimeZone.getTimeZone("GMT" + z.substring(0, 3) + ":" + z.substring(3, 5))
            }
        }
        val cal = Calendar.getInstance(tz, Locale.ROOT)
        cal.clear()
        cal.set(y, mo - 1, d, h, mi, sec)
        cal.set(Calendar.MILLISECOND, ms)
        return cal.timeInMillis
    }

    private val ISO = Regex("^(\\d{4})-(\\d{2})-(\\d{2})(?:[Tt ](\\d{2}):(\\d{2})(?::(\\d{2})(?:\\.(\\d+))?)?)?\\s*(Z|z|[+-]\\d{2}:?\\d{2})?$")

    @JvmStatic
    fun parseResetTime(resetTimeStr: String?): String? {
        if (resetTimeStr.isNullOrEmpty()) return null
        val target = parseIsoMs(resetTimeStr) ?: return null
        val diff = target - System.currentTimeMillis()
        if (diff <= 0) return "已重置"
        val hours = diff / (1000L * 60 * 60)
        val mins = (diff % (1000L * 60 * 60)) / (1000L * 60)
        if (hours > 24) {
            val days = hours / 24
            return "${days}天${hours % 24}小时后"
        }
        return "${hours}小时${mins}分后"
    }

    @JvmStatic
    fun hoursUntil(resetTimeStr: String?): Double {
        if (resetTimeStr.isNullOrEmpty()) return -1.0
        val t = parseIsoMs(resetTimeStr) ?: return -1.0
        return (t - System.currentTimeMillis()) / 3600000.0
    }

    @JvmStatic
    fun formatHHMM(ts: Any?): String {
        val ms: Long = when (ts) {
            null -> return ""
            is Date -> ts.time
            is Number -> { if (ts.toDouble() == 0.0) return ""; ts.toLong() }
            is String -> { if (ts.isEmpty()) return ""; ts.toLongOrNull() ?: parseIsoMs(ts) ?: return "" }
            else -> return ""
        }
        val c = Calendar.getInstance()
        c.timeInMillis = ms
        return String.format(Locale.ROOT, "%02d:%02d", c.get(Calendar.HOUR_OF_DAY), c.get(Calendar.MINUTE))
    }

    private fun localeTime(): String = DateFormat.getTimeInstance(DateFormat.MEDIUM).format(Date())

    // ------------------------------------------------------------------ 观测记录（quota_observed.json）

    private class Obs(val fraction: Double, val reset: String?, val observedAt: Long)

    private val observedStore = ConcurrentHashMap<String, ConcurrentHashMap<String, Obs>>()
    @Volatile private var observedLoaded = false
    @Volatile private var isDirty = false
    private var saveTimer: ScheduledFuture<*>? = null
    private val saveLock = Any()

    /** 存盘防抖用的单线程定时器；空闲 10 秒后线程自动退出。 */
    private val saver: ScheduledThreadPoolExecutor by lazy {
        ScheduledThreadPoolExecutor(1, ThreadFactory { r -> Thread(r, "ag-quota-save").apply { isDaemon = true } }).apply {
            setKeepAliveTime(10, TimeUnit.SECONDS)
            allowCoreThreadTimeOut(true)
            removeOnCancelPolicy = true
        }
    }

    private fun observedFile(): File = File(AgPaths.dataDir.toString(), "quota_observed.json")

    private fun normEmail(email: String?): String = (email ?: "default").ifEmpty { "default" }.trim().lowercase(Locale.ROOT)

    @JvmStatic
    @Synchronized
    fun loadObservedQuotas() {
        if (observedLoaded) return
        observedLoaded = true
        try {
            val f = observedFile()
            if (!f.isFile) return
            val data = JSONObject(f.readText(Charsets.UTF_8))
            for (rawEmail in data.keys()) {
                val buckets = data.optJSONObject(rawEmail) ?: continue
                val email = rawEmail.trim().lowercase(Locale.ROOT)
                val map = observedStore.getOrPut(email) { ConcurrentHashMap() }
                for (bKey in buckets.keys()) {
                    val v = buckets.optJSONObject(bKey) ?: continue
                    val fr = v.opt("fraction")
                    if (fr !is Number) continue
                    val oa = v.opt("observed_at")
                    map[bKey] = Obs(fr.toDouble(), strOrNull(v.opt("reset")), if (oa is Number) oa.toLong() else System.currentTimeMillis())
                }
            }
        } catch (_: Throwable) {
            // 读容错
        }
    }

    @JvmStatic
    fun flushObservedQuotasSync() {
        synchronized(saveLock) {
            saveTimer?.cancel(false)
            saveTimer = null
            if (!isDirty) return
            try {
                val f = observedFile()
                f.parentFile?.mkdirs()
                val obj = JSONObject()
                for ((email, map) in observedStore) {
                    val eo = JSONObject()
                    for ((k, v) in map) {
                        eo.put(k, JSONObject().put("fraction", v.fraction).put("reset", v.reset ?: JSONObject.NULL).put("observed_at", v.observedAt))
                    }
                    obj.put(email, eo)
                }
                val tmp = File(f.parentFile, f.name + ".tmp")
                tmp.writeText(obj.toString(2), Charsets.UTF_8)
                if (!tmp.renameTo(f)) { f.delete(); tmp.renameTo(f) }
                isDirty = false
            } catch (_: Throwable) {
                // 写容错
            }
        }
    }

    private fun scheduleSaveObservedQuotas() {
        synchronized(saveLock) {
            isDirty = true
            if (saveTimer != null) return
            saveTimer = saver.schedule({
                synchronized(saveLock) { saveTimer = null }
                flushObservedQuotasSync()
            }, 1000, TimeUnit.MILLISECONDS)
        }
    }

    @JvmStatic
    fun setObservedQuota(email: String?, bucketKey: String, record: JSONObject) {
        loadObservedQuotas()
        val map = observedStore.getOrPut(normEmail(email)) { ConcurrentHashMap() }
        val oa = record.opt("observed_at")
        map[bucketKey] = Obs(numOr(record.opt("fraction"), 0.0), strOrNull(record.opt("reset")), if (oa is Number) oa.toLong() else System.currentTimeMillis())
        scheduleSaveObservedQuotas()
    }

    @JvmStatic
    fun getObservedQuotas(email: String?): JSONObject {
        loadObservedQuotas()
        val res = JSONObject()
        val map = observedStore[normEmail(email)] ?: return res
        for ((k, v) in map) res.put(k, obsJson(v))
        return res
    }

    @JvmStatic
    fun clearObservedQuotas() {
        observedStore.clear()
        observedLoaded = true
        isDirty = true
        flushObservedQuotasSync()
    }

    private fun obsJson(v: Obs) = JSONObject().put("fraction", v.fraction).put("reset", v.reset ?: JSONObject.NULL).put("observed_at", v.observedAt)

    private fun expired(reset: String?, now: Long): Boolean {
        if (reset.isNullOrEmpty()) return false
        val ms = parseIsoMs(reset) ?: return false
        return ms <= now
    }

    private fun fromObs(rec: Obs, now: Long): JSONObject =
        if (expired(rec.reset, now)) {
            JSONObject().put("fraction", 1).put("reset", JSONObject.NULL).put("source", "observed-reset")
                .put("inferred", true).put("observed_at", rec.observedAt)
        } else {
            JSONObject().put("fraction", rec.fraction).put("reset", rec.reset ?: JSONObject.NULL).put("source", "observed")
                .put("inferred", false).put("observed_at", rec.observedAt)
        }

    /**
     * 合并新旧观测记录：summary 里有的桶更新记录（取 observed_at 更新者）；
     * summary 缺失但有记录的桶：reset 在未来用记录值（observed），已过按满额（observed-reset）。
     */
    @JvmStatic
    @JvmOverloads
    fun applyObservedFallback(email: String?, summary: JSONObject? = JSONObject(), now: Long = System.currentTimeMillis()): JSONObject {
        loadObservedQuotas()
        val map = observedStore.getOrPut(normEmail(email)) { ConcurrentHashMap() }
        val effective = JSONObject()
        val sum = summary ?: JSONObject()
        for (bKey in sum.keys()) {
            val item = sum.optJSONObject(bKey) ?: continue
            if (item.opt("fraction") !is Number) continue
            val oaRaw = item.opt("observed_at")
            val itemObservedAt = if (oaRaw is Number) oaRaw.toLong() else now
            val existing = map[bKey]
            if (existing != null && existing.observedAt > itemObservedAt) {
                effective.put(bKey, fromObs(existing, now))
            } else {
                map[bKey] = Obs(numOr(item.opt("fraction"), 0.0), strOrNull(item.opt("reset")), itemObservedAt)
                scheduleSaveObservedQuotas()
                val e = JSONObject(item.toString())
                e.put("observed_at", itemObservedAt)
                e.put("source", strOrNull(item.opt("source")) ?: "summary")
                effective.put(bKey, e)
            }
        }
        for ((bKey, rec) in map) {
            if (effective.has(bKey)) continue
            effective.put(bKey, fromObs(rec, now))
        }
        return effective
    }

    // ------------------------------------------------------------------ 解析

    /** 从一个 quota 条目里抽取数值。支持三种形态，找不到返回 null。 */
    @JvmStatic
    fun extractFromEntry(entry: Any?): JSONObject? {
        if (entry !is JSONObject) return null
        val rf = entry.opt("remainingFraction")
        val reset = strOrNull(entry.opt("resetTime")) ?: strOrNull(entry.opt("reset_time"))
        if (rf is Number && rf.toDouble() >= 0) {
            return rec(rf.toDouble(), reset, "remainingFraction")
        }
        if (reset != null && isNullish(rf)) {
            return rec(0.0, reset, "remainingFraction")
        }
        val limit = firstNonNull(entry, "limit", "quotaLimit", "max")
        val usage = firstNonNull(entry, "usage", "consumed", "used")
        if (limit is Number && limit.toDouble() > 0) {
            val u = if (usage is Number) usage.toDouble() else 0.0
            return rec(Math.max(0.0, Math.min(1.0, 1 - u / limit.toDouble())), reset, "limit-usage")
        }
        val total = firstNonNull(entry, "total", "quotaTotal")
        val remaining = firstNonNull(entry, "remaining", "remainingQuota")
        if (total is Number && total.toDouble() > 0 && remaining is Number) {
            return rec(Math.max(0.0, Math.min(1.0, remaining.toDouble() / total.toDouble())), reset, "remaining-total")
        }
        return null
    }

    private fun rec(fraction: Double, reset: String?, source: String) =
        JSONObject().put("fraction", fraction).put("reset", reset ?: JSONObject.NULL).put("source", source)

    /** 判断一个 limit 条目属于周窗口还是短窗口。 */
    @JvmStatic
    fun isWeeklyEntry(entry: Any?): Boolean {
        val o = JSONObject()
        if (entry is JSONObject) {
            for (k in arrayOf("name", "type", "window", "period", "interval", "id")) {
                if (entry.has(k)) o.put(k, entry.opt(k))
            }
        }
        return Regex("weekly|week|7d|seven").containsMatchIn(o.toString().lowercase(Locale.ROOT))
    }

    /** 收集一个模型条目下所有真实配额：{family_5h, family_7d}（值为记录或 null）。 */
    @JvmStatic
    fun collectModelQuotas(model: JSONObject, family: String): JSONObject {
        val k5 = "${family}_5h"; val k7 = "${family}_7d"
        val out = JSONObject().put(k5, JSONObject.NULL).put(k7, JSONObject.NULL)
        fun consider(entry: Any?, forcedWeekly: Boolean?) {
            if (entry == null || entry == JSONObject.NULL) return
            val r = extractFromEntry(entry) ?: return
            var weekly = forcedWeekly ?: (if (entry is JSONObject) isWeeklyEntry(entry) else false)
            if (!weekly && hoursUntil(strOrNull(r.opt("reset"))) > WEEKLY_THRESHOLD_HOURS) weekly = true
            val key = "${family}_${if (weekly) "7d" else "5h"}"
            val cur = out.optJSONObject(key)
            if (cur == null || r.optDouble("fraction") < cur.optDouble("fraction")) out.put(key, r)
        }
        consider(model.opt("quotaInfo"), false)
        consider(model.opt("weeklyQuotaInfo"), true)
        for (arrName in arrayOf("limits", "rateLimits", "quota")) {
            val arr = model.opt(arrName)
            if (arr is JSONArray) for (i in 0 until arr.length()) consider(arr.opt(i), null)
        }
        return out
    }

    private val MERGED_KEYS = arrayOf("gemini_5h", "gemini_7d", "claude_5h", "claude_7d", "argon_5h", "argon_7d")

    private fun emptyMerged(): JSONObject {
        val m = JSONObject()
        for (k in MERGED_KEYS) m.put(k, JSONObject.NULL)
        return m
    }

    /** 将模型列表中的 quota 合并，忽略 chat_xxx、tab_xxx 等内部条目。models 可以是 JSONArray 或 JSONObject。 */
    @JvmStatic
    fun mergeModelQuotas(models: Any?): JSONObject {
        val merged = emptyMerged()
        val entries = ArrayList<Pair<String, Any?>>()
        when (models) {
            is JSONArray -> for (i in 0 until models.length()) entries.add(i.toString() to models.opt(i))
            is JSONObject -> for (k in models.keys()) entries.add(k to models.opt(k))
            else -> return merged
        }
        for ((modelKey, model) in entries) {
            if (model !is JSONObject) continue
            val nm = strOrNull(model.opt("name")).let { if (it.isNullOrEmpty()) modelKey else it }
            val name = nm.lowercase(Locale.ROOT)
            if (name.startsWith("chat_") || name.startsWith("tab_")) continue
            val family = when {
                name.contains("argon") -> "argon"
                Regex("claude|gpt|3p").containsMatchIn(name) -> "claude"
                name.contains("gemini") -> "gemini"
                else -> null
            } ?: continue
            val found = collectModelQuotas(model, family)
            for (key in MERGED_KEYS) {
                val f = found.optJSONObject(key) ?: continue
                val m = merged.optJSONObject(key)
                if (m == null || f.optDouble("fraction") < m.optDouble("fraction")) merged.put(key, f)
            }
        }
        return merged
    }

    /** 解析 retrieveUserQuotaSummary 响应。 */
    @JvmStatic
    fun parseSummary(body: Any?): JSONObject {
        val b0 = body as? JSONObject
        val d: JSONObject = b0?.optJSONObject("response") ?: b0 ?: JSONObject()
        val out = JSONObject()
        val buckets = ArrayList<Pair<JSONObject, String>>()
        d.optJSONArray("groups")?.let { groups ->
            for (i in 0 until groups.length()) {
                val g = groups.optJSONObject(i) ?: continue
                val gName = (strOrNull(g.opt("displayName")) ?: "").lowercase(Locale.ROOT)
                val bs = g.optJSONArray("buckets") ?: continue
                for (j in 0 until bs.length()) bs.optJSONObject(j)?.let { buckets.add(it to gName) }
            }
        }
        d.optJSONArray("buckets")?.let { bs ->
            for (j in 0 until bs.length()) bs.optJSONObject(j)?.let { buckets.add(it to "") }
        }
        for ((b, groupName) in buckets) {
            val id = (strOrNull(b.opt("bucketId")) ?: strOrNull(b.opt("bucket_id")) ?: "").lowercase(Locale.ROOT)
            val combined = "$groupName $id"
            val family = when {
                combined.contains("argon") -> "argon"
                Regex("claude|gpt|3p").containsMatchIn(combined) -> "claude"
                else -> "gemini"
            }
            val winRaw = strOrNull(b.opt("window")).let { if (it.isNullOrEmpty()) id.substringAfterLast('-') else it }
            val win = winRaw.lowercase(Locale.ROOT)
            var per: String? = when {
                Regex("week|7d|168h|wk").containsMatchIn(win) -> "7d"
                Regex("5h|five|300m").containsMatchIn(win) -> "5h"
                else -> null
            }
            val reset = strOrNull(b.opt("resetTime")) ?: strOrNull(b.opt("reset_time"))
            if (per == null && reset != null) {
                val hrs = hoursUntil(reset)
                if (hrs > WEEKLY_THRESHOLD_HOURS) per = "7d" else if (hrs >= 0) per = "5h"
            }
            if (per == null) continue
            var frac: Any? = b.opt("remainingFraction")
            if (isNullish(frac)) frac = b.opt("remaining_fraction")
            if (isNullish(frac)) frac = (b.opt("remaining") as? JSONObject)?.opt("remainingFraction")
            if (isNullish(frac) && reset != null) frac = 0.0
            if (frac !is Number) continue
            val fraction = Math.max(0.0, Math.min(1.0, frac.toDouble()))
            val key = "${family}_$per"
            val cur = out.optJSONObject(key)
            if (cur == null || (!cur.isNull("fraction") && fraction < cur.optDouble("fraction"))) {
                out.put(key, JSONObject().put("fraction", fraction).put("reset", reset ?: JSONObject.NULL).put("source", "summary"))
            }
        }
        return out
    }

    @JvmStatic
    fun toPublic(r: JSONObject?): Any {
        if (r == null) return JSONObject.NULL
        val oa = r.opt("observed_at")
        val fr = r.opt("fraction")
        val reset = strOrNull(r.opt("reset"))
        return JSONObject()
            .put("remaining_fraction", fr ?: JSONObject.NULL)
            .put("percentage", if (fr is Number) Math.round(fr.toDouble() * 100) else JSONObject.NULL)
            .put("inferred", truthy(r.opt("inferred")))
            .put("reset_time", reset ?: JSONObject.NULL)
            .put("reset_text", parseResetTime(reset) ?: "")
            .put("source", strOrNull(r.opt("source")) ?: JSONObject.NULL)
            .put("observed_at", if (oa == null) JSONObject.NULL else oa)
    }

    private class Spec(val key: String, val group: String, val label: String, val window: String, val core: Boolean)

    private val SPECS = listOf(
        Spec("gemini_5h", "gemini", "Gemini", "5h", true),
        Spec("gemini_7d", "gemini", "Gemini", "7d", true),
        Spec("claude_5h", "claude", "Claude / GPT", "5h", true),
        Spec("claude_7d", "claude", "Claude / GPT", "7d", true),
        Spec("argon_5h", "argon", "Argon", "5h", false),
        Spec("argon_7d", "argon", "Argon", "7d", false),
    )

    @JvmField
    val BUCKET_SPECS: JSONArray = JSONArray().apply {
        for (s in SPECS) put(JSONObject().put("key", s.key).put("group", s.group).put("label", s.label).put("window", s.window).put("core", s.core))
    }

    /** 识别模型名称归属家族：gemini | claude | argon */
    @JvmStatic
    fun getModelFamily(name: String?): String {
        val m = (name ?: "").lowercase(Locale.ROOT)
        if (m.contains("argon")) return "argon"
        if (Regex("claude|gpt|3p").containsMatchIn(m)) return "claude"
        return "gemini"
    }

    /** 取 5h 与 7d 的较小已知额度；值可以是数字或 {remaining_fraction|fraction}。均未知返回 null。 */
    @JvmStatic
    fun extractFamilyFraction(quotaObj: JSONObject?, family: String): Double? {
        if (quotaObj == null) return null
        fun f(v: Any?): Double? = when (v) {
            is Number -> v.toDouble()
            is JSONObject -> {
                var x = v.opt("remaining_fraction")
                if (isNullish(x)) x = v.opt("fraction")
                if (x is Number) x.toDouble() else null
            }
            else -> null
        }
        val f5 = f(quotaObj.opt("${family}_5h"))
        val f7 = f(quotaObj.opt("${family}_7d"))
        if (f5 != null && f7 != null) return Math.min(f5, f7)
        return f5 ?: f7
    }

    /** {gemini, claude, argon}，值为 0~1 或 JSONObject.NULL。 */
    @JvmStatic
    fun computeAccountQuotas(quotaData: JSONObject?): JSONObject = JSONObject()
        .put("gemini", extractFamilyFraction(quotaData, "gemini") ?: JSONObject.NULL)
        .put("claude", extractFamilyFraction(quotaData, "claude") ?: JSONObject.NULL)
        .put("argon", extractFamilyFraction(quotaData, "argon") ?: JSONObject.NULL)

    /** 动态 buckets：Gemini/Claude 4 个核心桶总是出现（没数据 missing:true），Argon 只在有数据时出现。 */
    @JvmStatic
    fun buildBuckets(merged: JSONObject?): JSONArray {
        val safe = merged ?: JSONObject()
        val buckets = JSONArray()
        for (spec in SPECS) {
            val item = safe.optJSONObject(spec.key)
            val fraction: Any? = if (item != null && item.has("remaining_fraction")) item.opt("remaining_fraction") else item?.opt("fraction")
            if (item != null && fraction is Number) {
                val percentage: Any = if (item.has("percentage")) item.opt("percentage") else Math.round(fraction.toDouble() * 100)
                val resetTime: Any = if (item.has("reset_time")) item.opt("reset_time") else (strOrNull(item.opt("reset")) ?: JSONObject.NULL)
                val resetText: Any = if (item.has("reset_text")) item.opt("reset_text") else (parseResetTime(strOrNull(resetTime)) ?: "")
                val source = strOrNull(item.opt("source"))
                val inferred = truthy(item.opt("inferred"))
                val observedAt: Any = if (item.has("observed_at")) item.opt("observed_at") else (item.opt("observedAt").let { if (isNullish(it)) JSONObject.NULL else it!! })
                var note: String? = strOrNull(item.opt("note"))?.ifEmpty { null }
                if (source == "observed") {
                    note = if (truthy(observedAt)) "上次观测于 ${formatHHMM(observedAt)}" else "上次观测"
                } else if (source == "observed-reset") {
                    note = "已过重置时间，按满额估计"
                }
                val b = JSONObject()
                    .put("group", spec.group).put("label", spec.label).put("window", spec.window)
                    .put("percentage", percentage)
                    .put("remaining_fraction", fraction)
                    .put("reset_time", resetTime)
                    .put("reset_text", resetText)
                    .put("source", source ?: JSONObject.NULL)
                    .put("observed_at", observedAt)
                    .put("inferred", inferred)
                    .put("missing", false)
                if (note != null) b.put("note", note)
                buckets.put(b)
            } else if (spec.core) {
                buckets.put(
                    JSONObject()
                        .put("group", spec.group).put("label", spec.label).put("window", spec.window)
                        .put("percentage", JSONObject.NULL).put("remaining_fraction", JSONObject.NULL)
                        .put("reset_time", JSONObject.NULL).put("reset_text", "")
                        .put("source", JSONObject.NULL).put("observed_at", JSONObject.NULL)
                        .put("inferred", false).put("missing", true)
                        .put("note", if (spec.key == "gemini_7d") "接口未返回（Pro 号通常没有 Gemini 周额度）" else "接口未返回")
                )
            }
        }
        return buckets
    }

    /** 归一化订阅等级：ULTRA | PRO | FREE | null */
    @JvmStatic
    fun normalizeTier(id: String?): String? {
        if (id.isNullOrEmpty()) return null
        val s = id.lowercase(Locale.ROOT)
        if (s.contains("ultra")) return "ULTRA"
        if (s.contains("pro")) return "PRO"
        if (s.contains("free") || s.contains("standard") || s.contains("legacy")) return "FREE"
        return null
    }

    class TierEntry(@JvmField val tier: String?, @JvmField val expireAt: Long)

    /** email -> { tier, expireAt } */
    @JvmField
    val tierCache = ConcurrentHashMap<String, TierEntry>()

    // ------------------------------------------------------------------ 网络

    /** POST JSON，返回 (status, body)；网络错误抛异常。用全局 UpstreamFetch.client，单次调用超时。 */
    private fun postJson(url: String, accessToken: String, body: JSONObject, timeoutMs: Long): Pair<Int, String> {
        val req = Request.Builder().url(url)
            .header("Authorization", "Bearer $accessToken")
            .header("Content-Type", "application/json")
            .header("User-Agent", UA)
            .post(body.toString().toRequestBody(JSON_TYPE))
            .build()
        val call = UpstreamFetch.client.newCall(req)
        call.timeout().timeout(timeoutMs, TimeUnit.MILLISECONDS)
        call.execute().use { res -> return res.code to (res.body?.string() ?: "") }
    }

    @JvmStatic
    @JvmOverloads
    fun fetchSubscriptionTier(accessToken: String?, email: String? = null): String? {
        if (accessToken.isNullOrEmpty()) return null
        if (!email.isNullOrEmpty()) {
            val c = tierCache[email]
            if (c != null && c.expireAt > System.currentTimeMillis()) return c.tier
        }
        val bases = arrayOf("https://cloudcode-pa.googleapis.com", "https://daily-cloudcode-pa.googleapis.com")
        for (base in bases) {
            try {
                val (code, text) = postJson("$base/v1internal:loadCodeAssist", accessToken,
                    JSONObject().put("metadata", JSONObject().put("ideType", "ANTIGRAVITY")), 10000)
                if (code !in 200..299) continue
                val d = JSONObject(text)
                val body = d.optJSONObject("response") ?: d
                val rawId = listOf("paidTier", "currentTier", "tier")
                    .map { strOrNull(body.optJSONObject(it)?.opt("id")) ?: "" }
                    .firstOrNull { it.isNotEmpty() } ?: ""
                val tier = normalizeTier(rawId)
                if (!email.isNullOrEmpty()) tierCache[email] = TierEntry(tier, System.currentTimeMillis() + TIER_CACHE_TTL_MS)
                return tier
            } catch (_: Throwable) {
            }
        }
        return null
    }

    /** 官方 /usage 用的分组配额（含周额度）：daily → prod → sandbox，第一个 2xx 即返回；无数据返回 null。 */
    @JvmStatic
    fun fetchQuotaSummary(accessToken: String, project: String?): JSONObject? {
        val bases = arrayOf(
            "https://daily-cloudcode-pa.googleapis.com",
            "https://cloudcode-pa.googleapis.com",
            "https://daily-cloudcode-pa.sandbox.googleapis.com",
        )
        for (base in bases) {
            try {
                val (code, text) = postJson("$base/v1internal:retrieveUserQuotaSummary", accessToken,
                    if (!project.isNullOrEmpty()) JSONObject().put("project", project) else JSONObject(), 15000)
                if (code !in 200..299) continue
                val summary = parseSummary(JSONObject(text))
                return if (summary.length() > 0) summary else null
            } catch (_: Throwable) {
            }
        }
        return null
    }

    private fun failResult(message: String, email: Any?, withLegacy: Boolean): JSONObject {
        val o = JSONObject()
            .put("ok", false)
            .put("message", message)
            .put("email", email ?: JSONObject.NULL)
            .put("tier", JSONObject.NULL)
        for (k in MERGED_KEYS) o.put(k, JSONObject.NULL)
        o.put("buckets", JSONArray())
        if (withLegacy) {
            o.put("five_hour", JSONObject().put("percentage", JSONObject.NULL).put("reset_time", JSONObject.NULL))
            o.put("claude_five_hour", JSONObject().put("percentage", JSONObject.NULL).put("reset_time", JSONObject.NULL))
            o.put("weekly", JSONObject().put("percentage", JSONObject.NULL))
        }
        o.put("updated_time", localeTime())
        return o
    }

    /** 同步阻塞：拉取某账号的实时配额，返回与 Node 版字段一致的 JSONObject。 */
    @JvmStatic
    fun fetchRealQuota(tokenManager: TokenManager?): JSONObject {
        val td = tokenManager?.tokenData
        if (tokenManager == null || td == null || td.optString("refreshToken", "").isEmpty()) {
            return failResult("尚未配置 Google 账号", "未登录", false)
        }
        val accessToken: String? = try { tokenManager.getValidAccessToken() } catch (_: Throwable) { null }
        if (accessToken.isNullOrEmpty()) {
            return failResult("Google 凭据失效", td.opt("email"), false)
        }
        try {
            var project = td.optString("projectId", "")
            if (project.isEmpty()) {
                project = try { tokenManager.ensureProjectId() ?: "" } catch (_: Throwable) { "" }
            }
            val validProj = if (project.isNotEmpty() && project != "pending_detection") project else ""

            val endpoints = arrayOf(Constants.ANTIGRAVITY_ENDPOINT_DAILY, Constants.CLOUDCODE_API_ENDPOINT)
            var data: JSONObject? = null
            var lastErr: Throwable? = null
            for (base in endpoints) {
                try {
                    val (code, text) = postJson("$base/v1internal:fetchAvailableModels", accessToken,
                        if (validProj.isNotEmpty()) JSONObject().put("project", validProj) else JSONObject(), 15000)
                    if (code in 200..299) { data = JSONObject(text); break }
                    lastErr = Exception("Google HTTP $code")
                } catch (e: Throwable) {
                    lastErr = e
                }
            }
            if (data == null) throw (lastErr ?: Exception("all quota endpoints unreachable"))

            val models: Any = data.opt("models") ?: data
            val merged = mergeModelQuotas(models)
            val email = td.optString("email", "").ifEmpty { "default" }
            val now = System.currentTimeMillis()

            val g5 = merged.optJSONObject("gemini_5h")
            val hasModelsGemini5h = g5 != null && g5.opt("fraction") is Number
            if (hasModelsGemini5h && !g5!!.has("observed_at")) g5.put("observed_at", now)

            val sum: JSONObject? = try { fetchQuotaSummary(accessToken, validProj) } catch (_: Throwable) { null }
            val effective = applyObservedFallback(email, sum ?: JSONObject(), now)
            for (k in effective.keys()) {
                val v = effective.optJSONObject(k) ?: continue
                if (k == "gemini_5h" && hasModelsGemini5h) continue
                merged.put(k, v)
            }

            val tier: String? = try { fetchSubscriptionTier(accessToken, email) } catch (_: Throwable) { null }

            val result = JSONObject()
                .put("ok", true)
                .put("email", td.opt("email") ?: JSONObject.NULL)
                .put("tier", tier ?: JSONObject.NULL)
            for (k in MERGED_KEYS) result.put(k, toPublic(merged.optJSONObject(k)))
            result.put("buckets", buildBuckets(merged))
            result.put("updated_unix", System.currentTimeMillis() / 1000)
            result.put("updated_time", localeTime())
            val pg5 = result.optJSONObject("gemini_5h")
            val pc5 = result.optJSONObject("claude_5h")
            val pg7 = result.optJSONObject("gemini_7d")
            result.put("five_hour", JSONObject()
                .put("percentage", pg5?.opt("percentage") ?: JSONObject.NULL)
                .put("reset_time", pg5?.opt("reset_time")?.takeIf { truthy(it) } ?: JSONObject.NULL))
            result.put("claude_five_hour", JSONObject()
                .put("percentage", pc5?.opt("percentage") ?: JSONObject.NULL)
                .put("reset_time", pc5?.opt("reset_time")?.takeIf { truthy(it) } ?: JSONObject.NULL))
            result.put("weekly", JSONObject().put("percentage", pg7?.opt("percentage") ?: JSONObject.NULL))
            return result
        } catch (err: Throwable) {
            android.util.Log.e("QuotaFetcher", "[Quota Fetch Error]: " + err.message)
            return failResult(err.message ?: err.toString(), td.opt("email"), true)
        }
    }

    // ------------------------------------------------------------------ 小工具

    private fun isNullish(v: Any?) = v == null || v == JSONObject.NULL

    private fun firstNonNull(o: JSONObject, vararg keys: String): Any? {
        for (k in keys) { val v = o.opt(k); if (!isNullish(v)) return v }
        return null
    }

    private fun strOrNull(v: Any?): String? = when {
        isNullish(v) -> null
        v is String -> v.ifEmpty { null }
        else -> v.toString()
    }

    private fun numOr(v: Any?, d: Double) = if (v is Number) v.toDouble() else d

    /** JS 真值：null/NULL/false/0/""/NaN 为假。 */
    private fun truthy(v: Any?): Boolean = when (v) {
        null, JSONObject.NULL -> false
        is Boolean -> v
        is Number -> v.toDouble() != 0.0 && !v.toDouble().isNaN()
        is String -> v.isNotEmpty()
        else -> true
    }
}
