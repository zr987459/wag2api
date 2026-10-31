package com.wag2api.ag

import org.json.JSONArray
import org.json.JSONObject
import java.util.concurrent.ConcurrentHashMap

/**
 * 上游 sessionId 计算（移植自 src/session-router.mjs），对齐主流开源实现：
 *  - CLIProxyAPI：优先使用客户端自带的会话标识；
 *  - 没有客户端标识时，sha256(首条用户消息文本) 取 63 位，格式 "-<数字>"；
 *  - Antigravity-Manager：上游按 sessionId 累积输入，超过 1,048,576 token 后把该会话的"代数"加一，换新 sessionId。
 */
object SessionRouter {
    private fun toSid(seed: String): String = JsCompat.sid(seed)

    private fun firstUserText(req: JSONObject): String {
        val first = firstUser(req) ?: return ""
        val c = first.opt("content")
        if (c is String) return c
        if (c is JSONArray) {
            for (i in 0 until c.length()) {
                val p = c.optJSONObject(i) ?: continue
                if (p.opt("type") == "text" && JsCompat.truthy(p.opt("text"))) {
                    val t = p.opt("text")
                    return if (t is String) t else JsCompat.str(t)
                }
            }
            return ""
        }
        return ""
    }

    private fun firstUser(req: JSONObject): JSONObject? {
        val ms = req.optJSONArray("messages") ?: return null
        for (i in 0 until ms.length()) {
            val m = ms.optJSONObject(i) ?: continue
            if (m.opt("role") == "user") return m
        }
        return null
    }

    private fun headerOf(h: Map<String, Any?>, name: String): Any? {
        val ln = name.lowercase()
        h[ln]?.let { return it }
        for ((k, v) in h) if (k.lowercase() == ln) return v
        return null
    }

    private fun pick(h: Map<String, Any?>, vararg names: String): String {
        for (n in names) {
            val v = headerOf(h, n)
            if (v is String && JsCompat.trim(v).isNotEmpty()) return slice200(JsCompat.trim(v))
        }
        return ""
    }

    private fun slice200(s: String) = if (s.length > 200) s.substring(0, 200) else s

    private val UID_SESSION = Regex("session_([0-9a-f-]{8,})", RegexOption.IGNORE_CASE)

    /**
     * 从请求头 / 请求体提取客户端会话标识（顺序同 CLIProxyAPI）。返回 "" 表示客户端没带。
     * headers：小写或任意大小写的请求头。
     */
    @JvmStatic
    @JvmOverloads
    fun clientSessionKey(headers: Map<String, Any?>? = emptyMap(), body: JSONObject? = JSONObject()): String {
        val h = headers ?: emptyMap()
        var sid = pick(h, "x-claude-code-session-id")
        if (sid.isEmpty()) {
            // Claude Code: metadata.user_id 形如 "user_<hash>_account_<uuid>_session_<uuid>"
            val uidV = body?.optJSONObject("metadata")?.opt("user_id")
            val uid = if (JsCompat.truthy(uidV)) JsCompat.str(uidV) else ""
            val m = UID_SESSION.find(uid)
            if (m != null) sid = m.groupValues[1]
        }
        if (sid.isEmpty()) sid = pick(h, "session-id", "session_id", "x-http-session-id", "x-session-id", "x-session-affinity",
            "x-conversation-id", "x-thread-id")
        if (sid.isEmpty()) {
            val b = body ?: JSONObject()
            val md = b.optJSONObject("metadata")
            val v = JsCompat.or(b.opt("session_id"), b.opt("sessionId"), b.opt("conversation_id"), md?.opt("session_id"), md?.opt("conversation_id"), "")
            sid = slice200(JsCompat.trim(JsCompat.str(v)))
        }
        if (sid.isEmpty()) return ""
        // 保持主会话前缀共享：子代理继承父会话的同一 sessionId
        return "client:$sid"
    }

    private val generations = ConcurrentHashMap<String, Int>() // key -> generation
    private fun keyOf(email: String?, base: String) = "${email ?: ""}|$base"

    private val AUX_RE = Regex("^(title|generate title|quick check)\\b", RegexOption.IGNORE_CASE)

