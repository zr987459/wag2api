package com.wag2api.ag

import org.json.JSONArray
import org.json.JSONObject
import java.text.Collator
import java.util.Locale

/**
 * Bidirectional Protocol Converter (Anthropic <-> Google Cloud Code)（移植自 src/content-converter.mjs）
 *
 * 针对长上下文、深度思考（Thinking）与多轮工具调用的完整加固版本。
 * 依赖：SignatureCache（M2）、HistoryPin / DowngradeNotice / SessionRouter（M3）、Usage、SchemaSanitizer。
 */
object ContentConverter {

    private val FALLBACK: String get() = SignatureCache.FALLBACK_THOUGHT_SIGNATURE

    private fun strip(t: Any?): Any? = if (t is String) DowngradeNotice.stripDowngradeNotice(t) else t

    private fun pinIf(key: String, value: Any?, same: (Any?, Any?) -> Boolean): Any? =
        (HistoryPin.historyPin.pinIf(key, value, same) as Any?)

    private fun joinStr(l: List<Any?>, sep: String): String =
        l.joinToString(sep) { if (it == null || it == JSONObject.NULL) "" else Js.cat(it) }

    /** 无会话 id 时的会话指纹：首条用户消息 + 首条模型回复的可见内容（忽略 thinking / 签名 / 空白差异）。首轮返回 ''。 */
    @JvmStatic
    fun fallbackConvSeed(messages: Any?): String {
        val msgs = messages as? JSONArray ?: JSONArray()
        var firstUser: JSONObject? = null
        var firstModel: JSONObject? = null
        for (i in 0 until msgs.length()) {
            val m = msgs.opt(i) as? JSONObject ?: continue
            val role = m.opt("role")
            if (firstUser == null && role == "user") firstUser = m
            if (firstModel == null && role == "assistant") firstModel = m
        }
        if (firstUser == null || firstModel == null) return ""
        fun vis(m: JSONObject): List<Any?> {
            val c = m.opt("content")
            if (c is String) return listOf(strip(c))
            val arr = c as? JSONArray ?: return emptyList()
            val out = ArrayList<Any?>()
            for (i in 0 until arr.length()) {
                val b = arr.opt(i)
                if (!Js.truthy(b)) { out.add(""); continue }
                if (b !is JSONObject) { out.add(""); continue }
                val type = b.opt("type")
                out.add(
                    when (type) {
                        "thinking", "redacted_thinking" -> ""
                        "text" -> if (m.opt("role") == "assistant") strip(Js.or(b.opt("text"), "")) else Js.or(b.opt("text"), "")
                        "tool_use" -> "tu:" + Js.cat(Js.or(b.opt("name"), "")) + ":" + Js.cat(Js.or(b.opt("id"), ""))
                        "tool_result" -> "tr:" + Js.cat(Js.or(b.opt("tool_use_id"), ""))
                        "image" -> {
                            val src = b.opt("source") as? JSONObject
                            "img:" + Js.cat(Js.or(Js.or(src?.opt("data"), src?.opt("url")), "")).length
                        }
                        else -> ""
                    }
                )
            }
            return out
        }
        fun norm(a: List<Any?>): String = Js.trim(joinStr(a, "\n").replace(Js.WS_RUN, " "))
        val u = norm(vis(firstUser))
        val a = norm(vis(firstModel))
        if (a.isEmpty()) return ""
        return "fp:" + u + "\u0000" + a
    }

