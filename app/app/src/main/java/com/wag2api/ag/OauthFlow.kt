package com.wag2api.ag

import okhttp3.HttpUrl.Companion.toHttpUrlOrNull
import org.json.JSONObject
import java.io.BufferedInputStream
import java.io.ByteArrayOutputStream
import java.io.IOException
import java.net.InetAddress
import java.net.InetSocketAddress
import java.net.ServerSocket
import java.net.Socket
import java.util.concurrent.ConcurrentHashMap
import kotlin.random.Random

/**
 * 移植自 src/oauth-flow.mjs
 *
 * Google OAuth（RFC 8252 Desktop App Loopback Flow）：
 * Google 官方 Desktop Client ID 的 redirect_uri 只能是 http://localhost:51121/oauth-callback。
 * 1. 常驻监听 127.0.0.1:51121（只监听回环），处理 /oauth-callback 与 /oauth-result；
 * 2. 回调立即返回“处理中”页面，后台换票，页面轮询 /oauth-result 显示结果；
 * 3. 用户也可以把带 code= 的完整网址（或 Refresh Token）粘贴到控制台，走 exchangeRawInput。
 *
 * Node 版 handleHttp(reqUrl, res) 直接写 res；这里改成返回 [Reply]（null = 不是 OAuth 路径），
 * 由调用方（本类的回调监听 / AgServer）写回客户端。
 */
class OAuthFlowManager(val accountPool: AccountPool?) {

    /** 一个 HTTP 回复：状态码、响应头、正文（UTF-8） */
    class Reply(val status: Int, val headers: Map<String, String>, val body: String) {
        val contentType: String get() = headers["Content-Type"] ?: "text/html; charset=utf-8"
    }

    /** 换票结果（Node 版返回的对象，字段同名） */
    class TokenResult(
        val accessToken: String,
        val refreshToken: String,
        val email: String,
        val expiresIn: Long? = null,
    ) {
        fun toJSON(): JSONObject {
            val o = JSONObject().put("accessToken", accessToken).put("refreshToken", refreshToken).put("email", email)
            if (expiresIn != null) o.put("expiresIn", expiresIn)
            return o
        }
    }

    private class Pending(@Volatile var done: Boolean = false, @Volatile var status: Int = 0, @Volatile var html: String = "")

    val fixedPort = Constants.CALLBACK_PORT
    @Volatile var server: ServerSocket? = null
    @Volatile var lastExchangedAccount: String? = null
    private val pendingResults = ConcurrentHashMap<String, Pending>()

    init {
        initPermanentListener()
    }

    private val redirectUri get() = "http://localhost:$fixedPort/oauth-callback"

    /** host 参数与 Node 版一样被忽略（始终用 localhost 回调） */
    @JvmOverloads
    fun getAuthUrl(host: String? = null): String {
        return Constants.GOOGLE_AUTH_ENDPOINT + "?" + M2Http.form(
            "client_id" to Constants.ANTIGRAVITY_CLIENT_ID,
            "response_type" to "code",
            "access_type" to "offline",
            "prompt" to "consent",
            "include_granted_scopes" to "true",
            "redirect_uri" to redirectUri,
            "state" to "antigravity_" + System.currentTimeMillis(),
            "scope" to Constants.SCOPES.joinToString(" "),
        )
    }

    /** 常驻监听 127.0.0.1:fixedPort（普通线程，每个连接一个短线程） */
    @Synchronized
    fun initPermanentListener() {
        if (server != null) return
        val ss = try {
            ServerSocket().apply {
                reuseAddress = true
                bind(InetSocketAddress(InetAddress.getByName("127.0.0.1"), fixedPort), 16)
            }
        } catch (e: Exception) {
            M2Log.w("[OAuth Flow] 回调端口 $fixedPort 监听失败: ${e.message}")
            return
        }
        server = ss
        M2Log.i("📡 Google OAuth 本地回调监听常驻在 127.0.0.1:$fixedPort")
        Thread({
            while (!ss.isClosed) {
                val s = try { ss.accept() } catch (e: IOException) { if (ss.isClosed) break else continue }
                M2Exec.bg { serve(s) }
            }
        }, "ag-oauth-listener").apply { isDaemon = true }.start()
    }

