package com.wag2api.app.ais

import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import java.util.TimeZone
import java.util.UUID

/**
 * [beta] 账号卡片与概览统计用到的数据，字段对齐原 Go 版 AIS 接口（控制台 app.js 读取的名字）。
 * 纯 JVM 代码（只用 org.json / java.io），可以直接单测。
 */
object AisAccountInfo {
    /** account.json 读写共用一把锁（引擎与 AisWebWorker 都会写这个文件） */
    val LOCK = Any()

    const val DEFAULT_TIER = "FREE"

    fun read(dir: File): JSONObject = synchronized(LOCK) {
        try { JSONObject(File(dir, "account.json").readText(Charsets.UTF_8)) } catch (e: Exception) { JSONObject() }
    }

    /** 读-改-写，先写临时文件再改名，避免写一半被读到 */
    fun update(dir: File, edit: (JSONObject) -> Unit): JSONObject = synchronized(LOCK) {
        val m = try { JSONObject(File(dir, "account.json").readText(Charsets.UTF_8)) } catch (e: Exception) { JSONObject() }
        edit(m)
        dir.mkdirs()
        val tmp = File(dir, "account.json.tmp")
        tmp.writeText(m.toString(), Charsets.UTF_8)
        if (!tmp.renameTo(File(dir, "account.json"))) {
            File(dir, "account.json").writeText(m.toString(), Charsets.UTF_8)
            tmp.delete()
        }
        m
    }

    fun modelIds(meta: JSONObject): List<String> {
        val a = meta.optJSONArray("models") ?: return emptyList()
        return (0 until a.length()).mapNotNull { a.optString(it, "").takeIf { s -> s.isNotEmpty() } }
    }

    fun tier(meta: JSONObject): String? = meta.optString("benefit_tier", "").takeIf { it.isNotEmpty() }

    data class Change(val previousModels: Int, val models: Int, val previousTier: String?, val tier: String, val refreshedAt: Long)

    /**
     * 测试/刷新/初始化成功后写回：模型列表、模型数、权益、更新时间。
     * 权益：WebView 版目前没有读取 AI Studio 付费档位的接口，已记录的值保留，否则记为 FREE。
     */
    fun applyRefresh(meta: JSONObject, models: List<String>, nowMs: Long, email: String? = null): Change {
        val prevModels = modelIds(meta).size
        val prevTier = tier(meta)
        val tier = prevTier ?: DEFAULT_TIER
        meta.put("models", JSONArray(models))
        meta.put("model_count", models.size)
        meta.put("benefit_tier", tier)
        meta.put("refreshed_at", nowMs)
        meta.remove("last_error")
        if (!email.isNullOrEmpty()) meta.put("email", email)
        return Change(prevModels, models.size, prevTier, tier, nowMs)
    }

    fun iso(ms: Long): String = SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss.SSS'Z'", Locale.US).apply { timeZone = TimeZone.getTimeZone("UTC") }.format(Date(ms))

    /**
     * 账号 JSON 里与卡片展示有关的字段（Go 版同名）：models（模型 ID 数组）、model_count、benefit_tier / tier、
     * refreshed_at / updated_at（ISO）、refreshed_at_ms、egress、locale、timezone、last_error。
     * [liveModels] 是当前 WebView 内存里的模型表，比持久化的新时优先。
     */
    fun putCardFields(out: JSONObject, meta: JSONObject, liveModels: List<String>, defaultLocale: String, defaultTz: String): JSONObject {
        val models = liveModels.ifEmpty { modelIds(meta) }
        val refreshed = meta.optLong("refreshed_at", 0L)
        val tier = tier(meta)
        out.put("models", JSONArray(models))
        out.put("model_count", models.size)
        out.put("benefit_tier", tier ?: (if (models.isNotEmpty()) DEFAULT_TIER else JSONObject.NULL))
        out.put("tier", tier ?: (if (models.isNotEmpty()) DEFAULT_TIER else JSONObject.NULL))
        out.put("refreshed_at", if (refreshed > 0) iso(refreshed) else JSONObject.NULL)
        out.put("updated_at", if (refreshed > 0) iso(refreshed) else JSONObject.NULL)
        out.put("refreshed_at_ms", refreshed)
        out.put("egress", meta.optString("proxy", ""))
        out.put("locale", meta.optString("locale", "").ifEmpty { defaultLocale })
        out.put("timezone", meta.optString("timezone", "").ifEmpty { defaultTz })
        out.put("last_error", meta.optString("last_error", "").ifEmpty { null } ?: JSONObject.NULL)
        return out
    }
}

