package com.wag2api.ag

import org.json.JSONArray
import org.json.JSONObject
import java.io.IOException

/**
 * OpenAI Chat Completions 兼容转换器 (for Google Antigravity / Cloud Code)（移植自 src/openai-ag-converter.mjs）
 *
 * 1. openaiRequestToAnthropic: OpenAI ChatCompletion 请求 → 内部 Anthropic 结构
 * 2. convertGoogleToOpenAI: Google 原生非流式响应 → OpenAI chat.completion（_gw_usage 用 Usage.gwUsage(resp) 取）
 * 3. handleOpenAIStreamConversion: Google 原生 SSE 流 → OpenAI SSE 打字机流（含 delta.reasoning_content）
 */
object OpenaiAgConverter {

    private val DATA_URI = Regex("^data:([^;,]+)(?:;[^,]*)?;base64,(.+)$", setOf(RegexOption.IGNORE_CASE, RegexOption.DOT_MATCHES_ALL))

    private fun isObj(v: Any?): Boolean = v is JSONObject

    /** o && o[k] != null ? String(o[k]) : '' */
    private fun str(o: Any?, k: String): String {
        if (o !is JSONObject) return ""
        val v = o.opt(k)
        return if (v == null || v == JSONObject.NULL) "" else Js.cat(v)
    }

    private fun newId(p: String): String = p + Js.uuid24()

    private fun isNullish(v: Any?): Boolean = v == null || v == JSONObject.NULL

    /** 单个 content 块（OpenAI 格式）→ Anthropic 格式；不认识返回 null */
    private fun partToAnthropic(p: Any?): JSONObject? {
        if (p is String) return JSONObject().put("type", "text").put("text", p)
        if (p !is JSONObject) return null
        val type = p.opt("type")
        if (type == "text") return JSONObject().put("type", "text").put("text", str(p, "text"))
        if (type == "image_url") {
            val iu = p.opt("image_url")
            val url = if (iu is JSONObject) str(iu, "url") else str(p, "image_url")
            if (url.isEmpty()) return null
            // data URI 允许 base64 前带其它参数（如 data:image/png;name=a.png;base64,...）
            val m = DATA_URI.find(url)
            if (m != null) {
                return JSONObject().put("type", "image").put(
                    "source", JSONObject().put("type", "base64").put("media_type", m.groupValues[1]).put("data", m.groupValues[2])
                )
            }
            return JSONObject().put("type", "image").put("source", JSONObject().put("type", "url").put("url", url))
        }
        // OpenAI 文件块（PDF 等）：file.file_data 为 data URI → Anthropic document 块
        val file = p.opt("file")
        if (type == "file" && file is JSONObject) {
            val m = DATA_URI.find(str(file, "file_data"))
            if (m != null) {
                return JSONObject().put("type", "document").put(
                    "source", JSONObject().put("type", "base64").put("media_type", m.groupValues[1]).put("data", m.groupValues[2])
                )
            }
        }
        return null
    }

    /** user 消息 content：字符串原样，数组转块，其它为 '' */
    private fun userContentToAnthropic(content: Any?): Any {
        if (content is String) return content
        if (content !is JSONArray) return ""
        val out = JSONArray()
        for (i in 0 until content.length()) {
            val b = partToAnthropic(content.opt(i))
            if (b != null) out.put(b)
        }
        return out
    }

    /**
     * assistant 消息，含 tool_calls。
     * 注意：历史 reasoning_content 不构造 thinking 块（避免空签名触发 Claude-on-AG 400）。
     */
    @Suppress("UNUSED_PARAMETER")
    private fun assistantContentToAnthropic(content: Any?, reasoning: Any?, toolCalls: Any?): JSONArray {
        val blocks = JSONArray()
        if (content is String && content.isNotEmpty()) {
            blocks.put(JSONObject().put("type", "text").put("text", content))
        } else if (content is JSONArray) {
            for (i in 0 until content.length()) {
                val b = partToAnthropic(content.opt(i))
                if (b != null) blocks.put(b)
            }
        }
        if (toolCalls is JSONArray) {
            for (i in 0 until toolCalls.length()) {
                val c = toolCalls.opt(i) as? JSONObject ?: continue
                val f = c.opt("function") as? JSONObject ?: JSONObject()
                var input: Any? = JSONObject()
                val raw = str(f, "arguments")
                if (raw.isNotEmpty()) {
                    input = try {
                        Js.parse(raw)
                    } catch (e: Exception) {
                        JSONObject().put("_raw", raw)
                    }
                }
                blocks.put(
                    JSONObject().put("type", "tool_use")
                        .put("id", str(c, "id").ifEmpty { newId("toolu_") })
                        .put("name", str(f, "name"))
                        .put("input", if (input is JSONObject) input else JSONObject())
                )
            }
        }
        return blocks
    }