    /** 关闭回调监听（引擎停止时调用） */
    fun close() {
        val s = server
        server = null
        try { s?.close() } catch (_: Exception) {}
    }

    private fun serve(s: Socket) {
        s.use { sock ->
            try {
                sock.soTimeout = 15000
                val input = BufferedInputStream(sock.getInputStream())
                val line = readLine(input) ?: return
                while (true) { val h = readLine(input) ?: break; if (h.isEmpty()) break }
                val parts = line.split(' ')
                val target = if (parts.size >= 2) parts[1] else "/"
                val reply = handleHttp(target)
                val out = sock.getOutputStream()
                if (reply == null) {
                    out.write("HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n".toByteArray(Charsets.ISO_8859_1))
                } else {
                    val body = reply.body.toByteArray(Charsets.UTF_8)
                    val sb = StringBuilder("HTTP/1.1 ${reply.status} ${reasonPhrase(reply.status)}\r\n")
                    for ((k, v) in reply.headers) if (!k.equals("Connection", true)) sb.append(k).append(": ").append(v).append("\r\n")
                    sb.append("Content-Length: ").append(body.size).append("\r\nConnection: close\r\n\r\n")
                    out.write(sb.toString().toByteArray(Charsets.UTF_8))
                    out.write(body)
                }
                out.flush()
            } catch (_: Exception) {}
        }
    }

    private fun readLine(input: BufferedInputStream): String? {
        val buf = ByteArrayOutputStream()
        while (true) {
            val b = input.read()
            if (b < 0) return if (buf.size() == 0) null else buf.toString("ISO-8859-1")
            if (b == '\n'.code) break
            if (b != '\r'.code) buf.write(b)
            if (buf.size() > 16384) break
        }
        return buf.toString("ISO-8859-1")
    }

    private fun reasonPhrase(s: Int) = when (s) { 200 -> "OK"; 400 -> "Bad Request"; 404 -> "Not Found"; 500 -> "Internal Server Error"; else -> "OK" }

    private fun esc(s: String) = s.replace(Regex("[<>&]"), "")

    /**
     * 处理 /oauth-callback 与 /oauth-result。url 为请求目标（如 "/oauth-callback?code=..."）或完整网址。
     * 返回 null 表示不是 OAuth 路径。
     */
    fun handleHttp(url: String): Reply? {
        val full = if (url.startsWith("http://") || url.startsWith("https://")) url
            else "http://localhost:$fixedPort" + (if (url.startsWith("/")) url else "/$url")
        val u = full.toHttpUrlOrNull() ?: return null
        val path = u.encodedPath
        if (path == "/oauth-callback") {
            val code = u.queryParameter("code")
            val err = u.queryParameter("error")
            val id = "r" + java.lang.Long.toString(System.currentTimeMillis(), 36) + randomBase36(6)
            val entry = Pending()
            pendingResults[id] = entry
            M2Exec.later(10 * 60 * 1000L) { pendingResults.remove(id) }
            M2Exec.bg {
                try {
                    val r = if (!err.isNullOrEmpty()) {
                        400 to "<h2 style=\"color:#ef4444\">⚠ 授权被取消：${esc(err)}</h2>"
                    } else processCallbackCode(code, redirectUri)
                    entry.status = r.first; entry.html = r.second; entry.done = true
                } catch (e: Exception) {
                    entry.status = 500; entry.html = "<h2 style=\"color:#ef4444\">⚠ ${esc(e.message ?: e.toString())}</h2>"; entry.done = true
                }
            }
            val html = """<!DOCTYPE html><html lang="zh-CN"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>正在完成授权…</title><style>body{background:#0b1120;color:#fff;font-family:-apple-system,sans-serif;text-align:center;padding:60px 16px;margin:0}
.sp{width:36px;height:36px;border:4px solid #334155;border-top-color:#38bdf8;border-radius:50%;margin:0 auto 18px;animation:r 1s linear infinite}@keyframes r{to{transform:rotate(360deg)}}p{color:#94a3b8}</style></head>
<body><div id="w"><div class="sp"></div><h3>已收到 Google 授权</h3><p id="t">正在换取令牌，通常几秒钟…</p></div>
<script>var n=0;function poll(){fetch('/oauth-result?id=$id',{cache:'no-store'}).then(function(r){return r.json()}).then(function(d){
if(d.done){document.open();document.write(d.html);document.close();return}
if(++n>40){document.getElementById('t').textContent='还在处理，可以先回到 App 看账号是否已加上';}setTimeout(poll,1000)}).catch(function(){setTimeout(poll,1500)})}poll();</script></body></html>"""
            return Reply(200, linkedMapOf(
                "Content-Type" to "text/html; charset=utf-8",
                "Cache-Control" to "no-store",
                "Connection" to "close",
            ), html)
        }
        if (path == "/oauth-result") {
            val e = pendingResults[u.queryParameter("id") ?: ""]
            val body = if (e != null) {
                JSONObject().put("done", e.done).put("status", e.status).put("html", if (e.done) e.html else "")
            } else {
                JSONObject().put("done", true).put("status", 404).put("html", "<h3>结果已过期，请回到 App 查看账号</h3>")
            }
            return Reply(200, linkedMapOf(
                "Content-Type" to "application/json; charset=utf-8",
                "Cache-Control" to "no-store",
            ), M2Json.stringify(body))
        }
        return null
    }

