package com.wag2api.ag

import org.json.JSONArray
import org.json.JSONObject
import java.util.UUID

/**
 * Google Cloud Code / Antigravity Dispatcher（移植自 src/cloudcode.mjs）
 *
 * 发送时请用 JsCompat.stringify(payload) 序列化（与 Node 的 JSON.stringify 字节一致，org.json 的 toString 会转义 "/"）。
 */
object Cloudcode {
    private fun firstUser(req: JSONObject): JSONObject? {
        val ms = req.optJSONArray("messages") ?: return null
        for (i in 0 until ms.length()) {
            val m = ms.optJSONObject(i) ?: continue
            if (m.opt("role") == "user") return m
        }
        return null
    }

    /**
     * 稳定会话 ID：sha256(首条用户消息文本) 取前 8 字节，屏蔽符号位，前缀 "-"（与 CLIProxyAPI 一致）。
     */
    @JvmStatic
    fun stableSessionId(anthropicRequest: JSONObject): String {
        val first = firstUser(anthropicRequest)
        var text = ""
        if (first != null) {
            val c = first.opt("content")
            if (c is String) text = c
            else if (c is JSONArray) {
                val parts = ArrayList<String>()
                for (i in 0 until c.length()) {
                    val p = c.optJSONObject(i) ?: continue
                    if (p.opt("type") == "text") { val t = p.opt("text"); parts.add(if (JsCompat.truthy(t)) JsCompat.str(t) else "") }
                }
                text = parts.joinToString("\n")
            }
        }
        if (text.isEmpty()) text = JsCompat.stringify(JsCompat.or(first, anthropicRequest.opt("system"), "")) ?: ""
        return JsCompat.sid(text)
    }

    /** 模型别名与降级链映射表（Claude 3P 配额耗尽时降级到 Gemini 旗舰以防中断） */
    @JvmField
    val MODEL_FALLBACK_CHAINS: Map<String, List<String>> = linkedMapOf(
        "gemini-3.8-flash-fast" to listOf("gemini-2.5-flash", "gemini-3-flash"),
        // PR1：按智力从高到低，只留同代思考模型
        "gemini-3.8-flash-high" to listOf("gemini-3.6-flash-high", "gemini-3-flash"),
        "gemini-3.8-flash" to listOf("gemini-3-flash", "gemini-2.5-flash"),
        "gemini-3.1-pro-high" to listOf("gemini-3.1-pro-low", "gemini-2.5-pro"),
        "claude-opus-4-6" to listOf("claude-opus-4-6-thinking", "claude-sonnet-4-6", "gemini-3.8-flash-tiered"),
        "claude-sonnet-4-6" to listOf("claude-opus-4-6-thinking", "gemini-3.8-flash-tiered"),
    )

    /** 官方底层模型标识映射 */
    @JvmStatic
    @JvmOverloads
    fun mapToUpstreamModel(clientModel: String? = ""): String {
        val cm = clientModel ?: ""
        val m = cm.lowercase()
        // 3.8-flash 家族统一映射至 gemini-3.8-flash-tiered，切换 fast 时前缀 KV-Cache 不丢
        if (m.contains("3.8-flash") || m.contains("flash-fast")) return "gemini-3.8-flash-tiered"
        if (m.contains("3.6-flash")) return "gemini-3.6-flash-high"
        if (m.contains("3.1-pro")) return "gemini-3.1-pro-high"
        if (m.contains("2.5-flash")) return "gemini-2.5-flash-thinking"
        if (m.contains("claude-opus")) return "claude-opus-4-6-thinking"
        if (m.contains("claude-sonnet")) return "claude-sonnet-4-6"
        return cm
    }

    @JvmStatic
    fun buildAntigravityHeaders(accessToken: String?): Map<String, String> = linkedMapOf(
        "Authorization" to "Bearer ${JsCompat.str(accessToken)}",
        "Content-Type" to "application/json",
        "User-Agent" to "antigravity/4.3.0 linux/arm64",
        "X-Client-Name" to "antigravity",
        "Connection" to "keep-alive",
    )

