package com.wag2api.app.ais

import org.json.JSONArray
import org.json.JSONObject
import java.security.MessageDigest
import java.util.Locale

/**
 * AI Studio 网页（MakerSuite Playground）私有协议：Google 格式请求 → GenerateContent 数组正文，
 * 以及 ListModels / 错误体的解析。字段位置按上游 Mag1cFall/AIStudio2API 的 docs/protocol.md（MIT）整理，代码自写。
 *
 * 输入是 App 已有的协议转换结果：ContentConverter.convertAnthropicToGoogle(anthropicReq)
 * = {contents:[{role, parts:[{text|inlineData|functionCall|functionResponse, thought?, thoughtSignature?}]}], systemInstruction?, tools?}
 *
 * 纯 JVM 代码（只依赖 org.json），可直接 JUnit。
 */
object MakerSuiteWire {
    const val RPC_BASE = "https://alkalimakersuite-pa.clients6.google.com/\$rpc/google.internal.alkali.applications.makersuite.v1.MakerSuiteService/"
    const val CONTENT_TYPE = "application/json+protobuf"
    /** GenerateContent 根数组中 WAA proof 的下标（protobuf field 5） */
    const val PROOF_INDEX = 4
    const val SKIP_SIGNATURE = "skip_thought_signature_validator"

    private val NULL: Any = JSONObject.NULL

    /** ListModels 里一个模型的默认值与能力 */
    data class ModelInfo(
        val id: String,
        val displayName: String = id,
        val inputLimit: Long = 0,
        val outputLimit: Long = 0,
        val methods: List<String> = emptyList(),
        val defaultTemperature: Double? = null,
        val defaultTopP: Double? = null,
        val defaultTopK: Long? = null,
        val capabilities: Set<Int> = emptySet(),
        val defaultThinkingLevel: Long? = null,
    ) {
        val thinking get() = 25 in capabilities
        val thinkingBudget get() = 35 in capabilities
        val thinkingLevel get() = 52 in capabilities
        val functions get() = 10 in capabilities
        val chat get() = capabilities.isEmpty() || 1 in capabilities

        fun toOpenAI(): JSONObject = JSONObject()
            .put("id", id).put("object", "model").put("owned_by", "google").put("name", displayName)
            .put("display_name", displayName)
            .put("context_window", inputLimit).put("max_tokens", outputLimit)
    }

    // ------------------------------------------------------------------ 通用：数组工具

    private fun arr(size: Int): JSONArray {
        val a = JSONArray()
        for (i in 0 until size) a.put(NULL)
        return a
    }

    /** 把 a 扩展到至少 index+1 长并写入 */
    fun setField(a: JSONArray, index: Int, v: Any?) {
        while (a.length() <= index) a.put(NULL)
        a.put(index, v ?: NULL)
    }

    private fun isNull(v: Any?) = v == null || v == JSONObject.NULL

    // ------------------------------------------------------------------ Struct（google.protobuf.Struct 的数组形式）

    fun encodeValue(v: Any?): JSONArray = when (v) {
        null, JSONObject.NULL -> JSONArray().put(0)
        is Boolean -> JSONArray().put(NULL).put(NULL).put(NULL).put(v)
        is Number -> JSONArray().put(NULL).put(v.toDouble().let { d -> if (d == Math.rint(d) && Math.abs(d) < 1e15) d.toLong() else d })
        is String -> JSONArray().put(NULL).put(NULL).put(v)
        is JSONObject -> arr(4).put(encodeStruct(v))
        is JSONArray -> {
            val vals = JSONArray()
            for (i in 0 until v.length()) vals.put(encodeValue(v.opt(i)))
            arr(5).put(JSONArray().put(vals))
        }
        else -> JSONArray().put(NULL).put(NULL).put(v.toString())
    }