    /**
     * 转换 Anthropic Request 为 Google Cloud Code / Gemini Request。
     * 返回 {contents, systemInstruction?, tools?}（Node 版 systemInstruction 为 null、tools 为 undefined 时这里不放该键）。
     */
    @JvmStatic
    fun convertAnthropicToGoogle(anthropicRequest: JSONObject): JSONObject {
        var systemInstruction: JSONObject? = null
        val messages = anthropicRequest.opt("messages") as? JSONArray ?: JSONArray()
        // 会话 key：客户端带了会话 id 直接用；没带用「首条用户消息 + 首条模型回复」指纹；首轮没有历史可锁，关闭锁定
        val sessionKeyAny = Js.or(anthropicRequest.opt("_gwSessionKey"), fallbackConvSeed(anthropicRequest.opt("messages")))
        val sessionKey = if (Js.truthy(sessionKeyAny)) Js.cat(sessionKeyAny) else ""
        val model = Js.cat(Js.or(anthropicRequest.opt("model"), "")).lowercase()
        HistoryPin.historyPin.active = !model.contains("claude") && sessionKey.isNotEmpty()
        val seed = if (sessionKey.isNotEmpty()) sessionKey else Js.stringify(Js.or(messages.opt(0), ""))
        val conv = Js.sha1Hex(seed).substring(0, 12)

        // 1. 处理 System Prompt（注意：严禁修改 System Prompt 中的稳定前缀，避免破坏 Google 上下文哈希导致缓存击穿）
        val sys = anthropicRequest.opt("system")
        if (Js.truthy(sys)) {
            var sysText = ""
            if (sys is String) {
                sysText = sys
            } else if (sys is JSONArray) {
                val l = ArrayList<Any?>()
                for (i in 0 until sys.length()) l.add(Js.or((sys.opt(i) as? JSONObject)?.opt("text"), ""))
                sysText = joinStr(l, "\n")
            }
            if (Js.trim(sysText).isNotEmpty()) {
                systemInstruction = JSONObject().put("role", "user").put("parts", JSONArray().put(JSONObject().put("text", sysText)))
            }
        }

        // 预扫描所有 tool_use，构建 call_id -> name 映射表
        val toolNameMap = HashMap<String, Any>()
        for (i in 0 until messages.length()) {
            val c = (messages.opt(i) as? JSONObject)?.opt("content") as? JSONArray ?: continue
            for (j in 0 until c.length()) {
                val item = c.opt(j) as? JSONObject ?: continue
                if (item.opt("type") == "tool_use" && Js.truthy(item.opt("id")) && Js.truthy(item.opt("name"))) {
                    toolNameMap[Js.cat(item.opt("id"))] = item.opt("name")
                }
            }
        }

        // 2. 遍历历史消息并构建 parts
        val rawContents = ArrayList<JSONObject>()
        for (i in 0 until messages.length()) {
            val msg = messages.opt(i) as? JSONObject ?: continue
            val role = if (msg.opt("role") == "assistant") "model" else "user"
            val parts = JSONArray()
            val content = msg.opt("content")

            if (content is String) {
                val t = if (role == "model") strip(content) as String else content
                if (t.isNotEmpty()) parts.put(JSONObject().put("text", t))
            } else if (content is JSONArray) {
                val mediaParts = ArrayList<JSONObject>() // tool_result 内的图片，追加在本条消息末尾
                for (j in 0 until content.length()) {
                    val item = content.opt(j) as? JSONObject ?: continue
                    val source = item.opt("source") as? JSONObject
                    when (item.opt("type")) {
                        "text" -> {
                            // 剔掉网关插入的降级提示行，永不发回模型
                            val t = if (role == "model") strip(item.opt("text")) else item.opt("text")
                            if (Js.truthy(t)) parts.put(JSONObject().put("text", t))
                        }
                        "thinking" -> {
                            if (Js.truthy(item.opt("thinking"))) {
                                parts.put(
                                    JSONObject().put("thought", true).put("text", item.opt("thinking"))
                                        .put("thoughtSignature", Js.or(item.opt("signature"), FALLBACK))
                                )
                            }
                        }
                        "tool_use" -> {
                            // functionCall 只有 { name, args }，不能带客户端私有 id，否则改变前缀哈希
                            val callIdAny = item.opt("id")
                            val sig = Js.or(SignatureCache.signatureCache.get(if (callIdAny == null || callIdAny == JSONObject.NULL) "" else Js.cat(callIdAny)), FALLBACK)
                            val input = Js.or(item.opt("input"), JSONObject())
                            val args = pinIf(conv + ":fc:" + Js.cat(callIdAny) + ":" + Js.cat(item.opt("name")), input) { prev, cur ->
                                val p = Js.stringify(prev)
                                val c = Js.stringify(cur)
                                p == c || c.length < p.length
                            }
                            parts.put(
                                JSONObject().put("thoughtSignature", sig)
                                    .put("functionCall", JSONObject().put("name", item.opt("name")).put("args", args))
                            )
                        }
                        "tool_result" -> {
                            val toolCallIdAny = item.opt("tool_use_id")
                            val actualName = Js.or(
                                Js.or(
                                    Js.or(item.opt("name"), if (toolCallIdAny == null) null else toolNameMap[Js.cat(toolCallIdAny)]),
                                    SignatureCache.signatureCache.getName(if (toolCallIdAny == null || toolCallIdAny == JSONObject.NULL) "" else Js.cat(toolCallIdAny))
                                ), "tool_response"
                            )
                            var responseContent: Any? = item.opt("content")
                            if (responseContent is JSONArray) {
                                // 文本块拼接为纯文本；图片块转为 inlineData 跟在本轮之后；其它块保留 JSON 原文
                                val texts = ArrayList<Any?>()
                                for (k in 0 until responseContent.length()) {
                                    val b = responseContent.opt(k)
                                    val bo = b as? JSONObject
                                    val bsrc = bo?.opt("source") as? JSONObject
                                    if (bo != null && bo.opt("type") == "text") texts.add(Js.or(bo.opt("text"), ""))
                                    else if (bo != null && bo.opt("type") == "image" && Js.truthy(bsrc?.opt("data"))) {
                                        mediaParts.add(
                                            JSONObject().put(
                                                "inlineData", JSONObject().put("mimeType", Js.or(bsrc!!.opt("media_type"), "image/jpeg")).put("data", bsrc.opt("data"))
                                            )
                                        )
                                    } else if (b != null && b != JSONObject.NULL) texts.add(if (b is String) b else Js.stringify(b))
                                }
                                responseContent = joinStr(texts, "\n")
                            } else if (responseContent !is String) {
                                responseContent = if (responseContent == null || responseContent == JSONObject.NULL) "" else Js.stringify(responseContent)
                            }
                            responseContent = pinIf(conv + ":fr:" + Js.cat(toolCallIdAny) + ":" + Js.cat(actualName), responseContent) { a, b ->
                                HistoryPin.looksTrimmed(a, b)
                            }
                            parts.put(
                                JSONObject().put(
                                    "functionResponse", JSONObject().put("name", actualName)
                                        .put("response", JSONObject().put("output", responseContent))
                                )
                            )
                        }
                        "image" -> if (Js.truthy(source?.opt("data"))) {
                            parts.put(
                                JSONObject().put(
                                    "inlineData", JSONObject().put("mimeType", Js.or(source!!.opt("media_type"), "image/jpeg")).put("data", source.opt("data"))
                                )
                            )
                        }
                        "document" -> {
                            // PDF 等 base64 文档块：Gemini 原生支持 inlineData
                            if (source?.opt("type") == "base64" && Js.truthy(source.opt("data"))) {
                                parts.put(
                                    JSONObject().put(
                                        "inlineData", JSONObject().put("mimeType", Js.or(source.opt("media_type"), "application/pdf")).put("data", source.opt("data"))
                                    )
                                )
                            } else if (source?.opt("type") == "text" && Js.truthy(source.opt("data"))) {
                                parts.put(JSONObject().put("text", Js.cat(source.opt("data"))))
                            }
                        }
                    }
                }
                for (mp in mediaParts) parts.put(mp)
            }

            if (parts.length() > 0) rawContents.add(JSONObject().put("role", role).put("parts", parts))
        }

        // 3. 规范化 contents
        // Step A: 剔除空 text part 及没有任何 part 的无效轮次
        var i = rawContents.size - 1
        while (i >= 0) {
            val c = rawContents[i]
            val ps = c.getJSONArray("parts")
            val kept = JSONArray()
            for (k in 0 until ps.length()) {
                val p = ps.opt(k) as? JSONObject
                val text = p?.opt("text")
                if (p != null && p.has("text") && text is String && !Js.truthy(p.opt("thought"))) {
                    if (Js.trim(text).isNotEmpty()) kept.put(p)
                } else kept.put(ps.opt(k))
            }
            c.put("parts", kept)
            if (kept.length() == 0) rawContents.removeAt(i)
            i--
        }

        // Step B: 合并连续相同角色
        val contents = ArrayList<JSONObject>()
        for (item in rawContents) {
            if (contents.isNotEmpty() && contents.last().opt("role") == item.opt("role")) {
                appendAll(contents.last().getJSONArray("parts"), item.getJSONArray("parts"))
            } else contents.add(item)
        }

        // Step C: 第一条必须是 user
        if (contents.isNotEmpty() && contents[0].opt("role") == "model") {
            contents.add(0, JSONObject().put("role", "user").put("parts", JSONArray().put(JSONObject().put("text", "Hello"))))
        }

        // Step D: 再次合并相邻相同角色（兜底）
        var d = 0
        while (d < contents.size - 1) {
            if (contents[d].opt("role") == contents[d + 1].opt("role")) {
                appendAll(contents[d].getJSONArray("parts"), contents[d + 1].getJSONArray("parts"))
                contents.removeAt(d + 1)
                d--
            }
            d++
        }

        // 4. 工具声明（按工具名排序固化 + 会话级工具全量锁定，保护前缀缓存哈希）
        var tools: JSONArray? = null
        val reqTools = anthropicRequest.opt("tools") as? JSONArray
        if (reqTools != null && reqTools.length() > 0) {
            val list = ArrayList<JSONObject>()
            for (k in 0 until reqTools.length()) list.add(reqTools.opt(k) as? JSONObject ?: JSONObject())
            val coll = Collator.getInstance(Locale.ROOT)
            val sorted = list.sortedWith { a, b -> coll.compare(Js.cat(Js.or(a.opt("name"), "")), Js.cat(Js.or(b.opt("name"), ""))) }
            var functionDeclarations: Any? = JSONArray().also { arr ->
                for (t in sorted) {
                    arr.put(
                        JSONObject().put("name", t.opt("name"))
                            .put("description", Js.or(t.opt("description"), ""))
                            .put("parameters", SchemaSanitizer.sanitizeSchema(Js.or(t.opt("input_schema"), JSONObject())))
                    )
                }
            }
            functionDeclarations = if (HistoryPin.historyPin.active) {
                pinIf("$conv:tools", functionDeclarations) { a, b -> HistoryPin.sameToolNames(a, b) }
            } else {
                (SessionRouter.pinToolDescriptions(conv, functionDeclarations as JSONArray) as Any?)
            }
            tools = JSONArray().put(JSONObject().put("functionDeclarations", functionDeclarations))
        }

        // 换行统一（CRLF→LF）+ 尾部空白修剪，保证同一轮次字节级幂等
        for (idx in contents.indices) {
            val c = contents[idx]
            val ps = c.getJSONArray("parts")
            for (k in 0 until ps.length()) {
                val part = ps.opt(k) as? JSONObject ?: continue
                val text = part.opt("text")
                if (text is String && !Js.truthy(part.opt("thought"))) {
                    part.put("text", Js.trimEnd(text.replace("\r\n", "\n")))
                }
                val resp = (part.opt("functionResponse") as? JSONObject)?.opt("response") as? JSONObject
                val out = resp?.opt("output")
                if (out is String) resp.put("output", Js.trimEnd(out.replace("\r\n", "\n")))
            }
            // 锁定首次见到的模型完整 parts（含 thought 与原始签名），免疫客户端的中间修剪
            if (c.opt("role") == "model" && HistoryPin.historyPin.active) {
                c.put("parts", pinIf("$conv:model_parts:$idx", c.opt("parts")) { a, b -> HistoryPin.sameVisibleParts(a, b) })
            }
        }

        // 5. 首条用户提示词锁定
        if (HistoryPin.historyPin.active && contents.isNotEmpty() && contents[0].opt("role") == "user") {
            val firstPart = (contents[0].opt("parts") as? JSONArray)?.opt(0) as? JSONObject
            if (firstPart != null && firstPart.opt("text") is String) {
                firstPart.put("text", pinIf("$conv:u:0", firstPart.opt("text")) { a, b -> HistoryPin.nearSameText(a, b) })
            }
        }

        // 6. 系统提示词锁定（只对 systemInstruction 本身做稳定化）
        if (HistoryPin.historyPin.active && systemInstruction != null) {
            val cur = systemInstruction.getJSONArray("parts").getJSONObject(0).opt("text")
            val pinned = pinIf("$conv:sys", cur) { a, b -> HistoryPin.nearSameText(a, b) }
            if (Js.truthy(pinned)) {
                systemInstruction = JSONObject().put("role", "user").put("parts", JSONArray().put(JSONObject().put("text", pinned)))
            }
        }

        val result = JSONObject().put("contents", JSONArray(contents))
        if (systemInstruction != null) result.put("systemInstruction", systemInstruction)
        if (tools != null) result.put("tools", tools)
        return result
    }