    /** 递归对对象属性按字母排序（Canonical JSON），返回新对象；JS 对象里整数形 key 仍排在最前 */
    @JvmStatic
    fun canonicalize(obj: Any?): Any? {
        if (obj is JSONArray) {
            val a = JSONArray()
            for (i in 0 until obj.length()) a.put(canonicalize(obj.opt(i)) ?: JSONObject.NULL)
            return a
        }
        if (obj !is JSONObject) return obj
        val keys = ArrayList<String>()
        val it = obj.keys()
        while (it.hasNext()) keys.add(it.next())
        keys.sort()
        val tmp = JSONObject()
        for (k in keys) tmp.put(k, canonicalize(obj.opt(k)))
        // 再按 JS 枚举规则排一次（整数形 key 升序在前），与 Node 的结果对象顺序一致
        val ordered = JsCompat.keysInJsOrder(tmp)
        if (ordered == keys) return tmp
        val r = JSONObject()
        for (k in ordered) r.put(k, tmp.opt(k))
        return r
    }

    private val CLAUDE_RE = Regex("claude", RegexOption.IGNORE_CASE)
    private val JSONISH_GEMINI3 = Regex("^gemini-3")
    private val LEVEL_RE = Regex("-(low|medium|high)\\b")

    private fun safety(category: String) = JSONObject().put("category", category).put("threshold", "BLOCK_NONE")