    /** {k: v} → [[[k, value], ...]]，key 排序（与上游一致）；空对象为 [] */
    fun encodeStruct(o: JSONObject?): JSONArray {
        if (o == null || o.length() == 0) return JSONArray()
        val keys = o.keys().asSequence().toMutableList().sorted()
        val entries = JSONArray()
        for (k in keys) entries.put(JSONArray().put(k).put(encodeValue(o.opt(k))))
        return JSONArray().put(entries)
    }

    fun decodeValue(raw: Any?): Any {
        val a = raw as? JSONArray ?: return NULL
        if (a.length() >= 6 && a.opt(5) is JSONArray) {
            val out = JSONArray()
            val vals = (a.opt(5) as JSONArray).optJSONArray(0) ?: JSONArray()
            for (i in 0 until vals.length()) out.put(decodeValue(vals.opt(i)))
            return out
        }
        if (a.length() >= 5 && a.opt(4) is JSONArray) return decodeStruct(a.opt(4))
        if (a.length() >= 4 && a.opt(3) is Boolean) return a.opt(3)
        if (a.length() >= 3 && a.opt(2) is String) return a.opt(2)
        if (a.length() >= 2 && a.opt(1) is Number) return a.opt(1)
        return NULL
    }

    fun decodeStruct(raw: Any?): JSONObject {
        val out = JSONObject()
        val a = raw as? JSONArray ?: return out
        val entries = a.optJSONArray(0) ?: return out
        for (i in 0 until entries.length()) {
            val e = entries.optJSONArray(i) ?: continue
            val k = e.opt(0) as? String ?: continue
            out.put(k, decodeValue(e.opt(1)))
        }
        return out
    }

    // ------------------------------------------------------------------ Schema（Gemini Schema → Playground Schema 数组）

    private val TYPE_CODES = mapOf("string" to 1, "number" to 2, "integer" to 3, "boolean" to 4, "array" to 5, "object" to 6)
    private val SCHEMA_FIELDS = mapOf(
        "type" to 0, "format" to 1, "description" to 2, "nullable" to 3, "enum" to 4, "items" to 5, "properties" to 6, "required" to 7,
        "minProperties" to 8, "maxProperties" to 9, "minimum" to 10, "maximum" to 11, "minLength" to 12, "maxLength" to 13, "pattern" to 14,
        "anyOf" to 17, "maxItems" to 20, "minItems" to 21, "propertyOrdering" to 22,
    )

    /** Gemini 风格 schema（SchemaSanitizer 的输出，type 大小写都接受）→ Playground 数组；不认识的字段丢弃 */
    fun encodeSchema(s: JSONObject?): JSONArray {
        val wire = JSONArray()
        if (s == null) { setField(wire, 0, 6); return wire }
        val keys = s.keys().asSequence().toList()
        for (k in keys) {
            val idx = SCHEMA_FIELDS[k] ?: continue
            val v = s.opt(k)
            val enc: Any? = when (k) {
                "type" -> {
                    val t = when (v) {
                        is String -> v
                        is JSONArray -> (0 until v.length()).map { v.optString(it) }.firstOrNull { !it.equals("null", true) } ?: "string"
                        else -> "string"
                    }
                    TYPE_CODES[t.lowercase(Locale.ROOT)] ?: 1
                }
                "items" -> encodeSchema(v as? JSONObject)
                "properties" -> {
                    val p = v as? JSONObject ?: continue
                    val entries = JSONArray()
                    for (name in p.keys().asSequence().toList().sorted()) entries.put(JSONArray().put(name).put(encodeSchema(p.optJSONObject(name))))
                    entries
                }
                "anyOf" -> {
                    val list = v as? JSONArray ?: continue
                    val out = JSONArray()
                    for (i in 0 until list.length()) out.put(encodeSchema(list.optJSONObject(i)))
                    out
                }
                "enum", "required", "propertyOrdering" -> {
                    val list = v as? JSONArray ?: continue
                    val out = JSONArray()
                    for (i in 0 until list.length()) { val x = list.opt(i); if (x is String) out.put(x) }
                    if (out.length() == 0) continue
                    out
                }
                "minLength", "maxLength", "minItems", "maxItems", "minProperties", "maxProperties" -> (v as? Number)?.toLong() ?: continue
                else -> v
            }
            setField(wire, idx, enc)
        }
        if (wire.length() == 0 || isNull(wire.opt(0))) setField(wire, 0, if (s.has("properties")) 6 else 1)
        return wire
    }

