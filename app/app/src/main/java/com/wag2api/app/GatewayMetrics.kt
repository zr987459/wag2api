package com.wag2api.app

import android.content.Context
import android.content.SharedPreferences
import org.json.JSONArray
import org.json.JSONObject
import java.text.SimpleDateFormat
import java.util.*
import java.util.concurrent.ConcurrentLinkedDeque

/**
 * WB 引擎统计。记账口径与 AG 引擎（src/stats.mjs）保持一致，方便同一界面并排显示：
 *   input_tokens   未命中缓存的输入（prompt - cached）
 *   cached_tokens  命中缓存的输入（prompt_tokens_details.cached_tokens / prompt_cache_hit_tokens）
 *   output_tokens  输出（含思考）
 *   thoughts_tokens 思考 token 明细（completion_tokens_details.reasoning_tokens）
 *   total_tokens   = input + cached + output
 *   cache_hit_rate = cached / (input + cached)
 * 小时桶以 UTC 毫秒整点为 key，保留 48 小时；"今日"按手机本地日期滚动。
 */
object GatewayMetrics {

    /** 一次请求的用量明细 */
    data class Usage(
        val input: Int = 0,
        val cached: Int = 0,
        val output: Int = 0,
        val thoughts: Int = 0
    ) {
        val total: Int get() = input + cached + output

        companion object {
            /** 从 OpenAI 风格 usage 解析；prompt 包含 cached，这里拆开 */
            fun fromOpenAi(u: JSONObject?): Usage? {
                if (u == null) return null
                val prompt = u.optInt("prompt_tokens", -1)
                val comp = u.optInt("completion_tokens", -1)
                if (prompt < 0 && comp < 0) return null
                val cached = u.optJSONObject("prompt_tokens_details")?.optInt("cached_tokens", 0)
                    ?.takeIf { it > 0 } ?: u.optInt("prompt_cache_hit_tokens", 0)
                val thoughts = u.optJSONObject("completion_tokens_details")?.optInt("reasoning_tokens", 0) ?: 0
                val p = maxOf(0, prompt)
                val c = minOf(maxOf(0, cached), p)
                return Usage(p - c, c, maxOf(0, comp), maxOf(0, thoughts))
            }
        }
    }

    private const val PREF_NAME = "workbuddy_metrics"
    private const val KEY_LAST_DATE = "last_date"
    private const val KEY_TODAY = "today_v2"
    private const val KEY_TOTAL = "total_v2"
    private const val KEY_HOURLY = "hourly_v2"
    private const val MAX_LOGS = 150
    private const val HOUR_MS = 3_600_000L
    private const val KEEP_HOURS = 48

    private lateinit var prefs: SharedPreferences
    private val timeFormat = SimpleDateFormat("HH:mm:ss", Locale.getDefault())
    private val dateFormat = SimpleDateFormat("yyyy-MM-dd", Locale.getDefault())

    /** 累计桶：today 每天清零，total 只在手动重置时清零 */
    private class Bucket {
        var requests = 0; var success = 0; var errors = 0
        var input = 0L; var cached = 0L; var output = 0L; var thoughts = 0L
        var latSum = 0L; var latCount = 0; var ttftSum = 0L; var ttftCount = 0

        fun add(ok: Boolean, u: Usage, lat: Long, ttft: Long?) {
            requests++
            if (ok) success++ else errors++
            input += u.input; cached += u.cached; output += u.output; thoughts += u.thoughts
            if (ok && lat > 0) { latSum += lat; latCount++ }
            if (ok && ttft != null && ttft >= 0) { ttftSum += ttft; ttftCount++ }
        }

        fun toJson(): JSONObject = JSONObject().apply {
            put("requests", requests); put("success", success); put("errors", errors)
            put("input", input); put("cached", cached); put("output", output); put("thoughts", thoughts)
            put("latSum", latSum); put("latCount", latCount); put("ttftSum", ttftSum); put("ttftCount", ttftCount)
        }

