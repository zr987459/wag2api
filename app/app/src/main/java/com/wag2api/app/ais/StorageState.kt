package com.wag2api.app.ais

import org.json.JSONArray
import org.json.JSONObject
import java.security.MessageDigest
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import java.util.TimeZone

/**
 * AIS 账号的 storage-state（Playwright 格式：cookies + origins），与 Go 版 AIS 的导入格式一致。
 *
 * 导入时接受：
 *  - storage-state JSON：{"cookies":[...], "origins":[{"origin":..., "localStorage":[{"name","value"}]}]}
 *  - Cookie 数组 JSON（Cookie-Editor 等扩展导出，字段 expirationDate / sameSite=no_restriction 等）
 *  - Netscape cookies.txt（制表符分隔，支持 #HttpOnly_ 前缀）
 *  - Cookie 请求头（a=b; c=d）
 * 只保留 google.com 及其子域的 Cookie；同 (domain, path, name) 后者覆盖前者。
 *
 * 纯 JVM 代码（只依赖 org.json），可直接 JUnit。
 */
class StorageState(val cookies: List<Cookie>, val origins: List<Origin>) {

    data class Cookie(
        val name: String,
        val value: String,
        val domain: String,
        val path: String = "/",
        /** Unix 秒；<=0 表示会话 Cookie */
        val expires: Double = -1.0,
        val httpOnly: Boolean = false,
        val secure: Boolean = true,
        /** Strict / Lax / None，空表示未指定 */
        val sameSite: String = "",
    ) {
        /** 是否对 https://host/path 可见（域、路径、过期） */
        fun matches(host: String, path: String, nowSec: Long): Boolean {
            if (expires > 0 && expires < nowSec) return false
            val d = domain.lowercase(Locale.ROOT)
            val h = host.lowercase(Locale.ROOT)
            val hostOk = if (d.startsWith(".")) h == d.substring(1) || h.endsWith(d) else h == d
            if (!hostOk) return false
            val p = this.path.ifEmpty { "/" }
            return path == p || path.startsWith(if (p.endsWith("/")) p else "$p/")
        }

        /** 写入 CookieManager 用的 URL（与 Cookie 的域、路径对应） */
        fun url(): String = "https://" + domain.trimStart('.') + path.ifEmpty { "/" }

        /** CookieManager.setCookie 的 Set-Cookie 形式；__Host- 前缀与 host-only Cookie 不带 Domain */
        fun setCookieHeader(): String {
            val sb = StringBuilder()
            sb.append(name).append('=').append(value)
            if (domain.startsWith(".") && !name.startsWith("__Host-")) sb.append("; Domain=").append(domain)
            sb.append("; Path=").append(path.ifEmpty { "/" })
            if (expires > 0) sb.append("; Expires=").append(httpDate((expires * 1000).toLong()))
            if (secure || name.startsWith("__Secure-") || name.startsWith("__Host-")) sb.append("; Secure")
            if (httpOnly) sb.append("; HttpOnly")
            if (sameSite.isNotEmpty()) sb.append("; SameSite=").append(sameSite)
            return sb.toString()
        }

        fun toJson(): JSONObject = JSONObject()
            .put("name", name).put("value", value).put("domain", domain).put("path", path)
            .put("expires", if (expires > 0) expires else -1).put("httpOnly", httpOnly).put("secure", secure)
            .put("sameSite", sameSite.ifEmpty { "Lax" })
    }

    data class Origin(val origin: String, val localStorage: List<Pair<String, String>>)

    /** 对 url 可见的同名 Cookie 中路径最长的那个的值 */
    fun cookieValue(name: String, url: String = AISTUDIO_ORIGIN + "/", nowSec: Long = System.currentTimeMillis() / 1000): String? {
        val host = url.substringAfter("://").substringBefore('/').substringBefore(':')
        val path = "/" + url.substringAfter("://").substringAfter('/', "")
        return cookies.filter { it.name == name && it.matches(host, path, nowSec) }
            .maxByOrNull { it.path.length }?.value
    }

    /** 登录必需的 Cookie（与 Go 版 ParseCookieText 相同）缺失时抛出 */
    fun requireLogin(nowSec: Long = System.currentTimeMillis() / 1000) {
        val missing = REQUIRED_COOKIES.filter { cookieValue(it, nowSec = nowSec).isNullOrEmpty() }
        if (missing.isNotEmpty()) {
            throw IllegalArgumentException("Cookie 缺少登录 Cookie ${missing.joinToString(", ")}，请在已登录 AI Studio 的浏览器中导出")
        }
    }