    private fun randomBase36(n: Int): String {
        val chars = "0123456789abcdefghijklmnopqrstuvwxyz"
        return (1..n).map { chars[Random.nextInt(36)] }.joinToString("")
    }

    /** 回调换票；返回 (status, html)；同步阻塞 */
    fun processCallbackCode(code: String?, redirectUri: String): Pair<Int, String> {
        if (code.isNullOrEmpty()) {
            return 400 to "<h3 style=\"color:#ef4444;text-align:center;margin-top:40px;font-family:sans-serif;\">⚠ 授权失败：未收到 Google Code</h3>"
        }
        try {
            M2Log.i("[OAuth Flow] 收到回调 Code，向 Google 换取 Token...")
            val tokenResult = exchangeCode(code, redirectUri)
            if (accountPool != null && tokenResult.refreshToken.isNotEmpty() && tokenResult.email.isNotEmpty()) {
                accountPool.addAccount(tokenResult.refreshToken, tokenResult.email)
                lastExchangedAccount = tokenResult.email
                M2Log.i("[OAuth Flow] 账号 ${tokenResult.email} 已成功加入账号池！")
            }
            val emailShown = tokenResult.email.ifEmpty { "Google" }
            return 200 to """
          <!DOCTYPE html>
          <html lang="zh-CN">
          <head>
            <meta charset="UTF-8">
            <meta name="viewport" content="width=device-width, initial-scale=1.0">
            <title>授权成功 - Antigravity Token</title>
            <style>
              body { background: #0b1120; color: #fff; font-family: -apple-system, sans-serif; text-align: center; padding: 40px 16px; margin: 0; }
              .box { max-width: 460px; margin: 0 auto; background: #1e293b; padding: 24px; border-radius: 12px; border: 1px solid #334155; box-shadow: 0 10px 25px rgba(0,0,0,0.5); }
              h2 { color: #22c55e; margin-bottom: 12px; }
              p { color: #94a3b8; font-size: 0.9rem; line-height: 1.6; margin: 6px 0; }
              .email { color: #38bdf8; font-weight: bold; }
              .token-box { margin-top: 16px; text-align: left; }
              .token-label { display: block; color: #cbd5e1; font-size: 0.85rem; margin-bottom: 6px; font-weight: 600; }
              textarea { width: 100%; height: 80px; background: #0f172a; border: 1px solid #38bdf8; color: #38bdf8; padding: 10px; border-radius: 8px; font-family: monospace; font-size: 0.82rem; box-sizing: border-box; resize: none; }
              .btn-copy { width: 100%; background: #38bdf8; color: #0b1120; border: none; padding: 12px 20px; border-radius: 8px; font-weight: bold; cursor: pointer; margin-top: 10px; font-size: 0.95rem; }
              .btn-copy:active { opacity: 0.8; }
              .btn-home { display: inline-block; background: #334155; color: #fff; padding: 10px 20px; border-radius: 8px; font-weight: bold; text-decoration: none; margin-top: 14px; font-size: 0.9rem; }
            </style>
          </head>
          <body>
            <div class="box">
              <h2>🎉 Google 授权成功！</h2>
              <p>账号 <span class="email">$emailShown</span> 已激活。</p>
              <div class="token-box">
                <span class="token-label">🔑 您的 Refresh Token (长期凭据)：</span>
                <textarea id="rt" readonly>${tokenResult.refreshToken}</textarea>
                <button class="btn-copy" onclick="navigator.clipboard.writeText(document.getElementById('rt').value);this.innerText='✅ Refresh Token 已成功复制！';">📋 一键复制 Refresh Token</button>
              </div>
              <p style="margin-top: 16px; font-size: 0.8rem; color: #64748b;">账号已自动同步至网关账号池，您可以直接返回控制台使用。</p>
              <a class="btn-home" href="/">👉 返回网关控制台</a>
            </div>
          </body>
          </html>
        """
        } catch (err: Exception) {
            M2Log.e("[OAuth Flow] 换票失败: ${err.message}")
            return 500 to """
          <body style="background:#0b1120;color:#fff;font-family:sans-serif;text-align:center;padding:40px 16px;">
            <h2 style="color:#ef4444;">⚠ 换取令牌失败</h2>
            <p style="color:#94a3b8;">${err.message}</p>
            <a href="/" style="color:#38bdf8;margin-top:20px;display:inline-block;">返回控制台重试</a>
          </body>
        """
        }
    }