        /** 与 AG summarize() 同名字段 */
        fun summary(): JSONObject = JSONObject().apply {
            put("total_requests", requests)
            put("success_requests", success)
            put("error_requests", errors)
            put("input_tokens", input)
            put("cached_tokens", cached)
            put("output_tokens", output)
            put("thoughts_tokens", thoughts)
            put("total_tokens", input + cached + output)
            put("prompt_tokens", input + cached)
            val den = input + cached
            put("cache_hit_rate", if (den > 0) cached.toDouble() / den else JSONObject.NULL)
            put("avg_latency_ms", if (latCount > 0) latSum / latCount else 0)
            put("avg_ttft_ms", if (ttftCount > 0) ttftSum / ttftCount else JSONObject.NULL)
        }

        companion object {
            fun from(j: JSONObject?): Bucket = Bucket().apply {
                if (j == null) return@apply
                requests = j.optInt("requests"); success = j.optInt("success"); errors = j.optInt("errors")
                input = j.optLong("input"); cached = j.optLong("cached"); output = j.optLong("output")
                thoughts = j.optLong("thoughts")
                latSum = j.optLong("latSum"); latCount = j.optInt("latCount")
                ttftSum = j.optLong("ttftSum"); ttftCount = j.optInt("ttftCount")
            }
        }
    }

    private class Slot { var requests = 0; var errors = 0; var input = 0L; var cached = 0L; var output = 0L }

    private var today = Bucket()
    private var total = Bucket()
    private val hourly = TreeMap<Long, Slot>()
    private val logs = ConcurrentLinkedDeque<JSONObject>()

    fun init(context: Context) {
        prefs = context.getSharedPreferences(PREF_NAME, Context.MODE_PRIVATE)
        synchronized(this) {
            val td = dateFormat.format(Date())
            today = if (prefs.getString(KEY_LAST_DATE, "") == td) Bucket.from(parse(prefs.getString(KEY_TODAY, null)))
            else Bucket()
            // 旧版只有两个整数，迁移过来，至少"今日请求 / Token"不归零
            if (today.requests == 0 && prefs.getString(KEY_LAST_DATE, "") == td) {
                val oldReq = prefs.getInt("today_req", 0)
                val oldTok = prefs.getInt("today_tokens", 0)
                if (oldReq > 0) { today.requests = oldReq; today.success = oldReq; today.output = oldTok.toLong() }
            }
            total = Bucket.from(parse(prefs.getString(KEY_TOTAL, null)))
            hourly.clear()
            parse(prefs.getString(KEY_HOURLY, null))?.let { h ->
                for (k in h.keys()) {
                    val o = h.optJSONObject(k) ?: continue
                    hourly[k.toLong()] = Slot().apply {
                        requests = o.optInt("r"); errors = o.optInt("e")
                        input = o.optLong("i"); cached = o.optLong("c"); output = o.optLong("o")
                    }
                }
            }
            prefs.edit().putString(KEY_LAST_DATE, td).apply()
        }
    }

    private fun parse(s: String?): JSONObject? = try { if (s.isNullOrEmpty()) null else JSONObject(s) } catch (e: Exception) { null }

    @Synchronized
    private fun checkDateRollover() {
        if (!::prefs.isInitialized) return
        val td = dateFormat.format(Date())
        if (prefs.getString(KEY_LAST_DATE, "") != td) {
            today = Bucket()
            prefs.edit().putString(KEY_LAST_DATE, td).putString(KEY_TODAY, today.toJson().toString()).apply()
        }
    }

    fun getTodayRequests(): Int { checkDateRollover(); return today.requests }

    fun getTodayTokens(): Int { checkDateRollover(); return (today.input + today.cached + today.output).toInt() }

    /** 旧调用方式：只有总数时按输出计 */
    fun record(
        method: String, path: String, model: String, endpoint: String,
        status: Int, tokens: Int, latencyMs: Long, note: String? = null,
        uid: String = "", nickname: String = ""
    ) = record(method, path, model, endpoint, status, Usage(output = maxOf(0, tokens)), latencyMs, null, note, uid, nickname)