    private fun appendAll(dst: JSONArray, src: JSONArray) {
        for (k in 0 until src.length()) dst.put(src.opt(k))
    }

    /**
     * 将非流式 Google 响应转为 Anthropic Message。
     * 网关内部记账用的 usage（含思考 token 明细，= Node 版 _gw_usage）用 Usage.gwUsage(message) 取。
     */
    @JvmStatic
    fun convertGoogleToAnthropic(googleData: JSONObject?, originalModel: String?): JSONObject {
        val responseObj = (googleData?.opt("response") as? JSONObject) ?: googleData
        val candidate = (responseObj?.opt("candidates") as? JSONArray)?.opt(0) as? JSONObject
        val parts = ((candidate?.opt("content") as? JSONObject)?.opt("parts") as? JSONArray) ?: JSONArray()
        val anthropicContent = JSONArray()
        var stopReason = "end_turn"

        for (k in 0 until parts.length()) {
            val part = parts.opt(k) as? JSONObject ?: continue
            val sig = Js.or(part.opt("thoughtSignature"), part.opt("thought_signature"))

            if (Js.truthy(part.opt("thought"))) {
                anthropicContent.put(
                    JSONObject().put("type", "thinking").put("thinking", Js.or(part.opt("text"), ""))
                        .put("signature", Js.or(sig, FALLBACK))
                )
            } else if (part.has("text") && part.opt("text") != "") {
                anthropicContent.put(JSONObject().put("type", "text").put("text", part.opt("text")))
            }

            val fc = part.opt("functionCall") as? JSONObject
            if (fc != null) {
                stopReason = "tool_use"
                val callId = Js.or(fc.opt("id"), "toolu_" + Js.randomHex(12))
                val name = fc.opt("name")
                SignatureCache.signatureCache.set(Js.cat(callId), (if (Js.truthy(sig)) sig else FALLBACK) as String, if (name is String) name else "")
                anthropicContent.put(
                    JSONObject().put("type", "tool_use").put("id", callId).put("name", name)
                        .put("input", Js.or(fc.opt("args"), JSONObject()))
                )
            }
        }

        // MAX_TOKENS → max_tokens（工具调用优先）
        if (stopReason != "tool_use" && candidate?.opt("finishReason") == "MAX_TOKENS") stopReason = "max_tokens"

        // 兜底：内容为空时检查 SAFETY；补全文本块防止下游客户端解析崩溃
        if (anthropicContent.length() == 0) {
            val blocked = (responseObj?.opt("promptFeedback") as? JSONObject)?.opt("blockReason") == "SAFETY"
            if (candidate?.opt("finishReason") == "SAFETY" || blocked) {
                anthropicContent.put(JSONObject().put("type", "text").put("text", "[提示：上游安全策略拦截了当前内容生成，请微调提示词或去除敏感关键字后重试。]"))
            } else {
                anthropicContent.put(JSONObject().put("type", "text").put("text", ""))
            }
        }

        val usage = Usage.normalizeGeminiUsage(responseObj?.opt("usageMetadata") as? JSONObject)
        val message = JSONObject()
            .put("id", "msg_" + Js.randomHex(12))
            .put("type", "message")
            .put("role", "assistant")
            .put("model", originalModel)
            .put("content", anthropicContent)
            .put("stop_reason", stopReason)
            .put("stop_sequence", JSONObject.NULL)
            .put("usage", Usage.toAnthropicUsage(usage))
        Usage.attachGwUsage(message, usage)
        return message
    }
}
