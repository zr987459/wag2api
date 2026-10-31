package com.wag2api.ag

import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.text.SimpleDateFormat
import java.util.ArrayDeque
import java.util.Calendar
import java.util.Date
import java.util.Locale
import java.util.TimeZone
import java.util.TreeMap
import java.util.concurrent.ScheduledFuture
import java.util.concurrent.ScheduledThreadPoolExecutor
import java.util.concurrent.TimeUnit

/**
 * 移植自 src/stats.mjs：按账号隔离的用量统计 + 24h/7d 趋势。
 *
 * 记账口径与 Node 版一致（input 不含缓存命中、cached、output 含思考 token、total = input+cached+output）。
 * 时间桶一律 UTC key（minutely 'YYYY-MM-DDTHH:MM'、hourly 'YYYY-MM-DDTHH'、daily 'YYYY-MM-DD'）。
 *
 * 安卓瘦身（合同第 6 条）：
 * - 请求明细（logs）改为全局有上限的环形缓冲（默认 200 条，单账号最多 100 条），不再每账号常驻；
 * - 统计只在内存里保留按分钟(120m)/小时(48h)/天(92d)聚合的计数（紧凑的 Long 字段，不是 JSON 树）；
 * - 存盘格式仍是 user_stats.json（schema 2，字段与 Node 版相同，logs 写回各账号桶），老数据可直接读；
 * - 2 秒防抖写盘（tmp + rename），写盘线程空闲 10 秒后退出。
 * 控制台接口（/api/stats、/api/trend、/api/token-stats、/api/stats/timing、/api/logs）返回字段与原版一致。
 */
object Stats {

    const val STATS_SCHEMA = 2
    internal const val MINUTELY_KEEP_MS = 120L * 60 * 1000
    internal const val HOURLY_KEEP_MS = 48L * 3600 * 1000
    internal const val DAILY_KEEP_DAYS = 92
    internal const val SAVE_DEBOUNCE_MS = 2000L

    /** 明细环形缓冲上限（合同默认 200）。 */
    const val LOG_RING_CAPACITY = 200

    @JvmField
    val TIMING_MS_FIELDS = arrayOf("t_token", "t_payload", "t_tls", "t_headers", "t_first_thought", "t_first_text")

    internal val SLOT_FIELDS = arrayOf("requests", "errors", "input", "cached", "output", "tokens", "thoughts", "lat_sum", "lat_n", "ttft_sum", "ttft_n")
    internal val MODEL_FIELDS = arrayOf("requests", "errors", "input", "cached", "output", "thoughts", "tokens")

    // ---------------------------------------------------------------- UTC key（不依赖 java.time，minSdk 24 可用）

    private fun civil(ms: Long): IntArray {
        val days = Math.floorDiv(ms, 86400000L)
        val rem = Math.floorMod(ms, 86400000L)
        // Howard Hinnant civil_from_days
        val z = days + 719468
        val era = Math.floorDiv(z, 146097L)
        val doe = z - era * 146097
        val yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365
        val y = yoe + era * 400
        val doy = doe - (365 * yoe + yoe / 4 - yoe / 100)
        val mp = (5 * doy + 2) / 153
        val d = doy - (153 * mp + 2) / 5 + 1
        val m = if (mp < 10) mp + 3 else mp - 9
        val yy = if (m <= 2) y + 1 else y
        return intArrayOf(yy.toInt(), m.toInt(), d.toInt(), (rem / 3600000).toInt(), ((rem / 60000) % 60).toInt())
    }

    internal fun utcMs(y: Int, m: Int, d: Int, h: Int = 0, mi: Int = 0): Long {
        val yy = (if (m <= 2) y - 1 else y).toLong()
        val era = Math.floorDiv(yy, 400L)
        val yoe = yy - era * 400
        val mp = ((m + 9) % 12).toLong()
        val doy = (153 * mp + 2) / 5 + d - 1
        val doe = yoe * 365 + yoe / 4 - yoe / 100 + doy
        val days = era * 146097 + doe - 719468
        return days * 86400000L + h * 3600000L + mi * 60000L
    }

    private fun p2(v: Int) = if (v < 10) "0$v" else v.toString()

    @JvmStatic fun utcMinuteKey(ms: Long): String { val c = civil(ms); return "${c[0]}-${p2(c[1])}-${p2(c[2])}T${p2(c[3])}:${p2(c[4])}" }
    @JvmStatic fun utcHourKey(ms: Long): String { val c = civil(ms); return "${c[0]}-${p2(c[1])}-${p2(c[2])}T${p2(c[3])}" }
    @JvmStatic fun utcDayKey(ms: Long): String { val c = civil(ms); return "${c[0]}-${p2(c[1])}-${p2(c[2])}" }
    @JvmStatic fun utcMinuteKey(d: Date) = utcMinuteKey(d.time)
    @JvmStatic fun utcHourKey(d: Date) = utcHourKey(d.time)
    @JvmStatic fun utcDayKey(d: Date) = utcDayKey(d.time)

    private val KEY_RE = Regex("^(\\d{4})-(\\d{2})-(\\d{2})(?:[T ](\\d{2})(?::(\\d{2}))?)?$")

    /** 'YYYY-MM-DD[THH[:MM]]'（也接受旧版空格）→ UTC 毫秒；无法解析返回 null（JS 的 NaN）。 */
    internal fun keyToMs(k: String): Long? {
        val m = KEY_RE.matchEntire(k) ?: return null
        val g = m.groupValues
        return utcMs(g[1].toInt(), g[2].toInt(), g[3].toInt(), g[4].toIntOrNull() ?: 0, g[5].toIntOrNull() ?: 0)
    }

    internal fun dayStartMs(dayKey: String): Long = keyToMs(dayKey) ?: 0L

    internal fun num(v: Any?): Double = when (v) {
        is Number -> { val d = v.toDouble(); if (d.isFinite()) d else 0.0 }
        is String -> v.trim().toDoubleOrNull()?.takeIf { it.isFinite() } ?: if (v.isBlank()) 0.0 else 0.0
        is Boolean -> if (v) 1.0 else 0.0
        else -> 0.0
    }

    internal fun numL(v: Any?): Long = Math.round(num(v))

    internal fun isOk(s: Int) = s in 200..299

    /** JSON 里放数字：整数写成整数，小数原样（与 JS JSON.stringify 一致）。 */
    internal fun jn(d: Double): Any = if (d == Math.rint(d) && Math.abs(d) < 9.0e15) d.toLong() else d

    internal fun hitRate(input: Long, cached: Long): Any {
        val r: Any? = Usage.cacheHitRate(input, cached)
        return if (r is Number) r.toDouble() else JSONObject.NULL
    }