    // ------------------------------------------------------------------ Content / Part

    /** Google Part（JSON 对象）→ Playground Part 数组；不支持的类型返回 null（丢弃） */
    fun encodePart(p: JSONObject, role: String): JSONArray? {
        val sig = p.optString("thoughtSignature", "").takeIf { it.isNotEmpty() }
        val text = p.opt("text")
        if (text is String && text.isNotEmpty()) {
            // 历史里的思考摘要不回传（AG 的签名对 AIS 无效）
            if (p.optBoolean("thought", false)) return null
            val w = JSONArray().put(NULL).put(text)
            return w
        }
        p.optJSONObject("inlineData")?.let { d ->
            val mime = d.optString("mimeType", "")
            val data = d.optString("data", "")
            if (mime.isEmpty() || data.isEmpty()) return null
            return JSONArray().put(NULL).put(NULL).put(JSONArray().put(mime).put(data))
        }
        p.optJSONObject("functionCall")?.let { fc ->
            val call = JSONArray().put(fc.optString("name", "")).put(encodeStruct(fc.optJSONObject("args")))
            val id = fc.optString("id", "")
            if (id.isNotEmpty()) call.put(id)
            val w = arr(11)
            w.put(10, call)
            // AG 的兜底签名对 AIS 无效：没有真实签名时用上游约定的跳过值
            setField(w, 14, if (sig == null || sig == com.wag2api.ag.SignatureCache.FALLBACK_THOUGHT_SIGNATURE) SKIP_SIGNATURE else sig)
            return w
        }
        p.optJSONObject("functionResponse")?.let { fr ->
            val resp = fr.opt("response")
            val obj = resp as? JSONObject ?: JSONObject().put("output", resp ?: "")
            val r = JSONArray().put(fr.optString("name", "")).put(encodeStruct(obj))
            val id = fr.optString("id", "")
            if (id.isNotEmpty()) r.put(id)
            val w = arr(12)
            w.put(11, r)
            return w
        }
        return null
    }

    fun encodeContents(contents: JSONArray?): JSONArray {
        val out = JSONArray()
        if (contents == null) return out
        for (i in 0 until contents.length()) {
            val c = contents.optJSONObject(i) ?: continue
            val role = if (c.optString("role") == "model") "model" else "user"
            val parts = JSONArray()
            val ps = c.optJSONArray("parts") ?: continue
            for (j in 0 until ps.length()) {
                val p = ps.optJSONObject(j) ?: continue
                encodePart(p, role)?.let { parts.put(it) }
            }
            if (parts.length() == 0) continue
            out.put(JSONArray().put(parts).put(role))
        }
        return out
    }

    /**
     * WAA binding prompt：所有 content 的 Part 依次取文本 / inline data 的 base64 / 其他为空串，以空格连接（与上游 bindingPrompt 一致）。
     * 摘要是它的 SHA-256 小写十六进制。
     */
    fun bindingPrompt(wireContents: JSONArray): String {
        val values = ArrayList<String>()
        for (i in 0 until wireContents.length()) {
            val parts = wireContents.optJSONArray(i)?.optJSONArray(0) ?: continue
            for (j in 0 until parts.length()) {
                val p = parts.optJSONArray(j) ?: continue
                val t = p.opt(1)
                val inline = p.opt(2) as? JSONArray
                values.add(when {
                    t is String && t.isNotEmpty() -> t
                    inline != null -> inline.optString(1, "")
                    else -> ""
                })
            }
        }
        return values.joinToString(" ")
    }

