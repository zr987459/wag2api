package com.wag2api.ag

import okio.BufferedSource
import okio.buffer
import okio.source
import org.json.JSONArray
import org.json.JSONObject
import java.io.IOException
import java.io.InputStream

/**
 * Real-time SSE Protocol Streamer (Google Chunked Stream -> Anthropic SSE Stream)（移植自 src/sse-streamer.mjs）
 *
 * Node 版的 (upstreamRes, clientRes) 在这里是：
 *  - 上游：OkHttp Response（或 BufferedSource / InputStream），逐行读，不整段读进内存；
 *  - 客户端：[StreamClient]（由 AgServer 适配到自己的 socket 输出）。write 抛 IOException 视为客户端断开
 *    （= Node 版 clientRes 'close' 事件），随即停止读取上游并关闭上游连接。
 *
 * onFinish(usage) 保证【恰好调用一次】：正常结束、上游中断、客户端断开都会回调。
 * usage = { input_tokens, cached_tokens, output_tokens, thoughts_tokens, total_tokens,
 *           ttft_ms, t_first_thought, t_first_text, outcome: 'ok' | 'client_abort' | 'stream_error', error }
 */
object SseStreamer {

    /** 客户端响应（= Node 的 http.ServerResponse 用到的部分） */
    interface StreamClient {
        fun setHeader(name: String, value: String)
        /** 发出状态行和响应头（并关闭 Nagle） */
        fun flushHeaders()
        /** 写一段文本（UTF-8）；客户端已断开时抛 IOException */
        @Throws(IOException::class)
        fun write(chunk: String)
        fun flush() {}
        fun end()
        /** 客户端是否已断开（能提前知道时返回 true，可选） */
        val isClosed: Boolean get() = false
    }

    // ---------------------------------------------------------------- 上游逐行读取（M1 两个流式转换共用）

    /** 上游行读取：语义同 Node 版 —— 按 '\n' 切分，trim，去掉 data: 前缀；EOF 时没有换行结尾的残行丢弃 */
    internal class UpstreamLines(private val source: BufferedSource, private val closer: () -> Unit) {
        /** 下一行（已解码，未 trim）；EOF 返回 null */
        @Throws(IOException::class)
        fun next(): String? {
            val idx = source.indexOf('\n'.code.toByte())
            if (idx < 0) return null
            val line = source.readUtf8(idx)
            source.skip(1)
            return line
        }

        fun cancel() {
            try { closer() } catch (_: Throwable) {}
        }
    }

    internal fun linesOf(upstream: Any): UpstreamLines = when (upstream) {
        is okhttp3.Response -> {
            val body = upstream.body ?: throw IOException("upstream response has no body")
            UpstreamLines(body.source()) { upstream.close() }
        }
        is okhttp3.ResponseBody -> UpstreamLines(upstream.source()) { upstream.close() }
        is BufferedSource -> UpstreamLines(upstream) { upstream.close() }
        is InputStream -> {
            val src = upstream.source().buffer()
            UpstreamLines(src) { src.close() }
        }
        else -> throw IllegalArgumentException("unsupported upstream: " + upstream.javaClass.name)
    }

    /**
     * 一行 → 解析后的 chunk 内层对象（chunk.response || chunk）。空行 / [DONE] / 非 JSON 返回 null。
     * "data: null" 与 Node 版一样抛错（读取 null 的 response 属性）。
     */
    internal fun parseLine(line: String): JSONObject? {
        val trimmed = Js.trim(line)
        if (trimmed.isEmpty()) return null
        var jsonStr = trimmed
        if (jsonStr.startsWith("data:")) jsonStr = Js.trim(jsonStr.substring(5))
        if (jsonStr.isEmpty() || jsonStr == "[DONE]") return null
        val chunk = try {
            Js.parse(jsonStr)
        } catch (e: Exception) {
            return null
        }
        if (chunk == JSONObject.NULL) throw IllegalStateException("Cannot read properties of null (reading 'response')")
        if (chunk !is JSONObject) return null
        val resp = chunk.opt("response")
        return if (Js.truthy(resp)) resp as? JSONObject else chunk
    }

    internal fun candidateOf(inner: JSONObject?): JSONObject? = (inner?.opt("candidates") as? JSONArray)?.opt(0) as? JSONObject

    internal fun partsOf(candidate: JSONObject?): JSONArray =
        ((candidate?.opt("content") as? JSONObject)?.opt("parts") as? JSONArray) ?: JSONArray()

    internal fun finishPayload(usage: JSONObject, startTime: Long, firstTokenAt: Long, firstThoughtAt: Long, firstTextAt: Long, outcome: String, error: String?): JSONObject {
        val o = Js.spread(usage)
        o.put("ttft_ms", if (firstTokenAt != 0L) firstTokenAt - startTime else JSONObject.NULL)
        o.put("t_first_thought", if (firstThoughtAt != 0L) firstThoughtAt - startTime else JSONObject.NULL)
        o.put("t_first_text", if (firstTextAt != 0L) firstTextAt - startTime else JSONObject.NULL)
        o.put("outcome", outcome)
        o.put("error", error ?: JSONObject.NULL)
        return o
    }