    /** 核心：OpenAI 请求体 → Anthropic 请求体 */
    @JvmStatic
    fun openaiRequestToAnthropic(oai: Any?): JSONObject {
        if (oai !is JSONObject) throw IllegalArgumentException("无效的 OpenAI 请求体")

        val out = JSONObject().put("model", str(oai, "model"))

        val maxTok = if (!isNullish(oai.opt("max_completion_tokens"))) oai.opt("max_completion_tokens") else oai.opt("max_tokens")
        if (!isNullish(maxTok)) {
            val v = Js.parseInt10(maxTok)
            out.put("max_tokens", if (v == null || v == 0L) 8192L else v)
        }

        for (k in arrayOf("temperature", "top_p")) {
            if (!isNullish(oai.opt(k))) out.put(k, oai.opt(k))
        }
        val stop = oai.opt("stop")
        if (stop is JSONArray) out.put("stop_sequences", stop)
        else if (stop is String && stop.isNotEmpty()) out.put("stop_sequences", JSONArray().put(stop))

        // 思考预算映射（none：不开启思考；minimal：最低档）
        val effort = oai.opt("reasoning_effort")
        if (Js.truthy(effort) && Js.cat(effort) != "none") {
            val budget = when (Js.cat(effort)) {
                "minimal" -> 1024L
                "low" -> 2048L
                "medium" -> 8192L
                "high" -> 24576L
                "xhigh" -> 24576L
                else -> 4096L
            }
            out.put("thinking", JSONObject().put("type", "enabled").put("budget_tokens", budget))
            val mt = out.opt("max_tokens")
            if (mt is Number && mt.toLong() != 0L && mt.toLong() <= budget) {
                out.put("max_tokens", budget + 4096)
            }
        }

        val sysPieces = ArrayList<String>()
        val msgs = ArrayList<JSONObject>()

        val messages = oai.opt("messages") as? JSONArray ?: JSONArray()
        for (i in 0 until messages.length()) {
            val m = messages.opt(i) as? JSONObject ?: continue
            val role = str(m, "role")
            val content = m.opt("content")

            if (role == "system" || role == "developer") {
                if (content is String) sysPieces.add(content)
                else if (content is JSONArray) {
                    for (j in 0 until content.length()) {
                        val p = content.opt(j)
                        if (p is JSONObject && p.opt("type") == "text") sysPieces.add(str(p, "text"))
                    }
                }
                continue
            }

            if (role == "user") {
                msgs.add(JSONObject().put("role", "user").put("content", userContentToAnthropic(content)))
                continue
            }

            if (role == "tool" || role == "function") {
                val id = str(m, "tool_call_id").ifEmpty { str(m, "name") }
                var result: Any? = content
                // content 为分段数组时只拼接文本段
                var allText = result is JSONArray
                if (result is JSONArray) {
                    for (j in 0 until result.length()) {
                        val p = result.opt(j)
                        if (!(p is String || (p is JSONObject && p.opt("type") == "text"))) { allText = false; break }
                    }
                }
                if (result is JSONArray && allText) {
                    val l = ArrayList<String>()
                    for (j in 0 until result.length()) {
                        val p = result.opt(j)
                        l.add(if (p is String) p else str(p, "text"))
                    }
                    result = l.joinToString("\n")
                } else if (result !is String) {
                    // JSON.stringify(undefined) 为 undefined（→ ''），JSON.stringify(null) 为 "null"
                    result = if (result == null) null else Js.stringify(result)
                }
                val block = JSONObject().put("type", "tool_result")
                    .put("tool_use_id", id.ifEmpty { newId("toolu_") })
                    .put("content", result ?: "")
                val last = msgs.lastOrNull()
                val lastContent = last?.opt("content")
                if (last != null && last.opt("role") == "user" && lastContent is JSONArray) {
                    lastContent.put(block)
                } else {
                    msgs.add(JSONObject().put("role", "user").put("content", JSONArray().put(block)))
                }
                continue
            }

            if (role == "assistant") {
                val blocks = assistantContentToAnthropic(content, null, m.opt("tool_calls"))
                if (blocks.length() == 0) blocks.put(JSONObject().put("type", "text").put("text", ""))
                msgs.add(JSONObject().put("role", "assistant").put("content", blocks))
            }
        }

        if (sysPieces.isNotEmpty()) out.put("system", sysPieces.joinToString("\n\n"))
        out.put("messages", JSONArray(msgs))

        // 透传 response_format（防止 JSON 模式下注入文本提示导致解析崩溃）
        if (!isNullish(oai.opt("response_format"))) out.put("response_format", oai.opt("response_format"))

        // 工具定义映射
        val tools = oai.opt("tools")
        if (tools is JSONArray && tools.length() > 0) {
            val outTools = JSONArray()
            for (i in 0 until tools.length()) {
                val t = tools.opt(i) as? JSONObject ?: continue
                val fn = t.opt("function") as? JSONObject
                if (t.opt("type") != "function" || fn == null) continue
                val name = str(fn, "name")
                if (name.isEmpty()) continue
                val params = fn.opt("parameters")
                outTools.put(
                    JSONObject().put("name", name)
                        .put("description", str(fn, "description"))
                        .put("input_schema", if (params is JSONObject) params else JSONObject().put("type", "object").put("properties", JSONObject()))
                )
            }
            out.put("tools", outTools)

            val tc = oai.opt("tool_choice")
            if (tc is String) {
                when (tc) {
                    "auto" -> out.put("tool_choice", JSONObject().put("type", "auto"))
                    "required" -> out.put("tool_choice", JSONObject().put("type", "any"))
                    "none" -> out.put("tool_choice", JSONObject().put("type", "none"))
                }
            } else if (tc is JSONObject && tc.opt("type") == "function" && (tc.opt("function") is JSONObject || Js.truthy(tc.opt("name")))) {
                val fn = tc.opt("function")
                out.put("tool_choice", JSONObject().put("type", "tool").put("name", if (fn is JSONObject) str(fn, "name") else str(tc, "name")))
            }
        }

        return out
    }