    /** 控制台粘贴的回调网址 / 授权码 / Refresh Token → 换票；同步阻塞，失败抛异常（message 给用户看） */
    fun exchangeRawInput(rawInput: Any?): TokenResult {
        // 去掉换行、空格（手机复制长网址常被折行），并兼容被二次编码的网址
        var code = (if (M2Json.truthy(rawInput)) rawInput.toString() else "").replace(Regex("\\s+"), "")
        val enc = Regex("%(25)?(2F|3A|3F|26|3D)", RegexOption.IGNORE_CASE)
        var i = 0
        while (i < 2 && enc.containsMatchIn(code)) {
            code = decodeURIComponent(code) ?: break
            i++
        }
        if (code.contains("code=")) {
            val u = (if (code.startsWith("http")) code else "http://localhost/$code").toHttpUrlOrNull()
            if (u != null) {
                val extracted = u.queryParameter("code")
                if (!extracted.isNullOrEmpty()) code = extracted
            } else {
                val m = Regex("code=([^&]+)").find(code)
                if (m != null) code = decodeURIComponent(m.groupValues[1]) ?: throw IllegalArgumentException("URI malformed")
            }
        }
        // 粘贴的是 Refresh Token（1//...），直接按 Refresh Token 导入
        if (Regex("^1//[0-9A-Za-z_-]{20,}$").matches(code)) return validateAndAddRefreshToken(code)
        code = code.split('&')[0].split('#')[0]
        if (!Regex("^4/[0-9A-Za-z_-]{20,}$").matches(code)) {
            throw IllegalArgumentException("授权码不完整或已失效：如果刚才的页面显示「授权成功」，账号已经加好，直接返回控制台即可；否则请重新点「登录 Google」，授权完成后把地址栏里从 http://localhost 开头、包含 code= 的整条网址完整复制过来（不要只复制一部分）")
        }
        return exchangeCode(code, redirectUri)
    }