    /** 同一账号的稳定标识（不含 Cookie 原文）：__Secure-1PSID 的 SHA-256 前 8 位 */
    fun fingerprint(): String {
        val v = cookieValue("__Secure-1PSID") ?: cookies.joinToString(";") { it.name + "=" + it.value }
        val d = MessageDigest.getInstance("SHA-256").digest(v.toByteArray(Charsets.UTF_8))
        return d.take(4).joinToString("") { "%02x".format(it) }
    }

    fun toJson(): JSONObject {
        val cs = JSONArray()
        for (c in cookies) cs.put(c.toJson())
        val os = JSONArray()
        for (o in origins) {
            val ls = JSONArray()
            for ((k, v) in o.localStorage) ls.put(JSONObject().put("name", k).put("value", v))
            os.put(JSONObject().put("origin", o.origin).put("localStorage", ls))
        }
        return JSONObject().put("cookies", cs).put("origins", os)
    }

    companion object {
        const val AISTUDIO_ORIGIN = "https://aistudio.google.com"
        @JvmField val REQUIRED_COOKIES = listOf("__Secure-1PSID", "SAPISID", "__Secure-1PAPISID", "__Secure-3PAPISID")

        private fun httpDate(ms: Long): String = SimpleDateFormat("EEE, dd MMM yyyy HH:mm:ss 'GMT'", Locale.US)
            .apply { timeZone = TimeZone.getTimeZone("GMT") }.format(Date(ms))

        fun isGoogleDomain(domain: String): Boolean {
            val d = domain.trim().trimStart('.').lowercase(Locale.ROOT)
            return d == "google.com" || d.endsWith(".google.com")
        }

        /** 解析导入文本（见类注释），只保留 google.com 的 Cookie，并去重 */
        @JvmStatic
        fun parse(input: String): StorageState {
            val text = input.trim().removePrefix("\uFEFF").trim()
            if (text.isEmpty()) throw IllegalArgumentException("Cookie 内容为空")
            val raw: StorageState = when {
                text.startsWith("{") || text.startsWith("[") -> parseJson(text)
                text.contains('\t') -> StorageState(parseNetscape(text), emptyList())
                else -> StorageState(parseHeader(text), emptyList())
            }
            val index = LinkedHashMap<String, Cookie>()
            for (c in raw.cookies) {
                if (!isGoogleDomain(c.domain) || c.name.isEmpty()) continue
                index[c.domain.lowercase(Locale.ROOT) + "\u0000" + c.path + "\u0000" + c.name] = c
            }
            if (index.isEmpty()) throw IllegalArgumentException("没有 google.com 的 Cookie")
            return StorageState(index.values.toList(), raw.origins)
        }

        /** 读取已保存的 storage-state.json（不做登录校验） */
        @JvmStatic
        fun fromJson(o: JSONObject): StorageState = parseJson(o.toString())

        private fun normSameSite(v: Any?): String = when (v?.toString()?.lowercase(Locale.ROOT)) {
            "strict" -> "Strict"
            "lax" -> "Lax"
            "none", "no_restriction" -> "None"
            else -> ""
        }

        private fun parseJson(text: String): StorageState {
            val cookiesArr: JSONArray
            val origins = ArrayList<Origin>()
            if (text.startsWith("{")) {
                val doc = JSONObject(text)
                // 兼容 {"storage_state": {...}} 包了一层的情况
                val inner = doc.optJSONObject("storage_state") ?: doc.optJSONObject("storageState") ?: doc
                cookiesArr = inner.optJSONArray("cookies") ?: throw IllegalArgumentException("JSON 里没有 cookies 数组")
                val os = inner.optJSONArray("origins")
                if (os != null) for (i in 0 until os.length()) {
                    val o = os.optJSONObject(i) ?: continue
                    val origin = o.optString("origin", "")
                    if (origin.isEmpty()) continue
                    val items = ArrayList<Pair<String, String>>()
                    val ls = o.optJSONArray("localStorage")
                    if (ls != null) for (j in 0 until ls.length()) {
                        val it = ls.optJSONObject(j) ?: continue
                        items.add(it.optString("name", "") to it.optString("value", ""))
                    }
                    origins.add(Origin(origin, items))
                }
            } else {
                cookiesArr = JSONArray(text)
            }
            val out = ArrayList<Cookie>()
            for (i in 0 until cookiesArr.length()) {
                val c = cookiesArr.optJSONObject(i) ?: continue
                val session = c.optBoolean("session", false)
                val exp = when {
                    c.has("expires") && !c.isNull("expires") -> c.optDouble("expires", -1.0)
                    c.has("expirationDate") && !c.isNull("expirationDate") -> c.optDouble("expirationDate", -1.0)
                    else -> -1.0
                }
                val hostOnly = c.optBoolean("hostOnly", false)
                var domain = c.optString("domain", "")
                if (domain.isNotEmpty() && !hostOnly && !domain.startsWith(".") && c.has("hostOnly")) domain = ".$domain"
                out.add(Cookie(
                    name = c.optString("name", ""),
                    value = c.optString("value", ""),
                    domain = domain,
                    path = c.optString("path", "/").ifEmpty { "/" },
                    expires = if (session || exp.isNaN()) -1.0 else exp,
                    httpOnly = c.optBoolean("httpOnly", false),
                    secure = c.optBoolean("secure", false),
                    sameSite = normSameSite(c.opt("sameSite")),
                ))
            }
            return StorageState(out, origins)
        }

        private fun parseNetscape(text: String): List<Cookie> {
            val out = ArrayList<Cookie>()
            for (rawLine in text.lines()) {
                var line = rawLine.trimEnd('\r')
                var httpOnly = false
                if (line.startsWith("#HttpOnly_")) { httpOnly = true; line = line.removePrefix("#HttpOnly_") }
                if (line.isBlank() || line.startsWith("#")) continue
                val f = line.split('\t')
                if (f.size < 7) continue
                val exp = f[4].trim().toDoubleOrNull() ?: 0.0
                out.add(Cookie(
                    name = f[5], value = f[6], domain = f[0].trim(), path = f[2].ifEmpty { "/" },
                    expires = if (exp > 0) exp else -1.0, httpOnly = httpOnly,
                    secure = f[3].trim().equals("TRUE", ignoreCase = true),
                ))
            }
            if (out.isEmpty()) throw IllegalArgumentException("Netscape cookies.txt 里没有 Cookie")
            return out
        }

        private fun parseHeader(text: String): List<Cookie> {
            val body = text.removePrefix("Cookie:").removePrefix("cookie:").trim()
            val out = ArrayList<Cookie>()
            for (pair in body.split(';')) {
                val i = pair.indexOf('=')
                if (i <= 0) continue
                val name = pair.substring(0, i).trim()
                val value = pair.substring(i + 1).trim()
                if (name.isEmpty()) continue
                // Cookie 头不带域：按 .google.com 处理（__Host- 前缀只能 host-only）
                val domain = if (name.startsWith("__Host-")) "aistudio.google.com" else ".google.com"
                out.add(Cookie(name, value, domain, "/", -1.0, httpOnly = false, secure = true))
            }
            if (out.isEmpty()) throw IllegalArgumentException("无法识别的 Cookie 格式")
            return out
        }
    }
}