    /** Gemini finishReason → OpenAI finish_reason（工具调用优先，由调用方处理） */
    private fun mapFinishReason(fr: Any?): String? = when (fr) {
        "MAX_TOKENS" -> "length"
        "SAFETY", "RECITATION", "PROHIBITED_CONTENT", "BLOCKLIST", "SPII" -> "content_filter"
        else -> null
    }

    private fun lnum(o: JSONObject?, k: String): Long {
        val v = o?.opt(k)
        return if (v is Number) v.toLong() else 0L
    }

    /** normalizeGeminiUsage → 标准 OpenAI usage（output_tokens 已含思考 token，不能再加 reasoning） */
    private fun toOpenAIUsage(normUsage: JSONObject?): JSONObject {
        val input = lnum(normUsage, "input_tokens")
        val output = lnum(normUsage, "output_tokens")
        val cached = lnum(normUsage, "cached_tokens")
        val reasoning = lnum(normUsage, "thoughts_tokens")
        return JSONObject()
            .put("prompt_tokens", input + cached)
            .put("completion_tokens", output)
            .put("total_tokens", input + cached + output)
            .put("prompt_tokens_details", JSONObject().put("cached_tokens", cached))
            .put("completion_tokens_details", JSONObject().put("reasoning_tokens", reasoning))
    }