    /** 识别是否是旁路/辅助请求（如标题生成、探活），避免污染主对话缓存 */
    private fun isAuxiliaryRequest(req: JSONObject?): Boolean {
        val ms = req?.optJSONArray("messages") ?: return false
        if (ms.length() == 0) return false
        if (ms.length() <= 2) {
            val mt = req.opt("max_tokens")
            if (JsCompat.truthy(mt) && JsCompat.number(mt) <= 100) return true
            val last = ms.optJSONObject(ms.length() - 1)
            var text = ""
            val c = last?.opt("content")
            if (c is String) text = c
            else if (c is JSONArray) {
                val parts = ArrayList<String>()
                for (i in 0 until c.length()) {
                    val p = c.optJSONObject(i) ?: continue
                    if (p.opt("type") == "text") { val t = p.opt("text"); parts.add(if (JsCompat.truthy(t)) JsCompat.str(t) else "") }
                }
                text = parts.joinToString("\n")
            }
            return AUX_RE.containsMatchIn(JsCompat.trim(text))
        }
        return false
    }

    private fun baseSid(req: JSONObject): String {
        val ck = req.opt("_gwSessionKey")
        if (JsCompat.truthy(ck)) return toSid(JsCompat.str(ck))
        val ft = firstUserText(req)
        if (ft.isNotEmpty()) return toSid(ft)
        val sys = JsCompat.or(req.opt("system"), "")
        return toSid(JsCompat.stringify(sys) ?: "")
    }

    /** 计算本次请求的 sessionId。anthropicRequest._gwSessionKey 由 server 预先填入（客户端标识）。 */
    @JvmStatic
    @JvmOverloads
    fun resolveSessionId(anthropicRequest: JSONObject, email: String? = ""): String {
        var base = baseSid(anthropicRequest)
        // 旁路请求强制使用独立分支 sessionId
        if (isAuxiliaryRequest(anthropicRequest)) base = toSid("$base:aux")
        val gen = generations[keyOf(email, base)] ?: 0
        return if (gen == 0) base else toSid("$base|gen|$gen")
    }

    private val OVERFLOW_RE = Regex("exceeds the maximum number of tokens allowed", RegexOption.IGNORE_CASE)

    /** 上游报"输入超过 1048576 token"时调用：该会话换新一代 ID。返回是否需要重试。 */
    @JvmStatic
    fun bumpSessionOnOverflow(anthropicRequest: JSONObject, email: String?, errorText: Any?): Boolean {
        if (!OVERFLOW_RE.containsMatchIn(if (JsCompat.truthy(errorText)) JsCompat.str(errorText) else "")) return false
        val base = baseSid(anthropicRequest)
        generations.merge(keyOf(email, base), 1) { a, b -> a + b }
        return true
    }

    @JvmStatic
    fun sessionStats(): JSONObject = synchronized(toolPins) {
        JSONObject().put("bumped", generations.size).put("toolsPinned", toolPins.size).put("toolPinRestored", toolPinHits)
    }

    /**
     * 工具定义锁定：同一会话里客户端微调工具描述（参数结构不变）时沿用第一次的描述，保护 Google 隐式缓存。
     */
    private const val TTL_MS = 6 * 60 * 60 * 1000L

    private class ToolPin(val desc: Any?, val params: String, var exp: Long)

    private val toolPins = LinkedHashMap<String, ToolPin>() // key -> { desc, params, exp }
    @Volatile private var toolPinHits = 0

    @JvmStatic
    fun pinToolDescriptions(convKey: String, functionDeclarations: JSONArray?): JSONArray? {
        if (System.getenv("TOOL_PIN") == "0" || functionDeclarations == null) return functionDeclarations
        val now = System.currentTimeMillis()
        val out = JSONArray()
        synchronized(toolPins) {
            for (i in 0 until functionDeclarations.length()) {
                val fdAny = functionDeclarations.opt(i)
                val fd = fdAny as? JSONObject
                if (fd == null) { out.put(fdAny ?: JSONObject.NULL); continue }
                val key = convKey + ":" + JsCompat.str(fd.opt("name"))
                val params = JsCompat.stringify(JsCompat.or(fd.opt("parameters"), JSONObject())) ?: "{}"
                val desc = fd.opt("description")
                val old = toolPins[key]
                if (old != null && old.exp > now && old.params == params) {
                    old.exp = now + TTL_MS
                    if (old.desc != desc) {
                        toolPinHits++
                        val copy = JSONObject()
                        val it = fd.keys()
                        while (it.hasNext()) { val k = it.next(); copy.put(k, fd.opt(k)) }
                        if (old.desc == null) copy.remove("description") else copy.put("description", old.desc)
                        out.put(copy)
                    } else out.put(fd)
                    continue
                }
                toolPins.remove(key)
                toolPins[key] = ToolPin(desc, params, now + TTL_MS)
                while (toolPins.size > 5000) {
                    val first = toolPins.keys.iterator()
                    first.next(); first.remove()
                }
                out.put(fd)
            }
        }
        return out
    }
}
