package com.wag2api.ag

import org.json.JSONArray
import org.json.JSONObject

/**
 * /v1/messages/count_tokens 本地估算（不消耗上游配额）（移植自 src/token-estimate.mjs）
 *
 * 口径与 Antigravity-Manager 一致：ASCII 约 4 字符 / token，非 ASCII（中日韩等）约 2.2 字符 / token；
 * base64 图片按大小折算（< 5KB 记 258，否则 2000），其它 base64 媒体按长度 / 4。
 */
object TokenEstimate {

    /** String(s || '')：按码点计数（for...of），码点 < 128 算 ASCII */
    @JvmStatic
    fun estimateTextTokens(s: Any?): Long {
        val text = jsString(Js.or(s, ""))
        if (text.isEmpty()) return 0
        var ascii = 0L
        var other = 0L
        var i = 0
        while (i < text.length) {
            val cp = text.codePointAt(i)
            if (text[i].code < 128) ascii++ else other++
            i += Character.charCount(cp)
        }
        return Math.round(ascii / 4.0) + Math.round(other / 2.2)
    }

    private fun jsString(v: Any?): String = when (v) {
        is String -> v
        is JSONObject, is JSONArray -> if (v is JSONObject) "[object Object]" else Js.cat(v)
        else -> Js.cat(v)
    }

    private fun mediaTokens(mime: Any?, data: Any?): Long {
        val len = jsString(Js.or(data, "")).length
        return if (jsString(Js.or(mime, "")).startsWith("image/")) {
            if ((len * 3.0) / 4.0 < 5000) 258 else 2000
        } else Math.ceil(len / 4.0).toLong()
    }

    private fun blockTokens(b: Any?): Long {
        if (b == null || b == JSONObject.NULL) return 0
        if (b is String) return estimateTextTokens(b)
        if (b !is JSONObject) return estimateTextTokens(Js.stringify(b))
        val source = b.opt("source") as? JSONObject
        return when (b.opt("type")) {
            "text" -> estimateTextTokens(b.opt("text"))
            "thinking" -> estimateTextTokens(b.opt("thinking"))
            "redacted_thinking" -> 0
            "image", "document" -> when (source?.opt("type")) {
                "base64" -> mediaTokens(source.opt("media_type"), source.opt("data"))
                "text" -> estimateTextTokens(source.opt("data"))
                else -> 0
            }
            "tool_use" -> estimateTextTokens(Js.cat(Js.or(b.opt("name"), "")) + Js.stringify(Js.or(b.opt("input"), JSONObject())))
            "tool_result" -> {
                val c = b.opt("content")
                if (c is JSONArray) {
                    var n = 0L
                    for (i in 0 until c.length()) n += blockTokens(c.opt(i))
                    n
                } else {
                    // typeof content === 'string' ? content : JSON.stringify(content ?? '')
                    estimateTextTokens(if (c is String) c else Js.stringify(if (c == null || c == JSONObject.NULL) "" else c))
                }
            }
            else -> estimateTextTokens(Js.stringify(b))
        }
    }

    /** 估算 Anthropic Messages 请求体的输入 token 数 */
    @JvmStatic
    fun estimateAnthropicInputTokens(body: Any?): Long {
        val req = body as? JSONObject ?: JSONObject()
        var n = 0L
        val sys = req.opt("system")
        if (sys is String) n += estimateTextTokens(sys)
        else if (sys is JSONArray) {
            for (i in 0 until sys.length()) n += estimateTextTokens((sys.opt(i) as? JSONObject)?.opt("text"))
        }
        val msgs = req.opt("messages") as? JSONArray
        if (msgs != null) {
            for (i in 0 until msgs.length()) {
                val m = msgs.opt(i) as? JSONObject
                val c = m?.opt("content")
                if (c is String) n += estimateTextTokens(c)
                else if (c is JSONArray) {
                    for (j in 0 until c.length()) n += blockTokens(c.opt(j))
                }
                n += 3 // 每条消息的角色 / 分隔开销
            }
        }
        val tools = req.opt("tools") as? JSONArray
        if (tools != null) {
            for (i in 0 until tools.length()) {
                val t = tools.opt(i) as? JSONObject
                val name = Js.cat(Js.or(t?.opt("name"), ""))
                val desc = Js.cat(Js.or(t?.opt("description"), ""))
                n += estimateTextTokens(name + desc + Js.stringify(Js.or(t?.opt("input_schema"), JSONObject())))
            }
        }
        return maxOf(1L, n)
    }
}