    /** 中位数：忽略 null / 非数值；空集返回 null。 */
    @JvmStatic
    fun median(values: List<Any?>): Double? {
        val a = values.mapNotNull { v ->
            when (v) {
                null, JSONObject.NULL -> null
                is Number -> v.toDouble().takeIf { it.isFinite() }
                is String -> v.toDoubleOrNull()?.takeIf { it.isFinite() }
                is Boolean -> if (v) 1.0 else 0.0
                else -> null
            }
        }.sorted()
        if (a.isEmpty()) return null
        val m = a.size shr 1
        return if (a.size % 2 == 1) a[m] else Math.round(((a[m - 1] + a[m]) / 2) * 1000) / 1000.0
    }

    // ---------------------------------------------------------------- 迁移（JSON 层，等同 Node migrateBucket）

    private fun emptyBucketJson(): JSONObject = JSONObject()
        .put("schema", STATS_SCHEMA)
        .put("total_requests", 0).put("success_requests", 0).put("error_requests", 0)
        .put("input_tokens", 0).put("cached_tokens", 0).put("output_tokens", 0).put("thoughts_tokens", 0).put("total_tokens", 0)
        .put("latency_sum_ms", 0).put("latency_count", 0).put("avg_latency_ms", 0)
        .put("ttft_sum_ms", 0).put("ttft_count", 0).put("avg_ttft_ms", 0)
        .put("logs", JSONArray()).put("downgrades", JSONArray())
        .put("minutely", JSONObject()).put("hourly", JSONObject()).put("daily", JSONObject())

    private fun emptySlotJson(): JSONObject {
        val o = JSONObject()
        for (f in SLOT_FIELDS) o.put(f, 0)
        o.put("models", JSONObject())
        return o
    }

    private fun mergeInto(dst: JSONObject, src: JSONObject): JSONObject {
        for (k in src.keys()) dst.put(k, src.opt(k))
        return dst
    }

    /** 旧版 user_stats.json 桶 → schema 2（就地迁移，幂等）。 */
    @JvmStatic
    fun migrateBucket(b0: Any?): JSONObject {
        if (b0 !is JSONObject) return emptyBucketJson()
        val b = b0
        val wasCurrent = num(b.opt("schema")).toInt() == STATS_SCHEMA && b.opt("schema") is Number
        val base = emptyBucketJson()
        for (k in base.keys()) if (!b.has(k)) b.put(k, base.opt(k))
        if (b.opt("logs") !is JSONArray) b.put("logs", JSONArray())
        for (k in arrayOf("minutely", "hourly", "daily")) if (b.opt(k) !is JSONObject) b.put(k, JSONObject())
        for (k in arrayOf("minutely", "hourly", "daily")) {
            val map = b.getJSONObject(k)
            for (sk in map.keys()) {
                val slot = map.optJSONObject(sk) ?: continue
                if (slot.opt("models") !is JSONObject) slot.put("models", JSONObject())
            }
        }
        if (wasCurrent) return b

        val inp = num(b.opt("input_tokens")); val cac = num(b.opt("cached_tokens")); val out = num(b.opt("output_tokens"))
        b.put("input_tokens", jn(inp)).put("cached_tokens", jn(cac)).put("output_tokens", jn(out)).put("total_tokens", jn(inp + cac + out))

        var lsum = 0.0; var lcnt = 0L; var errs = 0L
        val logs = b.getJSONArray("logs")
        for (i in 0 until logs.length()) {
            val l = logs.optJSONObject(i) ?: continue
            if (!isOk(num(l.opt("status")).toInt())) { errs++; continue }
            if (num(l.opt("latency_ms")) > 0) { lsum += num(l.opt("latency_ms")); lcnt++ }
            val t = l.optJSONObject("tokens")
            if (t != null && !t.has("total")) t.put("total", jn(num(t.opt("input")) + num(t.opt("cached")) + num(t.opt("output"))))
            if (!l.has("cache_hit_rate") && t != null) l.put("cache_hit_rate", hitRate(numL(t.opt("input")), numL(t.opt("cached"))))
        }
        b.put("latency_sum_ms", jn(lsum)).put("latency_count", lcnt)
        b.put("avg_latency_ms", if (lcnt > 0) Math.round(lsum / lcnt) else 0)
        val total = numL(b.opt("total_requests"))
        val er = Math.min(errs, total)
        b.put("error_requests", er).put("success_requests", total - er)

        val hourly = JSONObject()
        val oldH = b.getJSONObject("hourly")
        for (k in oldH.keys()) {
            val v = oldH.optJSONObject(k) ?: continue
            hourly.put(k.replace(' ', 'T'), mergeInto(emptySlotJson(), v))
        }
        b.put("hourly", hourly)
        val daily = b.getJSONObject("daily")
        for (k in daily.keys().asSequence().toList()) {
            val v = daily.optJSONObject(k) ?: continue
            daily.put(k, mergeInto(emptySlotJson(), v))
        }
        b.put("schema", STATS_SCHEMA)
        b.put("migrated_from_v1", true)
        return b
    }

    // ---------------------------------------------------------------- timing

    internal fun cleanTiming(t: JSONObject): JSONObject {
        val o = JSONObject()
        for (f in TIMING_MS_FIELDS) {
            val v = t.opt(f)
            val d = when (v) { is Number -> v.toDouble(); is String -> v.toDoubleOrNull(); else -> null }
            o.put(f, if (v == null || v == JSONObject.NULL || d == null || !d.isFinite()) JSONObject.NULL else Math.max(0L, Math.round(d)))
        }
        val host = t.opt("host")
        o.put("host", if (host == null || host == JSONObject.NULL || host == false || host.toString().isEmpty()) JSONObject.NULL else host.toString().take(80))
        o.put("attempts", Math.max(0L, Math.round(num(t.opt("attempts")))))
        o.put("switched_account", truthy(t.opt("switched_account")))
        o.put("switched_host", truthy(t.opt("switched_host")))
        val cr = t.opt("conn_reused")
        o.put("conn_reused", if (cr == true) true else if (cr == false) false else JSONObject.NULL)
        return o
    }

    internal fun truthy(v: Any?): Boolean = when (v) {
        null, JSONObject.NULL -> false
        is Boolean -> v
        is Number -> v.toDouble() != 0.0 && !v.toDouble().isNaN()
        is String -> v.isNotEmpty()
        else -> true
    }

    /** 全局单例（数据目录 = AgPaths.dataDir）。 */
    @JvmStatic
    val statsTracker: StatsTracker by lazy { StatsTracker(File(AgPaths.dataDir.toString())) }
}

/** 一个模型在一个时间槽里的计数。 */
internal class ModelAgg {
    @JvmField var requests = 0L; @JvmField var errors = 0L; @JvmField var input = 0L; @JvmField var cached = 0L
    @JvmField var output = 0L; @JvmField var thoughts = 0L; @JvmField var tokens = 0L

    fun add(o: ModelAgg) {
        requests += o.requests; errors += o.errors; input += o.input; cached += o.cached
        output += o.output; thoughts += o.thoughts; tokens += o.tokens
    }

    fun toJson(): JSONObject = JSONObject().put("requests", requests).put("errors", errors).put("input", input)
        .put("cached", cached).put("output", output).put("thoughts", thoughts).put("tokens", tokens)