    /** Google 原生非流式响应 → OpenAI chat.completion */
    @JvmStatic
    fun convertGoogleToOpenAI(googleResponse: JSONObject?, clientModel: String?): JSONObject {
        val inner = (googleResponse?.opt("response") as? JSONObject) ?: googleResponse ?: JSONObject()
        val candidate = SseStreamer.candidateOf(inner)
        val parts = SseStreamer.partsOf(candidate)

        val text = StringBuilder()
        val reasoning = StringBuilder()
        val toolCalls = JSONArray()
        var latestSeenSignature: String = SignatureCache.FALLBACK_THOUGHT_SIGNATURE

        for (k in 0 until parts.length()) {
            val part = parts.opt(k) as? JSONObject ?: continue
            val sigAny = Js.or(part.opt("thoughtSignature"), part.opt("thought_signature"))
            val sig = if (Js.truthy(sigAny)) Js.cat(sigAny) else null
            if (sig != null) latestSeenSignature = sig

            if (Js.truthy(part.opt("thought"))) {
                reasoning.append(Js.cat(Js.or(part.opt("text"), "")))
            } else if (part.has("text") && part.opt("text") != "") {
                text.append(Js.cat(part.opt("text")))
            }

            val fcAny = part.opt("functionCall")
            if (Js.truthy(fcAny)) {
                val fc = fcAny as? JSONObject ?: JSONObject()
                val callId = Js.or(fc.opt("id"), newId("call_"))
                val name = fc.opt("name")
                SignatureCache.signatureCache.set(Js.cat(callId), sig ?: latestSeenSignature, if (name is String) name else "")
                toolCalls.put(
                    JSONObject().put("id", callId).put("type", "function").put(
                        "function", JSONObject().put("name", name).put("arguments", Js.stringify(Js.or(fc.opt("args"), JSONObject())))
                    )
                )
            }
        }

        val message = JSONObject().put("role", "assistant")
            .put("content", if (toolCalls.length() > 0 && text.isEmpty()) JSONObject.NULL else text.toString())
        if (reasoning.isNotEmpty()) message.put("reasoning_content", reasoning.toString())
        if (toolCalls.length() > 0) message.put("tool_calls", toolCalls)

        val finishReason = if (toolCalls.length() > 0) "tool_calls" else mapFinishReason(candidate?.opt("finishReason")) ?: "stop"

        val normUsage = Usage.normalizeGeminiUsage(inner.opt("usageMetadata") as? JSONObject)
        val response = JSONObject()
            .put("id", newId("chatcmpl-"))
            .put("object", "chat.completion")
            .put("created", System.currentTimeMillis() / 1000)
            .put("model", clientModel)
            .put("choices", JSONArray().put(JSONObject().put("index", 0).put("message", message).put("finish_reason", finishReason)))
            .put("usage", toOpenAIUsage(normUsage))
        Usage.attachGwUsage(response, normUsage)
        return response
    }