    internal fun setStreamHeaders(clientRes: StreamClient) {
        clientRes.setHeader("Content-Type", "text/event-stream; charset=utf-8")
        clientRes.setHeader("Cache-Control", "no-cache, no-store, must-revalidate")
        clientRes.setHeader("Connection", "keep-alive")
        clientRes.setHeader("X-Accel-Buffering", "no") // 禁用反向代理的块缓冲
        clientRes.flushHeaders()
    }

    // ---------------------------------------------------------------- Anthropic SSE

    /**
     * 将 Google 的流式输出逐块解析并转换为 Anthropic 标准 Server-Sent Events 事件（阻塞，在请求线程里跑）。
     * upstreamRes：okhttp3.Response / ResponseBody / BufferedSource / InputStream。
     * notice：降级提示行，插在第一个 text block 最前面（不进 thinking block，不动签名）。
     */
    @JvmStatic
    @JvmOverloads
    fun handleStreamConversion(
        upstreamRes: Any,
        clientRes: StreamClient,
        originalModel: String?,
        onFinish: ((JSONObject) -> Unit)? = null,
        startTime: Long = System.currentTimeMillis(),
        notice: String? = null
    ) {
        var noticePending = !notice.isNullOrEmpty()
        setStreamHeaders(clientRes)

        val messageId = "msg_" + Js.randomHex(12)
        var blockIndex = 0
        var currentBlockType: String? = null // 'thinking' | 'text' | 'tool_use' | null
        var hasEmittedStart = false
        var stopReason = "end_turn"
        var sawToolUse = false

        var rawUsage: JSONObject? = null
        var firstTokenAt = 0L
        var firstThoughtAt = 0L
        var firstTextAt = 0L
        var finished = false
        var clientGone = false
        var lines: UpstreamLines? = null

        fun usageNow() = Usage.normalizeGeminiUsage(rawUsage)
        fun finish(outcome: String, error: String? = null) {
            if (finished) return
            finished = true
            if (onFinish != null) {
                try {
                    onFinish(finishPayload(usageNow(), startTime, firstTokenAt, firstThoughtAt, firstTextAt, outcome, error))
                } catch (e: Throwable) {
                    System.err.println("[Stream onFinish Error] $e")
                }
            }
        }

        var latestSeenSignature: String = SignatureCache.FALLBACK_THOUGHT_SIGNATURE
        var thinkingHasSignature = false

        fun sendEvent(event: String, data: JSONObject) {
            if (clientGone) return
            if (clientRes.isClosed) {
                clientGone = true
                lines?.cancel()
                return
            }
            try {
                clientRes.write("event: " + event + "\ndata: " + Js.stringify(data) + "\n\n")
                clientRes.flush()
            } catch (e: IOException) {
                // 客户端提前断开：停止读取上游，按已收到的 usage 记一次
                clientGone = true
                lines?.cancel()
            }
        }

        fun emitStart() {
            if (hasEmittedStart) return
            hasEmittedStart = true
            val usage = Usage.toAnthropicUsage(usageNow()).put("output_tokens", 1)
            sendEvent(
                "message_start", JSONObject().put("type", "message_start").put(
                    "message", JSONObject()
                        .put("id", messageId)
                        .put("type", "message")
                        .put("role", "assistant")
                        .put("content", JSONArray())
                        .put("model", originalModel)
                        .put("stop_reason", JSONObject.NULL)
                        .put("stop_sequence", JSONObject.NULL)
                        .put("usage", usage)
                )
            )
        }

        fun closeCurrentBlock() {
            if (currentBlockType != null) {
                if (currentBlockType == "thinking" && !thinkingHasSignature) {
                    sendEvent(
                        "content_block_delta", JSONObject().put("type", "content_block_delta").put("index", blockIndex)
                            .put("delta", JSONObject().put("type", "signature_delta").put("signature", latestSeenSignature.ifEmpty { SignatureCache.FALLBACK_THOUGHT_SIGNATURE }))
                    )
                    thinkingHasSignature = true
                }
                sendEvent("content_block_stop", JSONObject().put("type", "content_block_stop").put("index", blockIndex))
                blockIndex++
                currentBlockType = null
                thinkingHasSignature = false
            }
        }

        try {
            val ls = linesOf(upstreamRes)
            lines = ls
            while (!clientGone) {
                val line = ls.next() ?: break
                val inner = parseLine(line) ?: continue

                val meta = inner.opt("usageMetadata")
                if (Js.truthy(meta)) rawUsage = Usage.mergeRawUsage(rawUsage, meta as? JSONObject)

                val candidate = candidateOf(inner)
                // MAX_TOKENS → max_tokens（工具调用优先，与非流式一致）
                if (candidate?.opt("finishReason") == "MAX_TOKENS" && !sawToolUse) stopReason = "max_tokens"
                val parts = partsOf(candidate)

                // 1. message_start
                if (parts.length() > 0) {
                    if (firstTokenAt == 0L) firstTokenAt = System.currentTimeMillis()
                    emitStart()
                }

                // 2. 遍历各 part
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
                        val targetType = if (isThought) "thinking" else "text"

                        if (currentBlockType != targetType) {
                            closeCurrentBlock()
                            currentBlockType = targetType
                            sendEvent(
                                "content_block_start", JSONObject().put("type", "content_block_start").put("index", blockIndex)
                                    .put(
                                        "content_block",
                                        if (isThought) JSONObject().put("type", "thinking").put("thinking", "")
                                        else JSONObject().put("type", "text").put("text", "")
                                    )
                            )
                            if (!isThought && noticePending) {
                                noticePending = false
                                sendEvent(
                                    "content_block_delta", JSONObject().put("type", "content_block_delta").put("index", blockIndex)
                                        .put("delta", JSONObject().put("type", "text_delta").put("text", notice))
                                )
                            }
                        }

                        if (hasText) {
                            sendEvent(
                                "content_block_delta", JSONObject().put("type", "content_block_delta").put("index", blockIndex)
                                    .put(
                                        "delta",
                                        if (isThought) JSONObject().put("type", "thinking_delta").put("thinking", textAny)
                                        else JSONObject().put("type", "text_delta").put("text", textAny)
                                    )
                            )
                        }

                        if (isThought && sig != null) {
                            sendEvent(
                                "content_block_delta", JSONObject().put("type", "content_block_delta").put("index", blockIndex)
                                    .put("delta", JSONObject().put("type", "signature_delta").put("signature", sigAny))
                            )
                            thinkingHasSignature = true
                        }
                    } else if (Js.truthy(part.opt("functionCall"))) {
                        val fc = part.opt("functionCall") as? JSONObject ?: JSONObject()
                        closeCurrentBlock()
                        stopReason = "tool_use"
                        sawToolUse = true
                        val callId = Js.or(fc.opt("id"), "toolu_" + Js.randomHex(12))
                        val actualSig = sig ?: latestSeenSignature.ifEmpty { SignatureCache.FALLBACK_THOUGHT_SIGNATURE }
                        val name = fc.opt("name")
                        SignatureCache.signatureCache.set(Js.cat(callId), actualSig, if (name is String) name else "")

                        // 必须标记当前块类型，否则 closeCurrentBlock 是空操作
                        currentBlockType = "tool_use"
                        sendEvent(
                            "content_block_start", JSONObject().put("type", "content_block_start").put("index", blockIndex)
                                .put(
                                    "content_block", JSONObject().put("type", "tool_use").put("id", callId)
                                        .put("name", name).put("input", JSONObject())
                                )
                        )
                        val argsStr = Js.stringify(Js.or(fc.opt("args"), JSONObject()))
                        sendEvent(
                            "content_block_delta", JSONObject().put("type", "content_block_delta").put("index", blockIndex)
                                .put("delta", JSONObject().put("type", "input_json_delta").put("partial_json", argsStr))
                        )
                        closeCurrentBlock()
                    }
                }
            }