    /** 写进页面输入框的提示词：最后一个 content 里的文本以空格连接 */
    fun pagePrompt(wireContents: JSONArray): String {
        if (wireContents.length() == 0) return ""
        val parts = wireContents.optJSONArray(wireContents.length() - 1)?.optJSONArray(0) ?: return ""
        val values = ArrayList<String>()
        for (j in 0 until parts.length()) {
            val t = parts.optJSONArray(j)?.opt(1)
            if (t is String && t.isNotEmpty()) values.add(t)
        }
        return values.joinToString(" ")
    }

    fun sha256Hex(s: String): String =
        MessageDigest.getInstance("SHA-256").digest(s.toByteArray(Charsets.UTF_8)).joinToString("") { "%02x".format(it) }

    // ------------------------------------------------------------------ GenerateContent

    private fun effortLevel(effort: String?): Long? = when (effort?.trim()?.lowercase(Locale.ROOT)) {
        "low" -> 1
        "medium" -> 2
        "high", "xhigh", "max" -> 3
        "minimal", "none" -> 4
        else -> null
    }

    private fun levelForBudget(b: Long): Long = when {
        b <= 0 -> 4
        b <= 1024 -> 1
        b <= 8192 -> 2
        else -> 3
    }

    /**
     * 生成配置数组。anthropicReq：Anthropic Messages 请求（OpenAI 请求先经 OpenaiAgConverter 转过来）。
     */
    fun encodeGenerationConfig(anthropicReq: JSONObject, model: ModelInfo?): JSONArray {
        val cfg = arr(14)
        val stops = anthropicReq.optJSONArray("stop_sequences")
        if (stops != null && stops.length() > 0) {
            val s = JSONArray()
            for (i in 0 until stops.length()) { val x = stops.opt(i); if (x is String && x.isNotEmpty() && s.length() < 5) s.put(x) }
            if (s.length() > 0) cfg.put(1, s)
        }
        val limit = model?.outputLimit?.takeIf { it > 0 } ?: 65536L
        val reqMax = anthropicReq.optLong("max_tokens", 0L)
        cfg.put(3, if (reqMax > 0) Math.min(reqMax, limit) else limit)
        val temp = anthropicReq.opt("temperature")
        when {
            temp is Number -> cfg.put(4, temp.toDouble())
            model?.defaultTemperature != null -> cfg.put(4, model.defaultTemperature)
        }
        val topP = anthropicReq.opt("top_p")
        when {
            topP is Number -> cfg.put(5, topP.toDouble())
            model?.defaultTopP != null -> cfg.put(5, model.defaultTopP)
        }
        val topK = anthropicReq.opt("top_k")
        when {
            topK is Number -> cfg.put(6, topK.toLong())
            model?.defaultTopK != null -> cfg.put(6, model.defaultTopK)
        }
        cfg.put(13, 1)

        // 思考：模型能力未知（目录没拉到）时按名字猜：gemini-2.5 / gemini-3 系都支持
        val id = model?.id ?: anthropicReq.optString("model", "")
        val guessThinking = model == null || model.capabilities.isEmpty()
        val canThink = if (guessThinking) Regex("gemini-(2\\.5|3)").containsMatchIn(id) else model!!.thinking || model.thinkingBudget || model.thinkingLevel
        val canLevel = if (guessThinking) Regex("gemini-3").containsMatchIn(id) else model!!.thinkingLevel
        val canBudget = if (guessThinking) !canLevel else model!!.thinkingBudget
        val thinking = anthropicReq.optJSONObject("thinking")
        val budget: Long? = if (thinking?.optString("type") == "enabled") thinking.optLong("budget_tokens", 0) else if (thinking?.optString("type") == "disabled") 0L else null
        val effort = anthropicReq.optString("reasoning_effort", "").ifEmpty { anthropicReq.optJSONObject("output_config")?.optString("effort", "") ?: "" }
        if (canThink || budget != null || effort.isNotEmpty()) {
            val t = JSONArray().put(1)
            if (canLevel) {
                val lvl = effortLevel(effort) ?: budget?.let { levelForBudget(it) } ?: model?.defaultThinkingLevel
                if (lvl != null) setField(t, 3, lvl)
            }
            if (canBudget && budget != null) setField(t, 1, budget)
            setField(cfg, 16, t)
        }
        return cfg
    }