/** SAPISID 三段签名（与上游 internal/aistudio/signer.go 的格式一致） */
object Sapisid {
    private val LABELS = listOf(
        "SAPISIDHASH" to "SAPISID",
        "SAPISID1PHASH" to "__Secure-1PAPISID",
        "SAPISID3PHASH" to "__Secure-3PAPISID",
    )

    /**
     * cookies：对 https://aistudio.google.com 可见的 Cookie（名 → 值），比如 CookieManager.getCookie 的结果解析出来的表。
     * 返回 "SAPISIDHASH ts_hex SAPISID1PHASH ts_hex SAPISID3PHASH ts_hex"；缺 Cookie 抛出。
     */
    @JvmStatic
    fun authorization(cookies: Map<String, String>, nowSec: Long = System.currentTimeMillis() / 1000, origin: String = StorageState.AISTUDIO_ORIGIN): String {
        val parts = ArrayList<String>(3)
        for ((label, name) in LABELS) {
            val v = cookies[name]
            if (v.isNullOrEmpty()) throw IllegalStateException("缺少有效 Cookie: $name（账号需要重新导入）")
            val d = MessageDigest.getInstance("SHA-1").digest("$nowSec $v $origin".toByteArray(Charsets.UTF_8))
            parts.add(label + " " + nowSec + "_" + d.joinToString("") { "%02x".format(it) })
        }
        return parts.joinToString(" ")
    }

    /** 解析 "a=b; c=d" 形式的 Cookie 串（CookieManager.getCookie 的返回值） */
    @JvmStatic
    fun parseCookieHeader(header: String?): Map<String, String> {
        val out = LinkedHashMap<String, String>()
        if (header.isNullOrEmpty()) return out
        for (pair in header.split(';')) {
            val i = pair.indexOf('=')
            if (i <= 0) continue
            val k = pair.substring(0, i).trim()
            if (k.isNotEmpty() && !out.containsKey(k)) out[k] = pair.substring(i + 1).trim()
        }
        return out
    }
}