/**
 * [beta] AIS 请求账本：每条请求一行 JSON，追加写 filesDir/ais/usage.jsonl，重启后仍在。
 * 记录与汇总字段对齐 Go 版 /api/usage/records、/api/usage（控制台概览统计、请求日志、账号成功率都读它）。
 */
class AisUsageLedger(private val file: File?, private val cap: Int = 10_000) {

    private val items = ArrayDeque<JSONObject>()
    private var linesOnDisk = 0

    init {
        file?.takeIf { it.isFile }?.let { f ->
            try {
                f.forEachLine(Charsets.UTF_8) { line ->
                    if (line.isBlank()) return@forEachLine
                    try { push(JSONObject(line)) } catch (_: Exception) {}
                    linesOnDisk++
                }
            } catch (_: Exception) {}
        }
    }

    private fun push(r: JSONObject) {
        if (items.size >= cap) items.removeFirst()
        items.addLast(r)
    }

    val size: Int get() = synchronized(items) { items.size }

    /**
     * 记一条。token 口径与 Go 版一致：input_tokens 不含缓存命中部分，reply_tokens 不含思考，
     * total_tokens = input + cached + reply + reasoning。
     */
    fun add(
        account: String?, model: String, status: Int, stream: Boolean, protocol: String, path: String,
        startMs: Long, endMs: Long, input: Long, cached: Long, reply: Long, reasoning: Long,
        firstEventMs: Long?, error: String?,
    ): JSONObject {
        val dur = Math.max(0L, endMs - startMs)
        val state = when {
            status in 200..299 -> "completed"
            status == 429 -> "rate_limited"
            status == 499 -> "canceled"
            else -> "failed"
        }
        val r = JSONObject()
            .put("id", UUID.randomUUID().toString().replace("-", "").take(16))
            .put("time", AisAccountInfo.iso(startMs))
            .put("time_ms", startMs)
            .put("account", account ?: "")
            .put("account_id", account ?: "")
            .put("model", model)
            .put("status", status)
            .put("state", state)
            .put("stream", stream)
            .put("protocol", protocol)
            .put("path", path)
            .put("duration_ms", dur)
            .put("latency_ms", dur)
            .put("first_event_ms", firstEventMs ?: JSONObject.NULL)
            .put("input_tokens", input)
            .put("cached_tokens", cached)
            .put("reply_tokens", reply)
            .put("reasoning_tokens", reasoning)
            .put("output_tokens", reply + reasoning)
            .put("total_tokens", input + cached + reply + reasoning)
        if (!error.isNullOrEmpty()) r.put("error", error.take(300))
        synchronized(items) {
            push(r)
            persist(r)
        }
        return r
    }

    private fun persist(r: JSONObject) {
        val f = file ?: return
        try {
            f.parentFile?.mkdirs()
            if (linesOnDisk >= cap + cap / 2) {
                // 超过上限 1.5 倍时按内存里保留的最近 cap 条重写
                val tmp = File(f.parentFile, f.name + ".tmp")
                tmp.bufferedWriter(Charsets.UTF_8).use { w -> for (x in items) { w.write(x.toString()); w.write("\n") } }
                if (!tmp.renameTo(f)) { f.writeText(items.joinToString("\n", postfix = "\n") { it.toString() }, Charsets.UTF_8); tmp.delete() }
                linesOnDisk = items.size
            } else {
                f.appendText(r.toString() + "\n", Charsets.UTF_8)
                linesOnDisk++
            }
        } catch (_: Exception) {}
    }

    fun clear() = synchronized(items) {
        items.clear()
        linesOnDisk = 0
        try { file?.delete() } catch (_: Exception) {}
    }

    private fun snapshot(fromMs: Long, toMs: Long): List<JSONObject> = synchronized(items) {
        items.filter { val t = it.optLong("time_ms", 0L); t >= fromMs && t <= toMs }
    }

    /** /api/usage/records：新的在前 */
    fun records(fromMs: Long, toMs: Long, limit: Int): JSONArray {
        val list = snapshot(fromMs, toMs).asReversed()
        return JSONArray(list.take(Math.max(1, limit)))
    }