    companion object {
        fun from(o: JSONObject): ModelAgg = ModelAgg().apply {
            requests = Stats.numL(o.opt("requests")); errors = Stats.numL(o.opt("errors")); input = Stats.numL(o.opt("input"))
            cached = Stats.numL(o.opt("cached")); output = Stats.numL(o.opt("output")); thoughts = Stats.numL(o.opt("thoughts"))
            tokens = Stats.numL(o.opt("tokens"))
        }
    }
}

/** 一个时间槽（分钟/小时/天）的聚合计数，字段名同 Node 版 emptySlot()。 */
internal class Slot {
    @JvmField val v = LongArray(Stats.SLOT_FIELDS.size) // requests, errors, input, cached, output, tokens, thoughts, lat_sum, lat_n, ttft_sum, ttft_n
    var models: HashMap<String, ModelAgg>? = null

    var requests: Long get() = v[0]; set(x) { v[0] = x }
    var errors: Long get() = v[1]; set(x) { v[1] = x }
    var input: Long get() = v[2]; set(x) { v[2] = x }
    var cached: Long get() = v[3]; set(x) { v[3] = x }
    var output: Long get() = v[4]; set(x) { v[4] = x }
    var tokens: Long get() = v[5]; set(x) { v[5] = x }
    var thoughts: Long get() = v[6]; set(x) { v[6] = x }
    var latSum: Long get() = v[7]; set(x) { v[7] = x }
    var latN: Long get() = v[8]; set(x) { v[8] = x }
    var ttftSum: Long get() = v[9]; set(x) { v[9] = x }
    var ttftN: Long get() = v[10]; set(x) { v[10] = x }

    fun addFields(o: Slot) { for (i in v.indices) v[i] += o.v[i] }

    fun model(name: String): ModelAgg {
        val m = models ?: HashMap<String, ModelAgg>(4).also { models = it }
        return m.getOrPut(name) { ModelAgg() }
    }

    fun addModels(o: Slot) { o.models?.forEach { (k, mm) -> model(k).add(mm) } }

    fun putFields(o: JSONObject): JSONObject {
        for (i in v.indices) o.put(Stats.SLOT_FIELDS[i], v[i])
        return o
    }

    fun toJson(withModels: Boolean = true): JSONObject {
        val o = putFields(JSONObject())
        if (withModels) {
            val mj = JSONObject()
            models?.forEach { (k, mm) -> mj.put(k, mm.toJson()) }
            o.put("models", mj)
        }
        return o
    }

    companion object {
        fun from(o: JSONObject): Slot {
            val s = Slot()
            for (i in s.v.indices) s.v[i] = Stats.numL(o.opt(Stats.SLOT_FIELDS[i]))
            val mj = o.optJSONObject("models")
            if (mj != null && mj.length() > 0) {
                val m = HashMap<String, ModelAgg>(mj.length())
                for (k in mj.keys()) mj.optJSONObject(k)?.let { m[k] = ModelAgg.from(it) }
                s.models = m
            }
            return s
        }
    }
}

internal class Downgrade(@JvmField val ts: Long, @JvmField val from: String?, @JvmField val to: String?, @JvmField val reason: String)

/** 一个账号的统计桶（不含明细，明细在全局环形缓冲里）。 */
internal class Bucket {
    var totalRequests = 0L; var successRequests = 0L; var errorRequests = 0L
    var inputTokens = 0L; var cachedTokens = 0L; var outputTokens = 0L; var thoughtsTokens = 0L; var totalTokens = 0L
    var latencySumMs = 0L; var latencyCount = 0L; var ttftSumMs = 0L; var ttftCount = 0L
    var migratedFromV1 = false
    val downgrades = ArrayDeque<Downgrade>()
    val minutely = TreeMap<String, Slot>()
    val hourly = TreeMap<String, Slot>()
    val daily = TreeMap<String, Slot>()

    /** 未知字段原样保留（存盘时写回），保证老数据不丢字段。 */
    var extra: JSONObject? = null

    fun map(name: String): TreeMap<String, Slot>? = when (name) {
        "minutely" -> minutely; "hourly" -> hourly; "daily" -> daily; else -> null
    }

    fun avgLatency() = if (latencyCount > 0) Math.round(latencySumMs.toDouble() / latencyCount) else 0L
    fun avgTtft() = if (ttftCount > 0) Math.round(ttftSumMs.toDouble() / ttftCount) else 0L

    fun toJson(logs: JSONArray): JSONObject {
        val o = JSONObject()
        extra?.let { e -> for (k in e.keys()) o.put(k, e.opt(k)) }
        o.put("schema", Stats.STATS_SCHEMA)
            .put("total_requests", totalRequests).put("success_requests", successRequests).put("error_requests", errorRequests)
            .put("input_tokens", inputTokens).put("cached_tokens", cachedTokens).put("output_tokens", outputTokens)
            .put("thoughts_tokens", thoughtsTokens).put("total_tokens", totalTokens)
            .put("latency_sum_ms", latencySumMs).put("latency_count", latencyCount).put("avg_latency_ms", avgLatency())
            .put("ttft_sum_ms", ttftSumMs).put("ttft_count", ttftCount).put("avg_ttft_ms", avgTtft())
            .put("logs", logs)
        val dg = JSONArray()
        for (d in downgrades) dg.put(JSONObject().put("ts", d.ts).put("from", d.from ?: JSONObject.NULL).put("to", d.to ?: JSONObject.NULL).put("reason", d.reason))
        o.put("downgrades", dg)
        for ((name, m) in arrayOf("minutely" to minutely, "hourly" to hourly, "daily" to daily)) {
            val mj = JSONObject()
            for ((k, s) in m) mj.put(k, s.toJson())
            o.put(name, mj)
        }
        if (migratedFromV1) o.put("migrated_from_v1", true)
        return o
    }