    /** 授权码换票 + 查邮箱；同步阻塞 */
    fun exchangeCode(code: String, redirectUri: String): TokenResult {
        val params = M2Http.form(
            "client_id" to Constants.ANTIGRAVITY_CLIENT_ID,
            "client_secret" to Constants.ANTIGRAVITY_CLIENT_SECRET,
            "code" to code,
            "grant_type" to "authorization_code",
            "redirect_uri" to redirectUri,
        )
        val res = try {
            M2Http.post(Constants.GOOGLE_TOKEN_ENDPOINT, params, M2Http.FORM, emptyMap(), 20000)
        } catch (e: IOException) {
            throw IOException(if (M2Http.isTimeout(e)) "连接 Google 超时（20 秒），请检查手机代理是否对本应用生效" else "连接 Google 失败：${e.message}")
        }
        if (!res.ok) throw IOException("Google API 换票失败 (${res.status}): ${res.body}")
        val data = res.json() as? JSONObject ?: throw IOException("Google API 返回格式错误")
        val accessToken = data.optString("access_token", "")
        val refreshToken = data.optString("refresh_token", "")
        val email = fetchEmail(accessToken, 15000)
        val expiresIn = M2Json.numOr(data.opt("expires_in"), 3600.0).toLong()
        return TokenResult(accessToken, refreshToken, email, expiresIn)
    }

    private fun fetchEmail(accessToken: String, timeoutMs: Long): String {
        try {
            val r = M2Http.get("https://www.googleapis.com/oauth2/v2/userinfo", mapOf("Authorization" to "Bearer $accessToken"), timeoutMs)
            if (r.ok) {
                val u = r.json() as? JSONObject
                val e = u?.opt("email")
                if (M2Json.truthy(e)) return e.toString()
            }
        } catch (_: Exception) {}
        return ""
    }

    /** 校验 Refresh Token 并加入账号池；同步阻塞，失败抛异常 */
    fun validateAndAddRefreshToken(refreshToken: String): TokenResult {
        val cleanToken = refreshToken.trim()
        val params = M2Http.form(
            "client_id" to Constants.ANTIGRAVITY_CLIENT_ID,
            "client_secret" to Constants.ANTIGRAVITY_CLIENT_SECRET,
            "refresh_token" to cleanToken,
            "grant_type" to "refresh_token",
        )
        val res = M2Http.post(Constants.GOOGLE_TOKEN_ENDPOINT, params, M2Http.FORM, emptyMap())
        if (!res.ok) throw IOException("Google Refresh Token 校验失败 (${res.status}): ${res.body}")
        val data = res.json() as? JSONObject ?: throw IOException("Google API 返回格式错误")
        val accessToken = data.optString("access_token", "")
        var email = fetchEmail(accessToken, 0)
        if (email.isEmpty()) email = "user_${System.currentTimeMillis()}@gmail.com"
        accountPool?.addAccount(cleanToken, email)
        return TokenResult(accessToken, cleanToken, email)
    }

    companion object {
        /** JS decodeURIComponent：'+' 不转空格；非法编码返回 null（等价抛 URIError） */
        @JvmStatic
        fun decodeURIComponent(s: String): String? {
            if (!s.contains('%')) return s
            val out = ByteArrayOutputStream()
            val sb = StringBuilder()
            var i = 0
            fun flush(): Boolean {
                if (out.size() == 0) return true
                val bytes = out.toByteArray()
                out.reset()
                val dec = Charsets.UTF_8.newDecoder()
                    .onMalformedInput(java.nio.charset.CodingErrorAction.REPORT)
                    .onUnmappableCharacter(java.nio.charset.CodingErrorAction.REPORT)
                return try { sb.append(dec.decode(java.nio.ByteBuffer.wrap(bytes))); true } catch (_: Exception) { false }
            }
            while (i < s.length) {
                val c = s[i]
                if (c == '%') {
                    if (i + 2 >= s.length) return null
                    val h = s.substring(i + 1, i + 3).toIntOrNull(16) ?: return null
                    out.write(h); i += 3
                } else {
                    if (!flush()) return null
                    sb.append(c); i++
                }
            }
            if (!flush()) return null
            return sb.toString()
        }
    }
}