    @JvmStatic
    @JvmOverloads
    fun buildCloudCodePayload(anthropicRequest: JSONObject, project: String? = ""): JSONObject {
        val convAny: Any? = ContentConverter.convertAnthropicToGoogle(anthropicRequest)
        val conv = convAny as? JSONObject ?: throw IllegalStateException("convertAnthropicToGoogle 应返回 JSONObject{contents, systemInstruction, tools}")
        val contents = conv.opt("contents")
        val systemInstruction = conv.opt("systemInstruction")
        val tools = conv.opt("tools")
        val modelV = anthropicRequest.opt("model")
        val model: String = if (modelV is String) modelV else ""
        val upstreamModel = mapToUpstreamModel(model)
        val hasTools = tools is JSONArray && tools.length() > 0

        val generationConfig = JSONObject()
        val mt = anthropicRequest.opt("max_tokens")
        generationConfig.put("maxOutputTokens", if (JsCompat.truthy(mt)) mt else 8192)
        val temp = anthropicRequest.opt("temperature")
        generationConfig.put("temperature", if (JsCompat.isNullish(temp)) 0.7 else temp)
        val isClaudeUpstream = CLAUDE_RE.containsMatchIn(upstreamModel)
        // 采样参数：客户端有就传，没有就不传
        anthropicRequest.opt("top_p").let { if (it is Number) generationConfig.put("topP", it) }
        anthropicRequest.opt("top_k").let { if (it is Number) generationConfig.put("topK", it) }
        // 停止序列：Gemini 最多 5 个；Claude-on-AG 不下发
        val ss = anthropicRequest.opt("stop_sequences")
        if (!isClaudeUpstream && ss is JSONArray) {
            val stops = JSONArray()
            for (i in 0 until ss.length()) {
                val x = ss.opt(i)
                if (x is String && x.isNotEmpty() && stops.length() < 5) stops.put(x)
            }
            if (stops.length() > 0) generationConfig.put("stopSequences", stops)
        }
        // 结构化输出：response_format / output_format(output_config.format) → responseMimeType + responseSchema
        val oc = anthropicRequest.optJSONObject("output_config")
        val fmt = JsCompat.or(anthropicRequest.opt("response_format"), anthropicRequest.opt("output_format"), oc?.opt("format"), null)
        if (!isClaudeUpstream && fmt is JSONObject) {
            val type = fmt.opt("type")
            if (type == "json_object") {
                generationConfig.put("responseMimeType", "application/json")
            } else if (type == "json_schema") {
                generationConfig.put("responseMimeType", "application/json")
                val schema = JsCompat.or(fmt.optJSONObject("json_schema")?.opt("schema"), fmt.opt("schema"), null)
                if (schema is JSONObject) {
                    val s: Any? = SchemaSanitizer.sanitizeSchema(schema)
                    generationConfig.put("responseSchema", s ?: JSONObject.NULL)
                }
            }
        }

        // 思考模式配置
        val isHighReasoning = model.isNotEmpty() && (model.contains("high") || model.contains("thinking") || model.contains("opus"))
        val isGemini3 = JSONISH_GEMINI3.containsMatchIn(upstreamModel) || upstreamModel == "gemini-pro-agent"
        val isFlash = upstreamModel.contains("flash")
        val levelMatch = LEVEL_RE.find(model)?.groupValues?.get(1)
        val clientEffort = JsCompat.or(anthropicRequest.opt("reasoning_effort"), oc?.opt("effort"), null)
        val thinking = anthropicRequest.optJSONObject("thinking")
        val thinkingEnabled = thinking?.opt("type") == "enabled"
        val budget = if (thinkingEnabled) JsCompat.number(thinking!!.opt("budget_tokens")).let { if (it.isNaN()) 0.0 else it } else 0.0
        val budgetLevel = if (budget >= 16384) "high" else if (budget >= 4096) "medium" else if (budget > 0) "low" else null
        val effort = if (clientEffort is String && clientEffort in listOf("low", "medium", "high")) clientEffort else null
        val resolvedLevel = levelMatch ?: effort ?: budgetLevel ?: (if (isHighReasoning) "high" else if (isFlash) "low" else "high")

        if (model.contains("fast")) {
            // fast 模式：最低思考等级（low），极速吐字
            generationConfig.put("thinkingConfig", JSONObject().put("includeThoughts", true).put("thinkingLevel", "low").put("thinkingBudget", 0))
        } else if (isGemini3) {
            val tc = JSONObject().put("includeThoughts", true).put("thinkingLevel", resolvedLevel)
            if (resolvedLevel == "low" && isFlash) tc.put("thinkingBudget", 0)
            generationConfig.put("thinkingConfig", tc)
        } else if (thinkingEnabled) {
            val bt = thinking!!.opt("budget_tokens")
            generationConfig.put("thinkingConfig", JSONObject().put("includeThoughts", true).put("thinkingBudget", if (JsCompat.truthy(bt)) bt else 2048))
        } else if (hasTools) {
            // Claude 等非 Gemini 3 模型：带工具且客户端未要求思考时不思考
            generationConfig.put("thinkingConfig", JSONObject().put("includeThoughts", false).put("thinkingBudget", 0))
        } else if (isHighReasoning) {
            val isSonnet = model.contains("sonnet")
            generationConfig.put("thinkingConfig", JSONObject().put("includeThoughts", true).put("thinkingBudget", if (isSonnet) 1024 else 2048))
        }

        val request = JSONObject()
        request.put("contents", contents ?: JSONObject.NULL)
        request.put("generationConfig", generationConfig)
        request.put("safetySettings", JSONArray()
            .put(safety("HARM_CATEGORY_HARASSMENT"))
            .put(safety("HARM_CATEGORY_HATE_SPEECH"))
            .put(safety("HARM_CATEGORY_SEXUALLY_EXPLICIT"))
            .put(safety("HARM_CATEGORY_DANGEROUS_CONTENT"))
            .put(safety("HARM_CATEGORY_CIVIC_INTEGRITY")))

        if (JsCompat.truthy(systemInstruction)) request.put("systemInstruction", systemInstruction)
        if (hasTools) {
            request.put("tools", tools)
            // Claude 用 VALIDATED，Gemini 用 AUTO
            val isClaude = model.isNotEmpty() && model.lowercase().contains("claude")
            val fcc = JSONObject().put("mode", if (isClaude) "VALIDATED" else "AUTO")
            val toolConfig = JSONObject().put("functionCallingConfig", fcc)
            request.put("toolConfig", toolConfig)
            // tool_choice：none/any/tool 显式映射，auto 或未传保持默认
            val tc = anthropicRequest.opt("tool_choice")
            val tcType = if (tc is String) tc else (tc as? JSONObject)?.opt("type")
            if (tcType == "none") {
                toolConfig.put("functionCallingConfig", JSONObject().put("mode", "NONE"))
            } else if (tcType == "any" || tcType == "required") {
                toolConfig.put("functionCallingConfig", JSONObject().put("mode", "ANY"))
            } else if (tcType == "tool" && tc is JSONObject && JsCompat.truthy(tc.opt("name"))) {
                toolConfig.put("functionCallingConfig", JSONObject().put("mode", "ANY").put("allowedFunctionNames", JSONArray().put(JsCompat.str(tc.opt("name")))))
            }
        }

        val em = anthropicRequest.opt("_gwEmail")
        request.put("sessionId", SessionRouter.resolveSessionId(anthropicRequest, if (JsCompat.truthy(em)) JsCompat.str(em) else ""))
        val payload = JSONObject()
        payload.put("model", upstreamModel)
        payload.put("userAgent", "antigravity")
        payload.put("requestId", "agent-" + UUID.randomUUID().toString())
        payload.put("request", canonicalize(request))
        if (!project.isNullOrEmpty() && project != "pending_detection") payload.put("project", project)
        return payload
    }
}