    companion object {
        private val KNOWN = setOf(
            "schema", "total_requests", "success_requests", "error_requests", "input_tokens", "cached_tokens", "output_tokens",
            "thoughts_tokens", "total_tokens", "latency_sum_ms", "latency_count", "avg_latency_ms", "ttft_sum_ms", "ttft_count",
            "avg_ttft_ms", "logs", "downgrades", "minutely", "hourly", "daily", "migrated_from_v1",
        )

        /** 输入须已经过 Stats.migrateBucket。 */
        fun from(j: JSONObject): Bucket {
            val b = Bucket()
            b.totalRequests = Stats.numL(j.opt("total_requests")); b.successRequests = Stats.numL(j.opt("success_requests"))
            b.errorRequests = Stats.numL(j.opt("error_requests")); b.inputTokens = Stats.numL(j.opt("input_tokens"))
            b.cachedTokens = Stats.numL(j.opt("cached_tokens")); b.outputTokens = Stats.numL(j.opt("output_tokens"))
            b.thoughtsTokens = Stats.numL(j.opt("thoughts_tokens")); b.totalTokens = Stats.numL(j.opt("total_tokens"))
            b.latencySumMs = Stats.numL(j.opt("latency_sum_ms")); b.latencyCount = Stats.numL(j.opt("latency_count"))
            b.ttftSumMs = Stats.numL(j.opt("ttft_sum_ms")); b.ttftCount = Stats.numL(j.opt("ttft_count"))
            b.migratedFromV1 = Stats.truthy(j.opt("migrated_from_v1"))
            j.optJSONArray("downgrades")?.let { a ->
                for (i in 0 until a.length()) {
                    val d = a.optJSONObject(i) ?: continue
                    b.downgrades.add(Downgrade(Stats.numL(d.opt("ts")), d.optStr("from"), d.optStr("to"), d.optStr("reason") ?: "unknown"))
                }
            }
            for (name in arrayOf("minutely", "hourly", "daily")) {
                val mj = j.optJSONObject(name) ?: continue
                val m = b.map(name)!!
                for (k in mj.keys()) mj.optJSONObject(k)?.let { m[k] = Slot.from(it) }
            }
            for (k in j.keys()) {
                if (k in KNOWN) continue
                val e = b.extra ?: JSONObject().also { b.extra = it }
                e.put(k, j.opt(k))
            }
            return b
        }

        private fun JSONObject.optStr(k: String): String? { val v = opt(k); return if (v == null || v == JSONObject.NULL) null else v.toString() }
    }
}

/** 环形缓冲里的一条明细：日志 JSON（字段同 Node 版）+ 所属账号。 */
internal class LogEntry(@JvmField val email: String, @JvmField val json: JSONObject) {
    val timestamp: Long get() = Stats.numL(json.opt("timestamp"))
}