            if (clientGone) {
                finish("client_abort", "客户端提前断开")
                return
            }

            emitStart() // 上游没有任何 part 时也保证事件序列完整
            closeCurrentBlock()

            // 3. 终结事件（message_delta.usage 为累计值）
            val finalUsage = Usage.toAnthropicUsage(usageNow())
            sendEvent(
                "message_delta", JSONObject().put("type", "message_delta")
                    .put("delta", JSONObject().put("stop_reason", stopReason).put("stop_sequence", JSONObject.NULL))
                    .put("usage", finalUsage)
            )
            sendEvent("message_stop", JSONObject().put("type", "message_stop"))

            finish("ok")
            clientRes.end()
        } catch (err: Throwable) {
            if (clientGone) {
                finish("client_abort", "客户端提前断开")
            } else {
                System.err.println("[Stream Processing Error] $err")
                val msg = err.message ?: err.toString()
                finish("stream_error", msg.take(100))
                // 按 Anthropic 规范下发 error 事件
                try {
                    sendEvent("error", JSONObject().put("type", "error").put("error", JSONObject().put("type", "api_error").put("message", msg)))
                } catch (_: Throwable) {}
            }
            try { clientRes.end() } catch (_: Throwable) {}
        } finally {
            finish("ok") // 兜底（已调用过则无操作）
            lines?.cancel()
        }
    }
}
