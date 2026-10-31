package com.wag2api.app.ais

import org.json.JSONArray
import org.json.JSONObject

/**
 * GenerateContent 流式响应解码：响应正文是一个不断增长的 JSON 根数组，根下标 0 是 repeated frame。
 * 每收到一个完整 frame 就转成一块 Google streamGenerateContent 形式的 JSON
 * （{candidates:[{content:{role,parts}, finishReason}], usageMetadata}），
 * 交给 App 已有的 SseStreamer / OpenaiAgConverter 转成 Anthropic / OpenAI 流。
 *
 * 用法：feed(chunk) 返回本次新完成的 Google chunk；end() 收尾（错误体在这里抛 RpcError）。
 * 纯 JVM 代码，可 JUnit。
 */
class MakerSuiteStream(
    /** 请求带了 system instruction 时上游把 system 的 1 个 token 计入 input/total，这里减掉（与上游实现一致） */
    private val systemTokens: Int = 0,
) {
    private val buf = StringBuilder()
    private var pos = 0
    private var depth = 0
    private var inStr = false
    private var esc = false
    private var frameStart = -1
    private var rootIndex = 0          // 根数组当前元素下标（depth==1 时的逗号计数）
    private var framesSeen = 0
    private var finished = false
    /** 根数组前 64KB 原文：没有 frame 时用于解析错误体 */
    private val head = StringBuilder()
    /** 根数组下标 1 及之后的原文（流中途的错误 [code,message] 在这里） */
    private val tail = StringBuilder()

    var finishReason: String? = null
        private set
    var lastUsage: JSONObject? = null
        private set
    val frames: Int get() = framesSeen

    fun feed(chunk: String): List<JSONObject> {
        if (head.length < 65536) head.append(chunk, 0, Math.min(chunk.length, 65536 - head.length))
        buf.append(chunk)
        val out = ArrayList<JSONObject>()
        while (pos < buf.length) {
            val c = buf[pos]
            if (rootIndex >= 1 && depth >= 1 && tail.length < 16384 && !(depth == 1 && (c == ']' || c == ',') && !inStr)) tail.append(c)
            if (inStr) {
                if (esc) esc = false
                else if (c == '\\') esc = true
                else if (c == '"') inStr = false
                pos++
                continue
            }
            when (c) {
                '"' -> inStr = true
                '[', '{' -> {
                    depth++
                    // depth 1 = 根；depth 2 = 根[0]（frame 列表）；depth 3 = 一个 frame
                    if (depth == 3 && rootIndex == 0 && frameStart < 0) frameStart = pos
                }
                ']', '}' -> {
                    if (depth == 3 && frameStart >= 0 && rootIndex == 0) {
                        val text = buf.substring(frameStart, pos + 1)
                        frameStart = -1
                        framesSeen++
                        convertFrame(text)?.let { out.add(it) }
                    }
                    depth--
                    if (depth == 0) finished = true
                }
                ',' -> if (depth == 1) rootIndex++
            }
            pos++
        }
        // 丢掉已处理且不在 frame 内的前缀，避免整段响应常驻内存
        if (frameStart < 0 && pos > 8192) {
            buf.delete(0, pos)
            pos = 0
        } else if (frameStart > 8192) {
            buf.delete(0, frameStart)
            pos -= frameStart
            frameStart = 0
        }
        return out
    }

    /** 收尾：没有任何 frame 且像错误体时抛 RpcError；返回是否正常结束（根数组闭合） */
    fun end(httpStatus: Int = 200): Boolean {
        val t1 = tail.toString().trim()
        if (t1.startsWith("[")) {
            val e = try { JSONArray(MakerSuiteWire.normalizeSparse(t1)) } catch (x: Exception) { null }
            if (e != null && e.opt(0) is Number) throw MakerSuiteWire.RpcError(httpStatus, (e.opt(0) as Number).toInt(), e.opt(1) as? String ?: "AI Studio 流中返回错误")
        }
        if (framesSeen == 0) {
            val t = head.toString().trim()
            if (t.isNotEmpty()) {
                val err = MakerSuiteWire.decodeError(httpStatus, t)
                if (err.code != 0 || err.message.isNotEmpty() && !t.startsWith("[[")) throw err
            }
        }
        return finished
    }

    // ------------------------------------------------------------------ frame → Google chunk

    private fun convertFrame(raw: String): JSONObject? {
        val f = try { JSONArray(MakerSuiteWire.normalizeSparse(raw)) } catch (e: Exception) { return null }
        val out = JSONObject()
        // 输入被拦截：[null,[block_reason,ratings,message]]
        val block = f.opt(1)
        if (f.opt(0) == JSONObject.NULL && block is JSONArray && block.opt(0) is Number) {
            val reason = (block.opt(0) as Number).toInt()
            val msg = block.opt(2) as? String ?: ""
            throw MakerSuiteWire.RpcError(400, 3, "输入被上游拦截（block_reason=$reason）$msg")
        }
        val cands = f.optJSONArray(0)
        val cand = cands?.optJSONArray(0)
        if (cand != null) {
            val gc = JSONObject()
            val content = cand.optJSONArray(0)
            val parts = JSONArray()
            val ps = content?.optJSONArray(0)
            if (ps != null) for (i in 0 until ps.length()) {
                val p = ps.optJSONArray(i) ?: continue
                decodePart(p)?.let { parts.put(it) }
            }
            gc.put("content", JSONObject().put("role", "model").put("parts", parts))
            val fin = cand.opt(1)
            if (fin is Number) {
                val name = finishName(fin.toInt())
                gc.put("finishReason", name)
                finishReason = name
                (cand.opt(3) as? String)?.let { gc.put("finishMessage", it) }
            }
            gc.put("index", 0)
            out.put("candidates", JSONArray().put(gc))
        }
        val usage = f.optJSONArray(2)
        if (usage != null) {
            val u = decodeUsage(usage)
            lastUsage = u
            out.put("usageMetadata", u)
        }
        if (!out.has("candidates") && !out.has("usageMetadata")) return null
        out.put("modelVersion", "ais-webview")
        return out
    }

    private fun decodePart(p: JSONArray): JSONObject? {
        val o = JSONObject()
        val text = p.opt(1)
        val inline = p.opt(2) as? JSONArray
        val call = p.opt(10) as? JSONArray
        when {
            text is String -> o.put("text", text)
            inline != null -> o.put("inlineData", JSONObject().put("mimeType", inline.optString(0)).put("data", inline.optString(1)))
            call != null -> {
                val fc = JSONObject().put("name", call.optString(0)).put("args", MakerSuiteWire.decodeStruct(call.opt(1)))
                (call.opt(2) as? String)?.let { fc.put("id", it) }
                o.put("functionCall", fc)
            }
        }
        // 思考标记：官网有时给 true，有时给 1
        val th = p.opt(12)
        if (th == true || (th is Number && th.toInt() != 0)) o.put("thought", true)
        (p.opt(14) as? String)?.takeIf { it.isNotEmpty() }?.let { o.put("thoughtSignature", it) }
        if (o.length() == 0) return null
        // 只有签名的独立 Part：给一个空文本，下游按签名处理
        if (!o.has("text") && !o.has("inlineData") && !o.has("functionCall")) o.put("text", "")
        return o
    }

    private fun num(a: JSONArray, i: Int): Long? = (a.opt(i) as? Number)?.toLong()

    private fun decodeUsage(a: JSONArray): JSONObject {
        var input = num(a, 0) ?: 0
        var total = num(a, 2) ?: 0
        val cached = num(a, 3) ?: 0
        val tool = num(a, 7) ?: 0
        val thoughts = num(a, 9) ?: 0
        if (systemTokens > 0 && input > 0) { input -= systemTokens; total -= systemTokens }
        val output = num(a, 1) ?: Math.max(0, total - input - tool - thoughts)
        val u = JSONObject()
            .put("promptTokenCount", input + tool)
            .put("candidatesTokenCount", output)
            .put("totalTokenCount", total)
        if (thoughts > 0) u.put("thoughtsTokenCount", thoughts)
        if (cached > 0) u.put("cachedContentTokenCount", cached)
        return u
    }

    companion object {
        private val FINISH = mapOf(
            0 to "FINISH_REASON_UNSPECIFIED", 1 to "STOP", 2 to "MAX_TOKENS", 3 to "SAFETY", 4 to "RECITATION", 5 to "OTHER",
            6 to "LANGUAGE", 7 to "BLOCKLIST", 8 to "PROHIBITED_CONTENT", 9 to "SPII", 10 to "MALFORMED_FUNCTION_CALL",
            11 to "IMAGE_SAFETY", 12 to "UNEXPECTED_TOOL_CALL", 13 to "TOO_MANY_TOOL_CALLS", 19 to "MALFORMED_RESPONSE", 22 to "MAX_TOKENS",
        )

        fun finishName(code: Int): String = FINISH[code] ?: "OTHER"

        /**
         * 把一串 Google chunk 合并成非流式 generateContent 响应：相邻同类文本（正文 / 思考）拼接，其他 Part 原样保留。
         */
        @JvmStatic
        fun aggregate(chunks: List<JSONObject>): JSONObject {
            val parts = JSONArray()
            var finish: String? = null
            var usage: JSONObject? = null
            for (ch in chunks) {
                ch.optJSONObject("usageMetadata")?.let { usage = it }
                val c = ch.optJSONArray("candidates")?.optJSONObject(0) ?: continue
                c.optString("finishReason", "").ifEmpty { null }?.let { finish = it }
                val ps = c.optJSONObject("content")?.optJSONArray("parts") ?: continue
                for (i in 0 until ps.length()) {
                    val p = ps.optJSONObject(i) ?: continue
                    val last = if (parts.length() > 0) parts.optJSONObject(parts.length() - 1) else null
                    val isText = p.has("text") && !p.has("functionCall")
                    if (isText && last != null && last.has("text") && last.optBoolean("thought", false) == p.optBoolean("thought", false) && !last.has("thoughtSignature")) {
                        last.put("text", last.optString("text") + p.optString("text"))
                        p.optString("thoughtSignature", "").ifEmpty { null }?.let { last.put("thoughtSignature", it) }
                    } else {
                        parts.put(JSONObject(p.toString()))
                    }
                }
            }
            val cand = JSONObject().put("content", JSONObject().put("role", "model").put("parts", parts)).put("index", 0)
            cand.put("finishReason", finish ?: "STOP")
            val out = JSONObject().put("candidates", JSONArray().put(cand))
            usage?.let { out.put("usageMetadata", it) }
            out.put("modelVersion", "ais-webview")
            return out
        }

        /** 一块 Google chunk → 一行 SSE（SseStreamer 逐行读 "data: {...}"） */
        @JvmStatic
        fun sseLine(chunk: JSONObject): String = "data: " + chunk.toString() + "\n\n"
    }
}