    @Synchronized
    fun record(
        method: String, path: String, model: String, endpoint: String,
        status: Int, usage: Usage?, latencyMs: Long, ttftMs: Long? = null, note: String? = null,
        uid: String = "", nickname: String = ""
    ) {
        checkDateRollover()
        val u = usage ?: Usage()
        val ok = status in 200..299
        today.add(ok, u, latencyMs, ttftMs)
        total.add(ok, u, latencyMs, ttftMs)

        val nowMs = System.currentTimeMillis()
        val hk = nowMs - nowMs % HOUR_MS
        val s = hourly.getOrPut(hk) { Slot() }
        s.requests++; if (!ok) s.errors++
        s.input += u.input; s.cached += u.cached; s.output += u.output
        while (hourly.isNotEmpty() && hourly.firstKey() < hk - KEEP_HOURS * HOUR_MS) hourly.pollFirstEntry()

        if (::prefs.isInitialized) {
            val h = JSONObject()
            for ((k, v) in hourly) h.put(k.toString(), JSONObject().put("r", v.requests).put("e", v.errors)
                .put("i", v.input).put("c", v.cached).put("o", v.output))
            prefs.edit()
                .putString(KEY_TODAY, today.toJson().toString())
                .putString(KEY_TOTAL, total.toJson().toString())
                .putString(KEY_HOURLY, h.toString())
                .apply()
        }

        val now = Date(nowMs)
        val den = u.input + u.cached
        val logItem = JSONObject().apply {
            put("id", "log_${nowMs}_${UUID.randomUUID().toString().take(6)}")
            put("time", timeFormat.format(now))
            put("timestamp", nowMs)
            put("method", method)
            put("path", path)
            put("model", model)
            // 最终实际处理这次请求的账号（没选到账号时为空字符串）
            put("uid", uid)
            put("nickname", nickname)
            put("endpoint", endpoint)
            put("is_stream", endpoint == "stream")
            put("status", status)
            put("tokens", u.total)
            put("usage", JSONObject().put("input", u.input).put("cached", u.cached)
                .put("output", u.output).put("thoughts", u.thoughts).put("total", u.total))
            put("cache_hit_rate", if (den > 0) u.cached.toDouble() / den else JSONObject.NULL)
            put("latency_ms", latencyMs)
            if (ttftMs != null) put("ttft_ms", ttftMs)
            if (!note.isNullOrBlank()) put("note", note)
        }
        logs.addFirst(logItem)
        while (logs.size > MAX_LOGS) logs.pollLast()
    }

    /** 与 AG /api/stats 同形状：总计字段 + today + last_24h + trend(24 个整点) */
    @Synchronized
    fun statsJson(): JSONObject {
        checkDateRollover()
        val nowMs = System.currentTimeMillis()
        val cur = nowMs - nowMs % HOUR_MS
        val points = JSONArray()
        val last24 = Slot()
        for (i in 23 downTo 0) {
            val k = cur - i * HOUR_MS
            val s = hourly[k] ?: Slot()
            last24.requests += s.requests; last24.errors += s.errors
            last24.input += s.input; last24.cached += s.cached; last24.output += s.output
            points.put(JSONObject().put("ts", k).put("requests", s.requests).put("errors", s.errors)
                .put("input", s.input).put("cached", s.cached).put("output", s.output)
                .put("tokens", s.input + s.cached + s.output))
        }
        val den = last24.input + last24.cached
        return total.summary().apply {
            put("ok", true)
            put("engine", "ais")
            put("today", today.summary())
            put("last_24h", JSONObject().put("requests", last24.requests).put("errors", last24.errors)
                .put("input", last24.input).put("cached", last24.cached).put("output", last24.output)
                .put("tokens", last24.input + last24.cached + last24.output)
                .put("cache_hit_rate", if (den > 0) last24.cached.toDouble() / den else JSONObject.NULL))
            put("trend", JSONObject().put("mode", "24h").put("points", points))
        }
    }

    @Synchronized
    fun resetStats() {
        today = Bucket(); total = Bucket(); hourly.clear(); logs.clear()
        if (::prefs.isInitialized) prefs.edit().remove(KEY_TODAY).remove(KEY_TOTAL).remove(KEY_HOURLY)
            .remove("today_req").remove("today_tokens").apply()
    }

    fun getLogsJson(): JSONArray {
        val arr = JSONArray()
        for (item in logs) arr.put(item)
        return arr
    }

    fun clearLogs() { logs.clear() }
}
