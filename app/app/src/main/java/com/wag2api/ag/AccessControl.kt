package com.wag2api.ag

import okhttp3.HttpUrl.Companion.toHttpUrlOrNull
import org.json.JSONObject
import java.io.File
import java.security.MessageDigest

/**
 * 移植自 src/access-control.mjs
 * 个人管理密钥鉴权；keys.json 格式与 Node 版一致（{"admin_key": "..."}，其余字段保留）。
 *
 * Node 版的 req 在这里拆成「请求头 + 请求目标(url)」两个参数：
 * headers 的键大小写不敏感；url 可以是 "/v1/messages?key=xx" 这样的请求目标，也可以是完整网址。
 */
class AccessControl(val file: String) {
    @Volatile var adminKey: String = ""

    init {
        load()
    }

    fun load() {
        var data = JSONObject()
        try {
            val f = File(file)
            if (f.exists()) {
                val v = M2Json.parse(f.readText(Charsets.UTF_8))
                if (v is JSONObject) data = v
            }
        } catch (e: Exception) {
            M2Log.e("[Access] keys.json 解析失败: ${e.message}")
        }
        val env = System.getenv("ADMIN_KEY")
        val fileKey = data.opt("admin_key")
        adminKey = (if (!env.isNullOrEmpty()) env else if (M2Json.truthy(fileKey)) fileKey.toString() else "").trim()
    }

    @Synchronized
    fun save() {
        var data = JSONObject()
        val f = File(file)
        try {
            if (f.exists()) {
                val v = M2Json.parse(f.readText(Charsets.UTF_8))
                if (v is JSONObject) data = v
            }
        } catch (_: Exception) {}
        data.put("admin_key", adminKey)
        f.parentFile?.mkdirs()
        M2Json.writeFile(f, M2Json.stringify(data, 2))
    }

    val enabled: Boolean get() = adminKey.isNotEmpty()

    fun isAdmin(headers: Map<String, String?>, url: String = ""): Boolean {
        if (!enabled) return true
        val k = keyFromRequest(headers, url)
        return k.isNotEmpty() && safeEqual(k, adminKey)
    }

    /** {role:"open"} / {role:"admin"} / null */
    fun resolve(headers: Map<String, String?>, url: String = ""): JSONObject? {
        if (!enabled) return JSONObject().put("role", "open")
        if (isAdmin(headers, url)) return JSONObject().put("role", "admin")
        return null
    }

    companion object {
        @JvmStatic
        fun safeEqual(a: String, b: String): Boolean {
            val x = a.toByteArray(Charsets.UTF_8)
            val y = b.toByteArray(Charsets.UTF_8)
            return x.size == y.size && MessageDigest.isEqual(x, y)
        }

        private fun header(h: Map<String, String?>, name: String): String {
            h[name]?.let { return it }
            for ((k, v) in h) if (k.equals(name, ignoreCase = true) && v != null) return v
            return ""
        }

        private val BEARER = Regex("^bearer\\s+", RegexOption.IGNORE_CASE)

        @JvmStatic
        fun keyFromRequest(headers: Map<String, String?>, url: String = ""): String {
            for (n in arrayOf("x-api-key", "api-key", "x-admin-key", "x-auth-token")) {
                val v = header(headers, n)
                if (v.isNotEmpty()) return v.trim()
            }
            val auth = header(headers, "authorization").trim()
            if (BEARER.containsMatchIn(auth)) return auth.replaceFirst(BEARER, "").trim()
            if (auth.isNotEmpty() && !auth.contains(' ')) return auth // 兼容不带 Bearer 前缀的直接 token
            try {
                val full = if (url.startsWith("http://") || url.startsWith("https://")) url
                    else "http://127.0.0.1" + (if (url.startsWith("/")) url else "/$url")
                val u = full.toHttpUrlOrNull()
                if (u != null) {
                    val qk = u.queryParameter("key").takeIf { !it.isNullOrEmpty() } ?: u.queryParameter("api_key")
                    if (!qk.isNullOrEmpty()) return qk.trim()
                }
            } catch (_: Exception) {}
            return ""
        }
    }
}