    private class Acc {
        var requests = 0L; var succeeded = 0L; var failed = 0L; var rateLimited = 0L; var canceled = 0L
        var input = 0L; var cached = 0L; var reply = 0L; var reasoning = 0L
        var durSum = 0L; var durN = 0L; var feSum = 0L; var feN = 0L

        fun add(r: JSONObject) {
            requests++
            when (r.optString("state")) {
                "completed" -> succeeded++
                "rate_limited" -> rateLimited++
                "canceled" -> canceled++
                else -> failed++
            }
            input += r.optLong("input_tokens"); cached += r.optLong("cached_tokens")
            reply += r.optLong("reply_tokens"); reasoning += r.optLong("reasoning_tokens")
            val d = r.optLong("duration_ms", 0L); if (d > 0) { durSum += d; durN++ }
            val fe = r.optLong("first_event_ms", 0L); if (fe > 0) { feSum += fe; feN++ }
        }

        fun json(o: JSONObject = JSONObject()): JSONObject = o
            .put("requests", requests).put("succeeded", succeeded).put("failed", failed)
            .put("rate_limited", rateLimited).put("canceled", canceled)
            .put("input_tokens", input).put("cached_tokens", cached)
            .put("reply_tokens", reply).put("reasoning_tokens", reasoning)
            .put("output_tokens", reply + reasoning)
            .put("total_tokens", input + cached + reply + reasoning)
            .put("duration", JSONObject().put("avg_ms", if (durN > 0) durSum.toDouble() / durN else 0.0).put("count", durN))
            .put("first_event", JSONObject().put("avg_ms", if (feN > 0) feSum.toDouble() / feN else JSONObject.NULL).put("count", feN))
    }

    /** 桶起点：按 [tz] 的本地时间对齐（日桶对齐到当地 0 点） */
    private fun bucketStart(t: Long, bucketMs: Long, tz: TimeZone): Long {
        val off = tz.getOffset(t).toLong()
        return Math.floorDiv(t + off, bucketMs) * bucketMs - off
    }

    /** /api/usage：totals、buckets（含空桶）、groups.model / groups.account、pairs */
    fun report(fromMs: Long, toMs: Long, bucketSec: Long, tzId: String?): JSONObject {
        val tz = TimeZone.getTimeZone(tzId?.takeIf { it.isNotEmpty() } ?: "UTC")
        val list = snapshot(fromMs, toMs)
        val total = Acc()
        val byModel = LinkedHashMap<String, Acc>()
        val byAccount = LinkedHashMap<String, Acc>()
        val byPair = LinkedHashMap<Pair<String, String>, Acc>()
        val bucketMs = Math.max(60L, bucketSec) * 1000L
        val byBucket = java.util.TreeMap<Long, Acc>()
        for (r in list) {
            total.add(r)
            val model = r.optString("model", "")
            val acc = r.optString("account", "")
            byModel.getOrPut(model) { Acc() }.add(r)
            if (acc.isNotEmpty()) {
                byAccount.getOrPut(acc) { Acc() }.add(r)
                byPair.getOrPut(acc to model) { Acc() }.add(r)
            }
            byBucket.getOrPut(bucketStart(r.optLong("time_ms"), bucketMs, tz)) { Acc() }.add(r)
        }
        val buckets = JSONArray()
        val first = bucketStart(fromMs, bucketMs, tz)
        val count = ((toMs - first) / bucketMs + 1)
        if (count in 1..2000) {
            var b = first
            while (b <= toMs) { buckets.put((byBucket[b] ?: Acc()).json(JSONObject().put("at", AisAccountInfo.iso(b)))); b += bucketMs }
        } else {
            for ((b, a) in byBucket) buckets.put(a.json(JSONObject().put("at", AisAccountInfo.iso(b))))
        }
        fun group(m: Map<String, Acc>) = JSONArray(m.map { (k, a) -> a.json(JSONObject().put("key", k)) })
        val pairs = JSONArray(byPair.map { (k, a) -> a.json(JSONObject().put("account", k.first).put("model", k.second)) })
        return JSONObject()
            .put("from", AisAccountInfo.iso(fromMs)).put("to", AisAccountInfo.iso(toMs))
            .put("bucket", bucketMs / 1000).put("tz", tz.id)
            .put("totals", total.json())
            .put("buckets", buckets)
            .put("groups", JSONObject().put("model", group(byModel)).put("account", group(byAccount)))
            .put("pairs", pairs)
            .put("items", JSONArray())
    }
}