    private fun encodeTools(tools: JSONArray?): JSONArray? {
        if (tools == null) return null
        val decls = JSONArray()
        for (i in 0 until tools.length()) {
            val fds = tools.optJSONObject(i)?.optJSONArray("functionDeclarations") ?: continue
            for (j in 0 until fds.length()) {
                val fd = fds.optJSONObject(j) ?: continue
                val name = fd.optString("name", "")
                if (name.isEmpty()) continue
                decls.put(JSONArray().put(name).put(fd.optString("description", "")).put(encodeSchema(fd.optJSONObject("parameters") ?: JSONObject().put("type", "object"))))
            }
        }
        if (decls.length() == 0) return null
        return JSONArray().put(JSONArray().put(NULL).put(decls))
    }

    /**
     * 组 GenerateContent 正文（proof 位先放 null，发送前由 [withProof] 写入）。
     * google：ContentConverter 的输出；anthropicReq：用于生成参数；timezone：账号时区（带工具时写入 tool config）。
     */
    fun buildGenerateContent(modelId: String, google: JSONObject, anthropicReq: JSONObject, model: ModelInfo?, timezone: String?): JSONArray {
        val contents = encodeContents(google.optJSONArray("contents"))
        if (contents.length() == 0) throw IllegalArgumentException("GenerateContent contents 不能为空")
        val tools = if (anthropicReq.optJSONObject("tool_choice")?.optString("type") == "none" || anthropicReq.opt("tool_choice") == "none") null
        else encodeTools(google.optJSONArray("tools"))
        val wire = arr(if (tools != null) 14 else 11)
        wire.put(0, if (modelId.startsWith("models/")) modelId else "models/$modelId")
        wire.put(1, contents)
        val safety = JSONArray()
        for (cat in intArrayOf(7, 8, 9, 10)) safety.put(JSONArray().put(NULL).put(NULL).put(cat).put(5))
        wire.put(2, safety)
        wire.put(3, encodeGenerationConfig(anthropicReq, model))
        val sys = google.optJSONObject("systemInstruction")?.optJSONArray("parts")
        if (sys != null) {
            val ps = JSONArray()
            for (i in 0 until sys.length()) {
                val t = sys.optJSONObject(i)?.optString("text", "") ?: ""
                if (t.isNotEmpty()) ps.put(JSONArray().put(NULL).put(t))
            }
            if (ps.length() > 0) wire.put(5, JSONArray().put(ps).put("user"))
        }
        if (tools != null) wire.put(6, tools)
        wire.put(10, 1)
        if (tools != null) wire.put(13, JSONArray().put(JSONArray().put(NULL).put(NULL).put(timezone?.ifEmpty { null } ?: "UTC")))
        return wire
    }

    /** 写入 proof，返回紧凑 JSON 正文 */
    fun withProof(wire: JSONArray, proof: String): String {
        wire.put(PROOF_INDEX, proof)
        return wire.toString()
    }

    // ------------------------------------------------------------------ ListModels

    private fun longAt(a: JSONArray, i: Int): Long = (a.opt(i) as? Number)?.toLong() ?: (a.opt(i) as? String)?.toLongOrNull() ?: 0L