    /**
     * Google 原生 SSE 流 → 标准 OpenAI SSE 流（阻塞，在请求线程里跑）。
     * upstreamRes / clientRes / onFinish 同 [SseStreamer.handleStreamConversion]。
     * includeUsage：stream_options.include_usage。
     */
    @JvmStatic
    @JvmOverloads
    fun handleOpenAIStreamConversion(
        upstreamRes: Any,
        clientRes: SseStreamer.StreamClient,
        originalModel: String?,
        onFinish: ((JSONObject) -> Unit)? = null,
        startTime: Long = System.currentTimeMillis(),
        notice: String? = null,
        includeUsage: Boolean = true
    ) {
        var noticePending = !notice.isNullOrEmpty()
        SseStreamer.setStreamHeaders(clientRes)

        val completionId = newId("chatcmpl-")
        val created = System.currentTimeMillis() / 1000
        var hasEmittedRole = false
        var toolIndex = 0
        var stopReason = "stop"
        // 流内最近一次有效 thoughtSignature，回退给无签名的 functionCall
        var latestSeenSignature: String = SignatureCache.FALLBACK_THOUGHT_SIGNATURE

        var rawUsage: JSONObject? = null
        var firstTokenAt = 0L
        var firstThoughtAt = 0L
        var firstTextAt = 0L
        var finished = false
        var clientGone = false
        var lines: SseStreamer.UpstreamLines? = null

        fun usageNow() = Usage.normalizeGeminiUsage(rawUsage)
        fun finish(outcome: String, error: String? = null) {
            if (finished) return
            finished = true
            if (onFinish != null) {
                try {
                    onFinish(SseStreamer.finishPayload(usageNow(), startTime, firstTokenAt, firstThoughtAt, firstTextAt, outcome, error))
                } catch (e: Throwable) {
                    System.err.println("[OpenAI Stream onFinish Error] $e")
                }
            }
        }

        fun rawWrite(s: String) {
            if (clientGone) return
            if (clientRes.isClosed) {
                clientGone = true
                lines?.cancel()
                return
            }
            try {
                clientRes.write(s)
                clientRes.flush()
            } catch (e: IOException) {
                clientGone = true
                lines?.cancel()
            }
        }

        fun sendChunk(delta: JSONObject, finishReason: String? = null, extra: JSONObject? = null) {
            if (clientGone) return
            val payload = JSONObject()
                .put("id", completionId)
                .put("object", "chat.completion.chunk")
                .put("created", created)
                .put("model", originalModel)
                .put("choices", JSONArray().put(JSONObject().put("index", 0).put("delta", delta).put("finish_reason", finishReason ?: JSONObject.NULL)))
            if (extra != null) {
                val it = extra.keys()
                while (it.hasNext()) {
                    val k = it.next() as String
                    payload.put(k, extra.opt(k))
                }
            }
            rawWrite("data: " + Js.stringify(payload) + "\n\n")
        }

        try {
            val ls = SseStreamer.linesOf(upstreamRes)
            lines = ls
            while (!clientGone) {
                val line = ls.next() ?: break
                val inner = SseStreamer.parseLine(line) ?: continue

                val meta = inner.opt("usageMetadata")
                if (Js.truthy(meta)) rawUsage = Usage.mergeRawUsage(rawUsage, meta as? JSONObject)

                val candidate = SseStreamer.candidateOf(inner)
                val mappedFinish = mapFinishReason(candidate?.opt("finishReason"))
                if (mappedFinish != null && stopReason != "tool_calls") stopReason = mappedFinish
                val parts = SseStreamer.partsOf(candidate)

                // 首帧吐 role: assistant
                if (!hasEmittedRole && parts.length() > 0) {
                    hasEmittedRole = true
                    if (firstTokenAt == 0L) firstTokenAt = System.currentTimeMillis()
                    sendChunk(JSONObject().put("role", "assistant").put("content", ""))
                }

                for (k in 0 until parts.length()) {
                    val part = parts.opt(k) as? JSONObject ?: continue
                    val sigAny = Js.or(part.opt("thoughtSignature"), part.opt("thought_signature"))
                    val sig = if (Js.truthy(sigAny)) Js.cat(sigAny) else null
                    if (sig != null) latestSeenSignature = sig

                    if (part.has("text")) {
                        val textAny = part.opt("text")
                        val hasText = Js.truthy(textAny)
                        val isThought = part.opt("thought") == true
                        if (hasText) {
                            if (isThought) { if (firstThoughtAt == 0L) firstThoughtAt = System.currentTimeMillis() }
                            else if (firstTextAt == 0L) firstTextAt = System.currentTimeMillis()
                        }
                        if (isThought) {
                            if (hasText) sendChunk(JSONObject().put("reasoning_content", textAny))
                        } else {
                            if (noticePending) {
                                noticePending = false
                                sendChunk(JSONObject().put("content", notice))
                            }
                            if (hasText) sendChunk(JSONObject().put("content", textAny))
                        }
                    } else if (Js.truthy(part.opt("functionCall"))) {
                        val fc = part.opt("functionCall") as? JSONObject ?: JSONObject()
                        stopReason = "tool_calls"
                        val callId = Js.or(fc.opt("id"), newId("call_"))
                        val name = fc.opt("name")
                        // 签名继承至最近的真实签名
                        SignatureCache.signatureCache.set(Js.cat(callId), sig ?: latestSeenSignature, if (name is String) name else "")
                        sendChunk(
                            JSONObject().put(
                                "tool_calls", JSONArray().put(
                                    JSONObject().put("index", toolIndex++).put("id", callId).put("type", "function").put(
                                        "function", JSONObject().put("name", name).put("arguments", Js.stringify(Js.or(fc.opt("args"), JSONObject())))
                                    )
                                )
                            )
                        )
                    }
                }
            }

            // 客户端已断开时，短路为 client_abort，绝不继续发送或以 ok 收尾
            if (clientGone) {
                finish("client_abort", "客户端提前断开")
                return
            }

            if (!hasEmittedRole) sendChunk(JSONObject().put("role", "assistant").put("content", ""))

            val norm = usageNow()
            // include_usage=true：单独发一个 choices:[] 的 usage 帧；否则 usage 挂在 finish_reason 帧上
            sendChunk(JSONObject(), stopReason, if (includeUsage) null else JSONObject().put("usage", toOpenAIUsage(norm)))

            if (!clientGone && !includeUsage) {
                rawWrite("data: [DONE]\n\n")
            } else if (!clientGone) {
                val usagePayload = JSONObject()
                    .put("id", completionId)
                    .put("object", "chat.completion.chunk")
                    .put("created", created)
                    .put("model", originalModel)
                    .put("choices", JSONArray())
                    .put("usage", toOpenAIUsage(norm))
                rawWrite("data: " + Js.stringify(usagePayload) + "\n\n")
                rawWrite("data: [DONE]\n\n")
            }
            finish("ok")
        } catch (err: Throwable) {
            if (clientGone) {
                finish("client_abort", "客户端提前断开")
            } else {
                System.err.println("[OpenAI Stream Error] $err")
                val msg = err.message
                finish("stream_error", msg)
                try {
                    val e = JSONObject().put("message", msg).put("type", "stream_error")
                    rawWrite("data: " + Js.stringify(JSONObject().put("error", e)) + "\n\n")
                    rawWrite("data: [DONE]\n\n")
                } catch (_: Throwable) {}
            }
        } finally {
            lines?.cancel()
            try { clientRes.end() } catch (_: Throwable) {}
        }
    }
}
