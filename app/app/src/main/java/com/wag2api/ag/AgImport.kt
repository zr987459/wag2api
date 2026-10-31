package com.wag2api.ag

import org.json.JSONArray
import org.json.JSONObject

/**
 * 移植自 src/ag-import.mjs
 * 从任意粘贴内容里抽出 AG 账号：JSON 备份 / 单个对象 / 一行一个 Refresh Token
 */
object AgImport {
    private val RT_FULL = Regex("^1//[0-9A-Za-z_-]{20,}$")
    private val RT_ANY = Regex("1//[0-9A-Za-z_-]{20,}")

    /** 返回 [{refresh_token, email}]（email 小写，可能为空串），按出现顺序去重 */
    @JvmStatic
    fun parseAgImport(raw: Any?): JSONArray {
        val out = JSONArray()
        val seen = HashSet<String>()
        fun push(rt0: Any?, email: Any? = "") {
            val rt = jsStr(rt0).trim()
            if (!RT_FULL.matches(rt) || seen.contains(rt)) return
            seen.add(rt)
            out.put(JSONObject().put("refresh_token", rt).put("email", jsStr(email).trim().lowercase()))
        }
        fun walk(v: Any?) {
            if (!jsTruthy(v)) return
            when (v) {
                is JSONArray -> for (i in 0 until v.length()) walk(v.opt(i))
                is String -> push(v)
                is JSONObject -> {
                    // v.refresh_token || v.refreshToken || v.token
                    var rt: Any? = null
                    for (k in arrayOf("refresh_token", "refreshToken", "token")) {
                        val x = v.opt(k)
                        if (jsTruthy(x)) { rt = x; break }
                    }
                    if (rt is String) push(rt, v.opt("email"))
                    for (k in arrayOf("accounts", "ag", "list", "data")) if (jsTruthy(v.opt(k))) walk(v.opt(k))
                }
            }
        }
        val text = jsStr(raw).trim()
        try {
            walk(M2Json.parse(text))
        } catch (e: Exception) { /* 不是 JSON，按纯文本处理 */ }
        if (out.length() == 0) for (m in RT_ANY.findAll(text)) push(m.value)
        return out
    }

    /** String(x || '') 的等价 */
    private fun jsStr(v: Any?): String = if (!jsTruthy(v)) "" else v.toString()

    private fun jsTruthy(v: Any?): Boolean = when (v) {
        null, JSONObject.NULL -> false
        is String -> v.isNotEmpty()
        is Boolean -> v
        is Number -> v.toDouble() != 0.0 && !v.toDouble().isNaN()
        else -> true
    }
}

/** 与 mjs 导出名一致的顶层函数 */
fun parseAgImport(raw: Any?): JSONArray = AgImport.parseAgImport(raw)