    /** ListModels 响应 → 模型表（只留能 generateContent 的聊天模型） */
    fun parseModels(text: String): List<ModelInfo> {
        val root = JSONArray(normalizeSparse(text))
        val rows = root.optJSONArray(0) ?: return emptyList()
        val out = ArrayList<ModelInfo>()
        for (i in 0 until rows.length()) {
            val r = rows.optJSONArray(i) ?: continue
            val name = r.optString(0, "")
            if (!name.startsWith("models/")) continue
            val methods = ArrayList<String>()
            r.optJSONArray(7)?.let { m -> for (j in 0 until m.length()) methods.add(m.optString(j)) }
            val caps = HashSet<Int>()
            r.optJSONArray(64)?.let { c -> for (j in 0 until c.length()) (c.opt(j) as? Number)?.let { caps.add(it.toInt()) } }
            val thinkingDefault = r.optJSONArray(71)?.opt(5) as? Number
            val info = ModelInfo(
                id = name.removePrefix("models/"),
                displayName = r.optString(3, "").ifEmpty { name.removePrefix("models/") },
                inputLimit = longAt(r, 5),
                outputLimit = longAt(r, 6),
                methods = methods,
                defaultTemperature = (r.opt(8) as? Number)?.toDouble(),
                defaultTopP = (r.opt(9) as? Number)?.toDouble(),
                defaultTopK = (r.opt(10) as? Number)?.toLong(),
                capabilities = caps,
                defaultThinkingLevel = thinkingDefault?.toLong(),
            )
            if (methods.isNotEmpty() && methods.none { it.equals("generateContent", true) }) continue
            if (caps.isNotEmpty() && !info.chat) continue
            out.add(info)
        }
        return out
    }

    // ------------------------------------------------------------------ 错误

    class RpcError(val httpStatus: Int, val code: Int, override val message: String) : Exception(message) {
        /** 映射成给客户端的 HTTP 状态 */
        fun clientStatus(): Int = when {
            code == 8 || httpStatus == 429 -> 429
            code == 16 || httpStatus == 401 -> 401
            code == 7 || httpStatus == 403 -> 403
            code == 3 || httpStatus == 400 -> 400
            code == 5 || httpStatus == 404 -> 404
            httpStatus in 500..599 -> 502
            else -> if (httpStatus in 400..499) httpStatus else 502
        }
    }

    /** 错误体 [null,[code,message,...]] 或 [code,message,...] → RpcError */
    fun decodeError(httpStatus: Int, text: String): RpcError {
        try {
            val root = JSONArray(normalizeSparse(text.trim()))
            val inner = if (root.opt(1) is JSONArray) root.optJSONArray(1)!! else root
            val code = (inner.opt(0) as? Number)?.toInt() ?: 0
            val msg = inner.opt(1) as? String
            return RpcError(httpStatus, code, msg ?: "AI Studio 返回 HTTP $httpStatus")
        } catch (e: Exception) {
            return RpcError(httpStatus, 0, "AI Studio 返回 HTTP $httpStatus: " + text.take(300))
        }
    }

    // ------------------------------------------------------------------ 稀疏数组

    /** Google 响应会省略空槽（[,1] / [1,,2] / [1,]），规范成 null 后再交给 org.json */
    fun normalizeSparse(s: String): String {
        val sb = StringBuilder(s.length + 16)
        var inStr = false
        var esc = false
        var prev = ' ' // 上一个非空白、非字符串内字符
        for (c in s) {
            if (inStr) {
                sb.append(c)
                if (esc) esc = false
                else if (c == '\\') esc = true
                else if (c == '"') { inStr = false; prev = '"' }
                continue
            }
            when (c) {
                '"' -> { inStr = true; sb.append(c); prev = c }
                ',' -> {
                    if (prev == '[' || prev == ',') sb.append("null")
                    sb.append(c); prev = c
                }
                ']' -> {
                    if (prev == ',') sb.append("null")
                    sb.append(c); prev = c
                }
                ' ', '\n', '\r', '\t' -> sb.append(c)
                else -> { sb.append(c); prev = c }
            }
        }
        return sb.toString()
    }
}