class StatsTracker @JvmOverloads constructor(
    @JvmField val storageDir: File,
    @Suppress("UNUSED_PARAMETER") autoFlushOnExit: Boolean = true,
) {
    @JvmField val dataFile = File(storageDir, "user_stats.json")

    /** 单账号最多保留的明细条数（同 Node 版 maxLogsPerUser）。 */
    @JvmField var maxLogsPerUser = 100

    /** 全局明细环形缓冲上限。 */
    @JvmField var logCapacity = Stats.LOG_RING_CAPACITY

    /** 最近一次 recordRequest 的时间（毫秒），供 QuotaRefresher 判断空闲。 */
    @Volatile var lastRequestAt = 0L
        private set

    private val userStats = LinkedHashMap<String, Bucket>()
    private val logs = ArrayDeque<LogEntry>() // 新的在前
    private var dirty = false
    private var saveTimer: ScheduledFuture<*>? = null

    private val saver: ScheduledThreadPoolExecutor by lazy {
        ScheduledThreadPoolExecutor(1) { r -> Thread(r, "ag-stats-save").apply { isDaemon = true } }.apply {
            setKeepAliveTime(10, TimeUnit.SECONDS)
            allowCoreThreadTimeOut(true)
            removeOnCancelPolicy = true
        }
    }

    init {
        ensureStorage()
        load()
    }

    fun ensureStorage() {
        if (!storageDir.isDirectory) storageDir.mkdirs()
    }

    @Synchronized
    fun load() {
        userStats.clear()
        logs.clear()
        try {
            if (!dataFile.isFile) return
            val raw = JSONObject(dataFile.readText(Charsets.UTF_8))
            val all = ArrayList<LogEntry>()
            for (k in raw.keys()) {
                val j = Stats.migrateBucket(raw.opt(k))
                userStats[k] = Bucket.from(j)
                val la = j.optJSONArray("logs") ?: continue
                for (i in 0 until Math.min(la.length(), maxLogsPerUser)) la.optJSONObject(i)?.let { all.add(LogEntry(k, it)) }
            }
            all.sortByDescending { it.timestamp }
            for (e in all) { if (logs.size >= logCapacity) break; logs.addLast(e) }
            lastRequestAt = logs.peekFirst()?.timestamp ?: 0L
        } catch (e: Throwable) {
            android.util.Log.e("Stats", "[Stats] 读取 user_stats.json 失败，已从空白开始: ${e.message}")
            userStats.clear()
            logs.clear()
        }
    }

    /** 防抖写盘：高并发下不会每个请求都同步写一次。 */
    @Synchronized
    fun save() {
        dirty = true
        if (saveTimer != null) return
        saveTimer = saver.schedule({
            synchronized(this) { saveTimer = null }
            flush()
        }, Stats.SAVE_DEBOUNCE_MS, TimeUnit.MILLISECONDS)
    }

    @Synchronized
    fun flush() {
        saveTimer?.cancel(false)
        saveTimer = null
        if (!dirty) return
        try {
            ensureStorage()
            val tmp = File(dataFile.path + ".tmp")
            tmp.writeText(serialize().toString(), Charsets.UTF_8)
            if (!tmp.renameTo(dataFile)) { dataFile.delete(); if (!tmp.renameTo(dataFile)) throw Exception("rename failed") }
            dirty = false
        } catch (e: Throwable) {
            android.util.Log.e("Stats", "[Stats] 写盘失败: ${e.message}")
        }
    }

    private fun serialize(): JSONObject {
        val perUser = HashMap<String, JSONArray>()
        for (e in logs) {
            val a = perUser.getOrPut(e.email) { JSONArray() }
            if (a.length() < maxLogsPerUser) a.put(e.json)
        }
        val out = JSONObject()
        for ((k, b) in userStats) out.put(k, b.toJson(perUser[k] ?: JSONArray()))
        return out
    }

    private fun keyOf(email: String?) = (email ?: "anonymous").ifEmpty { "anonymous" }.trim().lowercase(Locale.ROOT)

    private fun bucketOf(email: String?): Pair<String, Bucket> {
        val key = keyOf(email)
        return key to userStats.getOrPut(key) { Bucket() }
    }

    /** 与 Node 版同名的入口：接受一个 JSONObject（字段同 JS 参数对象）。 */
    fun recordRequest(o: JSONObject) {
        fun s(k: String): String? { val v = o.opt(k); return if (v == null || v == JSONObject.NULL) null else v.toString() }
        fun n(k: String): Number? { val v = o.opt(k); return if (v is Number) v else if (v is String) v.toDoubleOrNull() else null }
        val nowAny = o.opt("now")
        recordRequest(
            email = s("email"), model = s("model"), latency_ms = n("latency_ms"),
            status = n("status")?.toInt() ?: 200,
            input_tokens = n("input_tokens") ?: 0, output_tokens = n("output_tokens") ?: 0,
            cached_tokens = n("cached_tokens") ?: 0, thoughts_tokens = n("thoughts_tokens") ?: 0,
            ttft_ms = n("ttft_ms"), is_stream = o.optBoolean("is_stream", false), error = s("error"),
            timing = o.optJSONObject("timing"), model_used = s("model_used"),
            downgraded = Stats.truthy(o.opt("downgraded")), downgrade_reason = s("downgrade_reason"),
            now = if (nowAny is Number) nowAny.toLong() else System.currentTimeMillis(),
        )
    }

    /**
     * 每个请求恰好调用一次（成功 / 上游错误 / 客户端断开 都要记）。
     * 参数名与 Node 版相同（snake_case），now 为毫秒时间戳。
     */
    @Suppress("FunctionParameterNaming", "LocalVariableName")
    @JvmOverloads
    @Synchronized
    fun recordRequest(
        email: String?,
        model: String?,
        latency_ms: Number?,
        status: Int = 200,
        input_tokens: Number = 0,
        output_tokens: Number = 0,
        cached_tokens: Number = 0,
        thoughts_tokens: Number = 0,
        ttft_ms: Number? = null,
        is_stream: Boolean = false,
        error: String? = null,
        timing: JSONObject? = null,
        model_used: String? = null,
        downgraded: Boolean = false,
        downgrade_reason: String? = null,
        now: Long = System.currentTimeMillis(),
    ) {
        val (key, bucket) = bucketOf(email)
        val inp = Math.max(0L, Stats.numL(input_tokens))
        val cac = Math.max(0L, Stats.numL(cached_tokens))
        val out = Math.max(0L, Stats.numL(output_tokens))
        val thk = Math.max(0L, Stats.numL(thoughts_tokens))
        val tot = inp + cac + out
        val ok = Stats.isOk(status)
        val lat = Math.max(0L, Math.round(Stats.num(latency_ms)))
        val ttftValid = ttft_ms != null && Stats.num(ttft_ms) >= 0
        val ttft = if (ttft_ms != null) Math.round(Stats.num(ttft_ms)) else 0L

        bucket.totalRequests++
        if (ok) bucket.successRequests++ else bucket.errorRequests++
        bucket.inputTokens += inp; bucket.cachedTokens += cac; bucket.outputTokens += out; bucket.thoughtsTokens += thk
        bucket.totalTokens = bucket.inputTokens + bucket.cachedTokens + bucket.outputTokens
        if (ok && lat > 0) { bucket.latencySumMs += lat; bucket.latencyCount++ }
        if (ok && ttftValid) { bucket.ttftSumMs += ttft; bucket.ttftCount++ }

        val targetModel = model_used ?: model ?: "unknown"
        fun addSlot(map: TreeMap<String, Slot>, k: String) {
            val s = map.getOrPut(k) { Slot() }
            s.requests++
            if (!ok) s.errors++
            s.input += inp; s.cached += cac; s.output += out; s.tokens += tot; s.thoughts += thk
            if (ok && lat > 0) { s.latSum += lat; s.latN++ }
            if (ok && ttftValid) { s.ttftSum += ttft; s.ttftN++ }
            val m = s.model(targetModel)
            m.requests++
            if (!ok) m.errors++
            m.input += inp; m.cached += cac; m.output += out; m.thoughts += thk; m.tokens += tot
        }
        addSlot(bucket.minutely, Stats.utcMinuteKey(now))
        addSlot(bucket.hourly, Stats.utcHourKey(now))
        addSlot(bucket.daily, Stats.utcDayKey(now))
        prune(bucket, now)

        val log = JSONObject()
            .put("id", now.toString() + "_" + randomId())
            .put("time", isoUtc(now))
            .put("timestamp", now)
            .put("model", model ?: JSONObject.NULL)
            .put("latency_ms", lat)
            .put("ttft_ms", if (ttft_ms == null) JSONObject.NULL else ttft)
            .put("status", status)
            .put("tokens", JSONObject().put("input", inp).put("cached", cac).put("output", out).put("thoughts", thk).put("total", tot))
            .put("cache_hit_rate", Stats.hitRate(inp, cac))
            .put("is_stream", is_stream)
            .put("error", error ?: JSONObject.NULL)
        if (timing != null) log.put("timing", Stats.cleanTiming(timing))
        if (!model_used.isNullOrEmpty()) log.put("model_used", model_used.take(80))
        if (downgraded) {
            log.put("downgraded", true)
            log.put("downgrade_reason", if (downgrade_reason.isNullOrEmpty()) JSONObject.NULL else downgrade_reason.take(40))
            bucket.downgrades.addLast(Downgrade(now, model, model_used, downgrade_reason?.ifEmpty { null } ?: "unknown"))
        }
        pushLog(LogEntry(key, log))
        lastRequestAt = Math.max(lastRequestAt, now)
        save()
    }

    private fun pushLog(e: LogEntry) {
        logs.addFirst(e)
        // 单账号上限
        var count = 0
        val it = logs.iterator()
        while (it.hasNext()) {
            val x = it.next()
            if (x.email == e.email && ++count > maxLogsPerUser) it.remove()
        }
        while (logs.size > logCapacity) logs.removeLast()
    }

    private fun randomId(): String {
        val chars = "0123456789abcdefghijklmnopqrstuvwxyz"
        val r = java.util.concurrent.ThreadLocalRandom.current()
        val sb = StringBuilder(4)
        repeat(4) { sb.append(chars[r.nextInt(36)]) }
        return sb.toString()
    }

    private fun isoUtc(ms: Long): String {
        val f = SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss.SSS'Z'", Locale.ROOT)
        f.timeZone = TimeZone.getTimeZone("UTC")
        return f.format(Date(ms))
    }

    /** 按时间修剪：分钟桶 120m，小时桶 48h，日桶 92 天；降级记录 48h 且最多 1000 条。 */
    private fun prune(bucket: Bucket, now: Long) {
        val mCut = now - Stats.MINUTELY_KEEP_MS
        bucket.minutely.entries.removeIf { val t = Stats.keyToMs(it.key); t == null || t < mCut }
        val hCut = now - Stats.HOURLY_KEEP_MS
        bucket.hourly.entries.removeIf { val t = Stats.keyToMs(it.key); t == null || t < hCut }
        bucket.downgrades.removeIf { it.ts < hCut }
        while (bucket.downgrades.size > 1000) bucket.downgrades.removeFirst()
        val dCut = Stats.utcDayKey(now - Stats.DAILY_KEEP_DAYS * 86400000L)
        bucket.daily.headMap(dCut, false).clear()
    }

    private fun summarize(b: Bucket, now: Long = System.currentTimeMillis()): JSONObject {
        val last24 = Slot()
        val cut = now - 24 * 3600 * 1000L
        for ((k, v) in b.hourly) {
            val t = Stats.keyToMs(k) ?: continue
            if (t + 3600 * 1000 > cut) last24.addFields(v)
        }
        val l24 = last24.toJson(true).put("cache_hit_rate", Stats.hitRate(last24.input, last24.cached))
        return JSONObject()
            .put("total_requests", b.totalRequests)
            .put("success_requests", b.successRequests)
            .put("error_requests", b.errorRequests)
            .put("total_tokens", b.inputTokens + b.cachedTokens + b.outputTokens)
            .put("input_tokens", b.inputTokens)
            .put("cached_tokens", b.cachedTokens)
            .put("output_tokens", b.outputTokens)
            .put("thoughts_tokens", b.thoughtsTokens)
            .put("prompt_tokens", b.inputTokens + b.cachedTokens)
            .put("cache_hit_rate", Stats.hitRate(b.inputTokens, b.cachedTokens))
            .put("avg_latency_ms", b.avgLatency())
            .put("avg_ttft_ms", if (b.ttftCount > 0) b.avgTtft() else JSONObject.NULL)
            .put("latency_count", b.latencyCount)
            .put("ttft_count", b.ttftCount)
            .put("last_24h", l24)
    }

    private fun putAll(dst: JSONObject, src: JSONObject): JSONObject {
        for (k in src.keys()) dst.put(k, src.opt(k))
        return dst
    }

    /** 总览 = 各账号桶逐项求和（比率与均值由求和后的分子分母重新计算）。email 非空时返回该账号。 */
    @JvmOverloads
    @Synchronized
    fun getStats(email: String? = null): JSONObject {
        if (!email.isNullOrEmpty()) return getUserStats(email)
        val agg = Bucket()
        val accounts = ArrayList<JSONObject>()
        for ((key, b) in userStats) {
            agg.totalRequests += b.totalRequests; agg.successRequests += b.successRequests; agg.errorRequests += b.errorRequests
            agg.inputTokens += b.inputTokens; agg.cachedTokens += b.cachedTokens; agg.outputTokens += b.outputTokens
            agg.thoughtsTokens += b.thoughtsTokens; agg.latencySumMs += b.latencySumMs; agg.latencyCount += b.latencyCount
            agg.ttftSumMs += b.ttftSumMs; agg.ttftCount += b.ttftCount
            for ((k, v) in b.hourly) {
                val s = agg.hourly.getOrPut(k) { Slot() }
                s.addFields(v)
                s.addModels(v)
            }
            accounts.add(putAll(JSONObject().put("email", key), summarize(b)))
        }
        accounts.sortWith(Comparator { a, c ->
            val d = c.optLong("total_tokens").compareTo(a.optLong("total_tokens"))
            if (d != 0) d else c.optLong("total_requests").compareTo(a.optLong("total_requests"))
        })
        val out = summarize(agg)
        out.put("today", todaySummary())
        out.put("timing_recent", getTimingSummary(20))
        out.put("downgrade_24h", downgradeSummary(agg.hourly, System.currentTimeMillis()))
        out.put("accounts", JSONArray(accounts))
        out.put("schema", Stats.STATS_SCHEMA)
        out.put("legacy_data", userStats.values.any { it.migratedFromV1 })
        return out
    }

    @Synchronized
    fun getUserStats(email: String?): JSONObject {
        val (key, bucket) = bucketOf(email)
        return putAll(JSONObject().put("email", key), summarize(bucket))
    }

    private fun pointJson(key: String, ts: Long, slot: Slot?): JSONObject {
        val o = JSONObject().put("key", key).put("ts", ts)
        return putAll(o, (slot ?: Slot()).toJson(true))
    }

    /** 趋势数据（按账号隔离），mode '24h' | '7d'。返回每个桶的起始 UTC 毫秒 ts。 */
    @JvmOverloads
    @Synchronized
    fun getTrendData(email: String?, mode: String = "24h"): JSONObject {
        val (_, bucket) = bucketOf(email)
        val now = System.currentTimeMillis()
        val points = JSONArray()
        val labels = JSONArray(); val tokens = JSONArray(); val requests = JSONArray()
        if (mode == "7d") {
            for (i in 6 downTo 0) {
                val k = Stats.utcDayKey(now - i * 86400000L)
                val s = bucket.daily[k]
                points.put(pointJson(k, Stats.dayStartMs(k), s))
                labels.put(k); tokens.put(s?.tokens ?: 0L); requests.put(s?.requests ?: 0L)
            }
        } else {
            for (i in 23 downTo 0) {
                val k = Stats.utcHourKey(now - i * 3600000L)
                val s = bucket.hourly[k]
                points.put(pointJson(k, Stats.keyToMs(k) ?: 0L, s))
                labels.put(k); tokens.put(s?.tokens ?: 0L); requests.put(s?.requests ?: 0L)
            }
        }
        return JSONObject().put("mode", mode).put("timezone", "UTC").put("points", points)
            .put("labels", labels).put("tokens", tokens).put("requests", requests)
    }

    /** 手机本地日 0 点至今（按小时桶累加）。 */
    @JvmOverloads
    @Synchronized
    fun todaySummary(now: Long = System.currentTimeMillis()): JSONObject {
        val c = Calendar.getInstance()
        c.timeInMillis = now
        c.set(Calendar.HOUR_OF_DAY, 0); c.set(Calendar.MINUTE, 0); c.set(Calendar.SECOND, 0); c.set(Calendar.MILLISECOND, 0)
        val mid = c.timeInMillis
        val t = Slot()
        for (b in userStats.values) {
            for ((k, v) in b.hourly) {
                val ms = Stats.keyToMs(k) ?: continue
                if (ms + 3600 * 1000 <= mid) continue
                t.addFields(v)
            }
        }
        return JSONObject()
            .put("total_requests", t.requests)
            .put("success_requests", t.requests - t.errors)
            .put("error_requests", t.errors)
            .put("input_tokens", t.input)
            .put("cached_tokens", t.cached)
            .put("output_tokens", t.output)
            .put("thoughts_tokens", t.thoughts)
            .put("total_tokens", t.input + t.cached + t.output)
            .put("cache_hit_rate", Stats.hitRate(t.input, t.cached))
            .put("avg_latency_ms", if (t.latN > 0) Math.round(t.latSum.toDouble() / t.latN) else 0L)
            .put("avg_ttft_ms", if (t.ttftN > 0) Math.round(t.ttftSum.toDouble() / t.ttftN) else JSONObject.NULL)
    }

    /** 所有账号合计的 24 小时趋势（UTC 整点，ts 为毫秒）——/api/trend。 */
    @Synchronized
    fun getAggregateTrend(): JSONObject {
        val now = System.currentTimeMillis()
        val points = JSONArray()
        for (i in 23 downTo 0) {
            val k = Stats.utcHourKey(now - i * 3600000L)
            val p = Slot()
            for (b in userStats.values) b.hourly[k]?.let { p.addFields(it) }
            points.put(JSONObject().put("key", k).put("ts", Stats.keyToMs(k) ?: 0L).let { putAll(it, p.toJson(true)) })
        }
        return JSONObject().put("mode", "24h").put("timezone", "UTC").put("points", points)
    }

    /** 近 7 天用量（UTC 日）。 */
    @Synchronized
    fun getUserWeekUsage(email: String?): JSONObject {
        val (_, bucket) = bucketOf(email)
        val now = System.currentTimeMillis()
        var requests = 0L; var tokens = 0L
        for (i in 0 until 7) {
            bucket.daily[Stats.utcDayKey(now - i * 86400000L)]?.let { requests += it.requests; tokens += it.tokens }
        }
        val today = bucket.daily[Stats.utcDayKey(now)]
        return JSONObject().put("requests_7d", requests).put("tokens_7d", tokens)
            .put("requests_today", today?.requests ?: 0L).put("tokens_today", today?.tokens ?: 0L)
    }

    private class Interval(val ts: Long, val keys: List<String>, val mapName: String)

    /** Token 消费统计：range = hour|day|week|month|all——/api/token-stats。 */
    @JvmOverloads
    @Synchronized
    fun getTokenStats(range: String? = "day", now: Long = System.currentTimeMillis()): JSONObject {
        val r = if (range in setOf("hour", "day", "week", "month", "all")) range!! else "day"
        val nowMs = now

        // 1. 91 天全账号日热力图
        val heatmap = JSONArray()
        val todayMid = Stats.dayStartMs(Stats.utcDayKey(nowMs))
        for (i in 90 downTo 0) {
            val dayKey = Stats.utcDayKey(todayMid - i * 86400000L)
            var dt = 0L; var dr = 0L
            for (b in userStats.values) b.daily[dayKey]?.let { dt += it.tokens; dr += it.requests }
            heatmap.put(JSONObject().put("day", dayKey).put("tokens", dt).put("requests", dr))
        }

        // 2. 时间区间
        val intervals = ArrayList<Interval>()
        when (r) {
            "hour" -> {
                val cur = Math.floorDiv(nowMs, 300000L) * 300000L
                for (i in 11 downTo 0) {
                    val ts = cur - i * 300000L
                    intervals.add(Interval(ts, (0 until 5).map { Stats.utcMinuteKey(ts + it * 60000L) }, "minutely"))
                }
            }
            "day" -> {
                val cur = Math.floorDiv(nowMs, 3600000L) * 3600000L
                for (i in 23 downTo 0) { val ts = cur - i * 3600000L; intervals.add(Interval(ts, listOf(Stats.utcHourKey(ts)), "hourly")) }
            }
            "week", "month" -> {
                val todayStart = Stats.dayStartMs(Stats.utcDayKey(nowMs))
                val n = if (r == "week") 6 else 29
                for (i in n downTo 0) { val ts = todayStart - i * 86400000L; intervals.add(Interval(ts, listOf(Stats.utcDayKey(ts)), "daily")) }
            }
            else -> {
                val days = java.util.TreeSet<String>()
                for (b in userStats.values) days.addAll(b.daily.keys)
                val all = days.toList().takeLast(92)
                for (k in all) intervals.add(Interval(Stats.dayStartMs(k), listOf(k), "daily"))
            }
        }

        // 3/4. 聚合
        val series = Array(intervals.size) { ModelAgg() }
        val allModels = LinkedHashMap<String, ModelAgg>()
        class Acc(val email: String) { val t = ModelAgg(); val models = LinkedHashMap<String, ModelAgg>() }
        val accounts = ArrayList<Acc>()
        var wLatSum = 0L; var wLatN = 0L; var wTtftSum = 0L; var wTtftN = 0L

        for ((email, b) in userStats) {
            val acc = Acc(email)
            for ((idx, iv) in intervals.withIndex()) {
                val map = b.map(iv.mapName) ?: continue
                val point = series[idx]
                for (k in iv.keys) {
                    val slot = map[k] ?: continue
                    val tok = if (slot.tokens != 0L) slot.tokens else slot.input + slot.cached + slot.output
                    for (target in arrayOf(acc.t, point)) {
                        target.requests += slot.requests; target.errors += slot.errors; target.input += slot.input
                        target.cached += slot.cached; target.output += slot.output; target.thoughts += slot.thoughts; target.tokens += tok
                    }
                    if (slot.latN > 0) { wLatSum += slot.latSum; wLatN += slot.latN }
                    if (slot.ttftN > 0) { wTtftSum += slot.ttftSum; wTtftN += slot.ttftN }
                    slot.models?.forEach { (mName, md) ->
                        acc.models.getOrPut(mName) { ModelAgg() }.add(md)
                        allModels.getOrPut(mName) { ModelAgg() }.add(md)
                    }
                }
            }
            if (r == "all") {
                acc.t.requests = b.totalRequests; acc.t.errors = b.errorRequests; acc.t.input = b.inputTokens
                acc.t.cached = b.cachedTokens; acc.t.output = b.outputTokens; acc.t.thoughts = b.thoughtsTokens
                acc.t.tokens = if (b.totalTokens != 0L) b.totalTokens else acc.t.input + acc.t.cached + acc.t.output
            }
            accounts.add(acc)
        }

        // 5. summary
        val summary: JSONObject
        if (r == "all") {
            val t = ModelAgg(); var succ = 0L
            var latS = 0L; var latN = 0L; var tS = 0L; var tN = 0L
            for (b in userStats.values) {
                t.requests += b.totalRequests; succ += b.successRequests; t.errors += b.errorRequests
                t.input += b.inputTokens; t.cached += b.cachedTokens; t.output += b.outputTokens; t.thoughts += b.thoughtsTokens
                t.tokens += if (b.totalTokens != 0L) b.totalTokens else b.inputTokens + b.cachedTokens + b.outputTokens
                latS += b.latencySumMs; latN += b.latencyCount; tS += b.ttftSumMs; tN += b.ttftCount
            }
            summary = JSONObject().put("requests", t.requests).put("success", succ).put("errors", t.errors)
                .put("input", t.input).put("cached", t.cached).put("output", t.output).put("thoughts", t.thoughts).put("tokens", t.tokens)
                .put("cache_hit_rate", Stats.hitRate(t.input, t.cached))
                .put("avg_latency_ms", if (latN > 0) Math.round(latS.toDouble() / latN) else 0L)
                .put("avg_ttft_ms", if (tN > 0) Math.round(tS.toDouble() / tN) else JSONObject.NULL)
        } else {
            val w = ModelAgg()
            for (p in series) w.add(p)
            summary = JSONObject().put("requests", w.requests).put("success", Math.max(0L, w.requests - w.errors)).put("errors", w.errors)
                .put("input", w.input).put("cached", w.cached).put("output", w.output).put("thoughts", w.thoughts).put("tokens", w.tokens)
                .put("cache_hit_rate", Stats.hitRate(w.input, w.cached))
                .put("avg_latency_ms", if (wLatN > 0) Math.round(wLatSum.toDouble() / wLatN) else 0L)
                .put("avg_ttft_ms", if (wTtftN > 0) Math.round(wTtftSum.toDouble() / wTtftN) else JSONObject.NULL)
        }
        val totalTokens = summary.optLong("tokens")
        fun share(t: Long): Double = if (totalTokens > 0) Math.round(t.toDouble() / totalTokens * 10000) / 10000.0 else 0.0

        // 6. 模型
        val modelsList = allModels.entries.filter { it.value.requests > 0 || it.value.tokens > 0 }
            .sortedWith(Comparator { a, b -> val d = b.value.tokens.compareTo(a.value.tokens); if (d != 0) d else b.value.requests.compareTo(a.value.requests) })
            .map { (name, m) -> m.toJson().put("model", name).put("share", Stats.jn(share(m.tokens))) }

        // 7. 账号
        val accountsList = accounts.filter { it.t.requests > 0 || it.t.tokens > 0 }.map { acc ->
            var top: String? = null; var maxT = -1L; var maxR = -1L
            for ((mName, md) in acc.models) {
                if (md.tokens > maxT || (md.tokens == maxT && md.requests > maxR)) { maxT = md.tokens; maxR = md.requests; top = mName }
            }
            acc.t.toJson().put("email", acc.email).put("share", Stats.jn(share(acc.t.tokens)))
                .put("cache_hit_rate", Stats.hitRate(acc.t.input, acc.t.cached)).put("top_model", top ?: JSONObject.NULL)
        }.sortedWith(Comparator { a, b -> val d = b.optLong("tokens").compareTo(a.optLong("tokens")); if (d != 0) d else b.optLong("requests").compareTo(a.optLong("requests")) })

        summary.put("active_accounts", accountsList.size)
        summary.put("active_models", modelsList.size)

        // 8. 峰值
        var peak: JSONObject? = null
        val seriesJson = JSONArray()
        for ((i, p) in series.withIndex()) {
            val ts = intervals[i].ts
            seriesJson.put(JSONObject().put("ts", ts).put("requests", p.requests).put("errors", p.errors).put("input", p.input)
                .put("cached", p.cached).put("output", p.output).put("thoughts", p.thoughts).put("tokens", p.tokens))
            if (p.tokens > 0 || p.requests > 0) {
                val pk = peak
                if (pk == null || p.tokens > pk.optLong("tokens") || (p.tokens == pk.optLong("tokens") && p.requests > pk.optLong("requests"))) {
                    peak = JSONObject().put("ts", ts).put("tokens", p.tokens).put("requests", p.requests)
                }
            }
        }

        return JSONObject().put("range", r).put("timezone", "UTC").put("generated_at", nowMs)
            .put("summary", summary).put("series", seriesJson)
            .put("models", JSONArray(modelsList)).put("accounts", JSONArray(accountsList))
            .put("peak", peak ?: JSONObject.NULL).put("heatmap", heatmap)
    }

    /** 最近 n 条（默认 20，1~100）成功请求的分段耗时中位数，全账号合并——/api/stats/timing。 */
    @JvmOverloads
    @Synchronized
    fun getTimingSummary(n: Int = 20): JSONObject {
        val lim = Math.max(1, Math.min(100, n))
        val picked = ArrayList<JSONObject>()
        for (e in logs) { // 已按时间倒序
            if (picked.size >= lim) break
            val l = e.json
            if (l.optJSONObject("timing") != null && Stats.isOk(Stats.num(l.opt("status")).toInt())) picked.add(l)
        }
        val out = JSONObject().put("n", picked.size)
        fun med(f: (JSONObject) -> Any?): Any = Stats.median(picked.map(f))?.let { Stats.jn(it) } ?: JSONObject.NULL
        for (f in Stats.TIMING_MS_FIELDS) out.put(f, med { it.getJSONObject("timing").opt(f) })
        out.put("ttft_ms", med { it.opt("ttft_ms") })
        out.put("latency_ms", med { it.opt("latency_ms") })
        out.put("attempts", med { it.getJSONObject("timing").opt("attempts") })
        out.put("cached_tokens", med { it.optJSONObject("tokens")?.opt("cached") })
        out.put("input_tokens", med { it.optJSONObject("tokens")?.opt("input") })
        out.put("cache_hit_rate", med { it.opt("cache_hit_rate") })
        val hosts = JSONObject()
        var swA = 0; var swH = 0; var reused = 0; var fresh = 0
        for (l in picked) {
            val t = l.getJSONObject("timing")
            val h = t.opt("host")
            if (h is String && h.isNotEmpty()) hosts.put(h, hosts.optInt(h, 0) + 1)
            if (Stats.truthy(t.opt("switched_account"))) swA++
            if (Stats.truthy(t.opt("switched_host"))) swH++
            val cr = t.opt("conn_reused")
            if (cr == true) reused++ else if (cr == false) fresh++
        }
        out.put("hosts", hosts).put("switched_account", swA).put("switched_host", swH).put("conn_reused", reused).put("conn_new", fresh)
        return out
    }

    private fun downgradeSummary(hourly: Map<String, Slot>?, now: Long): JSONObject {
        val cut = now - 24 * 3600 * 1000L
        var count = 0L; var requests = 0L
        val reasons = JSONObject(); val models = JSONObject()
        for (b in userStats.values) {
            for (d in b.downgrades) {
                if (d.ts < cut) continue
                count++
                reasons.put(d.reason, reasons.optLong(d.reason, 0) + 1)
                if (!d.to.isNullOrEmpty()) models.put(d.to, models.optLong(d.to, 0) + 1)
            }
        }
        if (hourly != null) for ((k, v) in hourly) { val t = Stats.keyToMs(k) ?: continue; if (t + 3600 * 1000 > cut) requests += v.requests }
        return JSONObject().put("count", count).put("requests", requests)
            .put("rate", if (requests > 0) Stats.jn(Math.round(count.toDouble() / requests * 10000) / 10000.0) else JSONObject.NULL)
            .put("reasons", reasons).put("models", models)
    }

    /** 最近 24 小时降级统计（agg = 是否计算分母；传 true 时按全部账号小时桶求同期请求数）。 */
    @JvmOverloads
    @Synchronized
    fun getDowngradeSummary(withRequests: Boolean = true, now: Long = System.currentTimeMillis()): JSONObject {
        if (!withRequests) return downgradeSummary(null, now)
        val agg = HashMap<String, Slot>()
        for (b in userStats.values) for ((k, v) in b.hourly) agg.getOrPut(k) { Slot() }.addFields(v)
        return downgradeSummary(agg, now)
    }

    @Synchronized
    fun getUserLogs(email: String?): JSONArray {
        val key = keyOf(email)
        userStats.getOrPut(key) { Bucket() }
        val a = JSONArray()
        for (e in logs) if (e.email == key) a.put(JSONObject(e.json.toString()))
        return a
    }

    /** 全部账号明细，按时间倒序，每条带 email——/api/logs。 */
    @JvmOverloads
    @Synchronized
    fun getAllLogs(limit: Int = 100): JSONArray {
        val a = JSONArray()
        for (e in logs) {
            if (a.length() >= limit) break
            a.put(JSONObject(e.json.toString()).put("email", e.email))
        }
        return a
    }

    @Synchronized
    fun clearAllLogs() {
        logs.clear()
        save()
    }

    /** 彻底重置所有用量统计与历史数据。 */
    @Synchronized
    fun resetStats() {
        userStats.clear()
        logs.clear()
        dirty = true
        flush()
    }

    @Synchronized
    fun clearUserLogs(email: String?) {
        val key = keyOf(email)
        userStats.getOrPut(key) { Bucket() }
        logs.removeIf { it.email == key }
        save()
    }
}
