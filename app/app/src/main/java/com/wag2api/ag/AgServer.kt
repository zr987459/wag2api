package com.wag2api.ag

import android.content.Context
import android.util.Log
import okhttp3.HttpUrl
import okhttp3.HttpUrl.Companion.toHttpUrlOrNull
import okhttp3.Response
import org.json.JSONArray
import org.json.JSONObject
import java.io.BufferedInputStream
import java.io.ByteArrayOutputStream
import java.io.EOFException
import java.io.File
import java.io.IOException
import java.io.InputStream
import java.io.OutputStream
import java.net.InetAddress
import java.net.InetSocketAddress
import java.net.ServerSocket
import java.net.Socket
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import java.util.TimeZone
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.SynchronousQueue
import java.util.concurrent.ThreadPoolExecutor
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger

/**
 * 进程内 HTTP 服务：src/server.mjs 的 Kotlin 版。路由、状态码与返回体与 Node 版一致。
 * 只监听 127.0.0.1 的随机端口，所有请求都要带 X-Engine-Token（宿主 EngineRouter.proxyToNode 会带）。
 * 请求在线程池里同步处理；流式响应由 SseStreamer / OpenaiAgConverter 逐行写出。
 */
object AgServer {
    private const val TAG = "AgServer"
    private const val VERSION = "1.3.1"
    private const val NOT_SUPPORTED = "not supported on android"

    // ---------------------------------------------------------------- 引擎状态（进程内只建一次）

    private class Core(dataDir: File) {
        val accountPool = AccountPool(File(dataDir, "accounts").path)
        val oauth = OAuthFlowManager(accountPool)
        val access = AccessControl(File(dataDir, "keys.json").path)
        val cooldowns = UpstreamPolicy.Cooldowns()
        /** email → Gemini 各家族剩余比例（来自 /api/gemini/quota），只用来决定换到哪个号 */
        val quotaCache: MutableMap<String, JSONObject> = ConcurrentHashMap()
        val stats: StatsTracker get() = Stats.statsTracker
    }

    @Volatile private var core: Core? = null
    @Volatile private var serverSocket: ServerSocket? = null
    @Volatile private var pool: ThreadPoolExecutor? = null
    @Volatile private var tokenProvider: () -> String = { "" }
    @Volatile private var appCtx: Context? = null
    @Volatile private var lastClientHeaders: JSONObject? = null
    @Volatile var port: Int = 0
        private set

    // 失败处理参数（默认关闭降级以保护前缀缓存，放宽超时避免长上下文误杀）
    private val POLICY_ALLOW_DOWNGRADE = (System.getenv("ALLOW_DOWNGRADE") ?: "0") in setOf("1", "true")
    private val POLICY_STREAM_HEADER_TIMEOUT_MS = System.getenv("UPSTREAM_HEADER_TIMEOUT_MS")?.toLongOrNull()?.takeIf { it > 0 } ?: 180000L
    private val POLICY_NONSTREAM_HEADER_TIMEOUT_MS = System.getenv("UPSTREAM_NONSTREAM_TIMEOUT_MS")?.toLongOrNull()?.takeIf { it > 0 } ?: 300000L
    private val POLICY_RETRY_DEADLINE_MS = System.getenv("RETRY_DEADLINE_MS")?.toLongOrNull()?.takeIf { it > 0 } ?: 90000L

    private val DAILY_HOST: String = Constants.ANTIGRAVITY_ENDPOINT_DAILY.toHttpUrlOrNull()?.host ?: ""

    // 仅管理员可访问的内部接口
    private val ADMIN_PATHS = setOf(
        "/api/status", "/api/stats", "/api/token-stats", "/api/logs", "/api/logs/clear", "/api/gemini/test", "/api/gemini/auth",
        "/api/oauth/exchange", "/api/oauth/token-exchange", "/api/accounts/add-token", "/api/accounts/switch",
        "/api/accounts/remove", "/api/accounts/export", "/api/accounts/import", "/api/trend", "/api/stats/timing",
        "/api/accounts/clear-validation",
        "/api/accounts/test", "/api/accounts/test-all", "/api/scheduling",
    )

    /** 启动（已在运行则返回现有端口）；返回监听端口 */
    @JvmStatic
    @Synchronized
    fun start(ctx: Context, tokenProvider: () -> String): Int {
        this.tokenProvider = tokenProvider
        this.appCtx = ctx.applicationContext
        serverSocket?.let { if (!it.isClosed) return port }

        val c = core ?: Core(AgPaths.dataDir).also { core = it }
        try {
            // 从 Supabase 恢复账号（安卓版不支持，DbVault 内部为空操作）
            DbVault.dbVault.restore(onAgAccount = { email, refreshToken, projectId -> c.accountPool.addAccount(refreshToken, email, projectId) })
        } catch (_: Throwable) {}
        c.oauth.initPermanentListener()

        val ss = ServerSocket()
        ss.reuseAddress = true
        ss.bind(InetSocketAddress(InetAddress.getByName("127.0.0.1"), 0), 64)
        serverSocket = ss
        port = ss.localPort

        val counter = AtomicInteger(0)
        val p = ThreadPoolExecutor(2, 64, 60, TimeUnit.SECONDS, SynchronousQueue()) { r ->
            Thread(r, "ag-http-" + counter.incrementAndGet()).apply { isDaemon = true }
        }
        // [P3] 线程池满时直接回 503 并关连接；CallerRunsPolicy 会让 accept 线程去跑一个可能长达几分钟的流式请求，期间整个端口不再接新连接
        p.rejectedExecutionHandler = java.util.concurrent.RejectedExecutionHandler { r, _ -> (r as? ServeTask)?.reject() }
        // [P4] 空闲 60 秒后连核心线程也回收
        p.allowCoreThreadTimeOut(true)
        pool = p

        Thread({
            while (!ss.isClosed) {
                val s = try { ss.accept() } catch (e: IOException) { if (ss.isClosed) break else continue }
                try {
                    p.execute(ServeTask(s))
                } catch (e: Throwable) {
                    try { s.close() } catch (_: Exception) {}
                }
            }
        }, "ag-http-accept").apply { isDaemon = true }.start()

        if (System.getenv("AG_DISABLE_AUTO_REFRESH") != "1") {
            try { QuotaRefresher.startQuotaRefreshLoop(c.accountPool, c.quotaCache) } catch (e: Throwable) { Log.w(TAG, "额度刷新启动失败: ${e.message}") }
        }
        Log.i(TAG, "🚀 AG 引擎已启动 http://127.0.0.1:$port ，数据 ${AgPaths.dataDir}")
        return port
    }

    /** 停止监听并落盘统计（账号池等状态保留在进程内，下次 start 直接复用） */
    @JvmStatic
    @Synchronized
    fun stop() {
        try { QuotaRefresher.stopQuotaRefreshLoop() } catch (_: Throwable) {}
        try { core?.stats?.flush() } catch (_: Throwable) {}
        try { QuotaFetcher.flushObservedQuotasSync() } catch (_: Throwable) {}
        try { serverSocket?.close() } catch (_: Throwable) {}
        serverSocket = null
        pool?.shutdown()
        pool = null
        port = 0
    }

    // ---------------------------------------------------------------- HTTP 请求 / 响应

    class AgRequest(
        val method: String,
        /** 原始请求目标（路径 + 查询串） */
        val target: String,
        /** 小写键 */
        val headers: Map<String, String>,
        private val input: InputStream,
        private val contentLength: Long,
        private val chunked: Boolean,
    ) {
        /** 规范化后的路径（同 Node 版对 url.pathname 的改写） */
        var path: String = "/"
        val url: HttpUrl = ("http://localhost" + (if (target.startsWith("/")) target else "/$target")).toHttpUrlOrNull()
            ?: "http://localhost/".toHttpUrlOrNull()!!
        private var rawBody: String? = null

        fun query(name: String): String? = url.queryParameter(name)

        /** 按字节收齐再解码；同一请求只读一次 */
        @Synchronized
        fun readRawBody(): String {
            rawBody?.let { return it }
            val s = try {
                String(readBodyBytes(), Charsets.UTF_8)
            } catch (e: Exception) { "" }
            rawBody = s
            return s
        }

        fun setRawBody(s: String) { rawBody = s }

        /** JSON.parse(body || '{}')，失败或不是对象时返回空对象 */
        fun readBody(): JSONObject {
            val b = readRawBody()
            return try { JsCompat.parse(b.ifEmpty { "{}" }) as? JSONObject ?: JSONObject() } catch (e: Exception) { JSONObject() }
        }

        private fun readBodyBytes(): ByteArray {
            if (chunked) {
                val out = ByteArrayOutputStream()
                while (true) {
                    val line = readLine(input) ?: break
                    val size = line.substringBefore(';').trim().toIntOrNull(16) ?: break
                    if (size == 0) { while (true) { val t = readLine(input) ?: break; if (t.isEmpty()) break }; break }
                    if (size < 0 || out.size().toLong() + size > MAX_BODY_BYTES) throw IOException("request body too large")
                    val buf = ByteArray(size)
                    readFully(input, buf)
                    out.write(buf)
                    readLine(input)
                }
                return out.toByteArray()
            }
            if (contentLength <= 0) return ByteArray(0)
            if (contentLength > MAX_BODY_BYTES) throw IOException("request body too large")
            val buf = ByteArray(contentLength.toInt())
            readFully(input, buf)
            return buf
        }
    }

    /** 响应：Node http.ServerResponse 用到的部分；同时是流式转换的 StreamClient */
    class AgResponse(private val socket: Socket, private val out: OutputStream) : SseStreamer.StreamClient {
        private val headerMap = LinkedHashMap<String, Pair<String, String>>() // lower → (name, value)
        @Volatile var headersSent = false
            private set
        @Volatile private var closed = false
        private var streaming = false

        override fun setHeader(name: String, value: String) {
            headerMap[name.lowercase(Locale.ROOT)] = name to value
        }

        fun getHeader(name: String): String? = headerMap[name.lowercase(Locale.ROOT)]?.second

        private fun reason(status: Int) = when (status) {
            200 -> "OK"; 204 -> "No Content"; 302 -> "Found"; 400 -> "Bad Request"; 401 -> "Unauthorized"; 403 -> "Forbidden"
            404 -> "Not Found"; 405 -> "Method Not Allowed"; 409 -> "Conflict"; 429 -> "Too Many Requests"; 499 -> "Client Closed Request"
            500 -> "Internal Server Error"; 502 -> "Bad Gateway"; 503 -> "Service Unavailable"; else -> "OK"
        }

        /** res.writeHead(status, headers)；contentLength 为 null 时按“读到连接关闭为止”的流式响应发送 */
        @Throws(IOException::class)
        fun writeHead(status: Int, extra: Map<String, String> = emptyMap(), contentLength: Long? = null) {
            if (headersSent) return
            for ((k, v) in extra) setHeader(k, v)
            val sb = StringBuilder()
            sb.append("HTTP/1.1 ").append(status).append(' ').append(reason(status)).append("\r\n")
            for ((lower, nv) in headerMap) {
                if (lower == "content-length" || lower == "connection" || lower == "transfer-encoding") continue
                sb.append(nv.first).append(": ").append(sanitizeHeader(nv.second)).append("\r\n")
            }
            if (contentLength != null) sb.append("Content-Length: ").append(contentLength).append("\r\n")
            else streaming = true
            sb.append("Connection: close\r\n\r\n")
            headersSent = true
            try {
                out.write(sb.toString().toByteArray(Charsets.UTF_8))
                if (streaming) out.flush()
            } catch (e: IOException) {
                closed = true
                throw e
            }
        }

        private fun sanitizeHeader(v: String) = v.replace("\r", " ").replace("\n", " ")

        fun sendBytes(status: Int, contentType: String?, body: ByteArray, extra: Map<String, String> = emptyMap()) {
            if (headersSent) return
            try {
                val h = LinkedHashMap<String, String>()
                if (contentType != null) h["Content-Type"] = contentType
                h.putAll(extra)
                writeHead(status, h, body.size.toLong())
                out.write(body)
                out.flush()
            } catch (e: IOException) {
                closed = true
            }
        }

        fun sendJson(status: Int, obj: Any?) {
            val text = JsCompat.stringify(obj) ?: "null"
            sendBytes(status, "application/json", text.toByteArray(Charsets.UTF_8))
        }

        // ---- SseStreamer.StreamClient
        override fun flushHeaders() {
            try { writeHead(200) } catch (_: IOException) {}
        }

        @Throws(IOException::class)
        override fun write(chunk: String) {
            if (closed) throw IOException("client closed")
            if (!headersSent) writeHead(200)
            try {
                out.write(chunk.toByteArray(Charsets.UTF_8))
            } catch (e: IOException) {
                closed = true
                throw e
            }
        }

        override fun flush() {
            try { out.flush() } catch (e: IOException) { closed = true }
        }

        override fun end() {
            if (!headersSent) try { writeHead(200, contentLength = 0) } catch (_: IOException) {}
            try { out.flush() } catch (_: IOException) {}
            closed = true
        }

        override val isClosed: Boolean
            get() = closed || socket.isClosed || socket.isOutputShutdown
    }

    /** 线程池任务：被拒绝时回 503 */
    private class ServeTask(val sock: Socket) : Runnable {
        override fun run() = serve(sock)
        fun reject() {
            try {
                sock.soTimeout = 2000
                val body = "{\"error\":\"engine busy\"}".toByteArray(Charsets.UTF_8)
                val out = sock.getOutputStream()
                out.write(("HTTP/1.1 503 Service Unavailable\r\nContent-Type: application/json\r\nContent-Length: ${body.size}\r\nRetry-After: 2\r\nConnection: close\r\n\r\n").toByteArray(Charsets.US_ASCII))
                out.write(body)
                out.flush()
            } catch (_: Throwable) {
            } finally {
                try { sock.close() } catch (_: Throwable) {}
            }
        }
    }

    /** [P3] 请求体上限（手机内存有限；与前门 LocalGatewayServer 一致） */
    const val MAX_BODY_BYTES: Long = 64L * 1024 * 1024

    /**
     * [P3] 前门鉴权：管理密钥开启时，AIS 路由与 /ais-local/export 也要校验（以前只有 AG 引擎内校验，AIS 路径可绕过）。
     * 引擎未启动时直接读 filesDir/ag/keys.json。未设置密钥时恒为 true。
     */
    @JvmStatic
    fun frontDoorAllows(ctx: Context, headers: Map<String, String>, target: String): Boolean {
        val access = core?.access ?: try {
            AccessControl(File(File(ctx.applicationContext.filesDir, "ag"), "keys.json").path)
        } catch (_: Throwable) { return true }
        return access.isAdmin(headers, target)
    }

    private fun readLine(input: InputStream, max: Int = 64 * 1024): String? {
        val buf = ByteArrayOutputStream(128)
        while (true) {
            val b = input.read()
            if (b < 0) return if (buf.size() == 0) null else buf.toString("ISO-8859-1")
            if (b == '\n'.code) break
            if (b != '\r'.code) buf.write(b)
            if (buf.size() > max) throw IOException("header line too long")
        }
        return buf.toString("ISO-8859-1")
    }

    private fun readFully(input: InputStream, buf: ByteArray) {
        var off = 0
        while (off < buf.size) {
            val n = input.read(buf, off, buf.size - off)
            if (n < 0) throw EOFException("client closed: got $off / ${buf.size} bytes")
            off += n
        }
    }

    private fun serve(s: Socket) {
        try {
            s.use { sock ->
                sock.tcpNoDelay = true
                sock.soTimeout = 300_000
                val input = BufferedInputStream(sock.getInputStream())
                val out = sock.getOutputStream()
                val requestLine = readLine(input) ?: return
                val parts = requestLine.split(' ')
                if (parts.size < 2) return
                val headers = LinkedHashMap<String, String>()
                var count = 0
                while (true) {
                    val l = readLine(input) ?: break
                    if (l.isEmpty()) break
                    if (++count > 200) break
                    val i = l.indexOf(':')
                    if (i <= 0) continue
                    val k = l.substring(0, i).trim().lowercase(Locale.ROOT)
                    val v = l.substring(i + 1).trim()
                    headers[k] = headers[k]?.let { "$it, $v" } ?: v
                }
                val cl = headers["content-length"]?.trim()?.toLongOrNull() ?: 0L
                val chunked = headers["transfer-encoding"]?.contains("chunked", ignoreCase = true) == true
                val req = AgRequest(parts[0].uppercase(Locale.ROOT), parts[1], headers, input, cl, chunked)
                val res = AgResponse(sock, out)
                try {
                    handle(req, res)
                } catch (t: Throwable) {
                    Log.e(TAG, Redact.redact("[Request Error] ${req.method} ${Redact.pathOnly(req.target)}: ${t}"))
                    if (!res.headersSent) res.sendJson(500, JSONObject().put("error", t.message ?: t.toString()))
                }
                try { out.flush() } catch (_: IOException) {}
            }
        } catch (_: Throwable) {
        }
    }

    // ---------------------------------------------------------------- 路由

    private fun sendJson(res: AgResponse, status: Int, obj: Any?) = res.sendJson(status, obj)

    private fun denyAdmin(res: AgResponse) {
        sendJson(res, 401, JSONObject().put("ok", false).put("need_admin", true).put("error", "需要管理密钥"))
    }

    private fun notSupported(res: AgResponse) {
        sendJson(res, 200, JSONObject().put("ok", false).put("error", NOT_SUPPORTED))
    }

    /** 把 body.model 的引擎前缀去掉，返回新的原文 */
    private fun stripModelPrefix(raw: String, prefix: String): String {
        if (prefix.isEmpty() || raw.isEmpty()) return raw
        return try {
            val j = JsCompat.parse(raw) as? JSONObject ?: return raw
            val m = j.opt("model")
            if (m is String && m.startsWith(prefix)) {
                j.put("model", m.substring(prefix.length))
                JsCompat.stringify(j) ?: raw
            } else raw
        } catch (e: Exception) { raw }
    }

    private val WEB_TYPES = mapOf(
        "html" to "text/html; charset=utf-8", "js" to "application/javascript; charset=utf-8", "css" to "text/css; charset=utf-8",
        "json" to "application/json; charset=utf-8", "svg" to "image/svg+xml", "png" to "image/png",
    )
    private val WEB_NAME = Regex("^[A-Za-z0-9_.-]+$")
    private val WEB_PREFIX = Regex("^/(panel|wag)(/|$)")
    private val WEB_FILE = Regex("^/[A-Za-z0-9_.-]+\\.(html|js|css|json|svg|png)$")

    /** 控制台网页：与宿主共用 assets/web */
    private fun serveWeb(pathname: String, res: AgResponse): Boolean {
        val cleanPath = pathname.replaceFirst(WEB_PREFIX, "/")
        val name = if (cleanPath == "/") "index.html" else cleanPath.trimStart('/')
        if (!WEB_NAME.matches(name)) return false
        val type = WEB_TYPES[name.substringAfterLast('.', "")] ?: return false
        val ctx = appCtx ?: return false
        val body = try { ctx.assets.open("web/$name").use { it.readBytes() } } catch (e: Exception) { return false }
        res.sendBytes(200, type, body, mapOf("Cache-Control" to "no-cache"))
        return true
    }

    private val RE_MULTI_SLASH = Regex("/{2,}")
    private val RE_TRAIL_SLASH = Regex("/+$")
    private val RE_COUNT_TOKENS = Regex("(^|/)messages/count_tokens$")
    private val RE_MESSAGES = Regex("(^|/)messages$")
    private val RE_CHAT = Regex("(^|/)chat/completions$")
    private val RE_MODELS = Regex("(^|/)v1/models$")

    private fun normalizePath(raw: String): String {
        var p = raw.replace(RE_MULTI_SLASH, "/").replace(RE_TRAIL_SLASH, "").ifEmpty { "/" }
        if (RE_COUNT_TOKENS.containsMatchIn(p) && !p.startsWith("/api/")) p = "/v1/messages/count_tokens"
        else if (RE_MESSAGES.containsMatchIn(p) && !p.startsWith("/api/")) p = "/v1/messages"
        else if (RE_CHAT.containsMatchIn(p) && !p.startsWith("/api/")) p = "/v1/chat/completions"
        else if (RE_MODELS.containsMatchIn(p)) p = "/v1/models"
        return p
    }

    private fun isoNow(): String = SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss.SSS'Z'", Locale.US).apply {
        timeZone = TimeZone.getTimeZone("UTC")
    }.format(Date())

    private fun str(o: JSONObject, k: String): String {
        val v = o.opt(k)
        return if (v == null || v == JSONObject.NULL) "" else v.toString()
    }

    private fun handle(req: AgRequest, res: AgResponse) {
        val c = core ?: run { sendJson(res, 503, JSONObject().put("error", "engine not ready")); return }
        res.setHeader("Access-Control-Allow-Origin", "*")
        res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS, DELETE")
        res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, x-api-key, x-admin-key, anthropic-version")
        res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate")

        if (req.method == "OPTIONS") {
            res.sendBytes(204, null, ByteArray(0))
            return
        }

        // ── 内部引擎令牌校验：防止手机上其他 App 直接连内部端口绕过前门
        val engineToken = try { tokenProvider() } catch (e: Exception) { "" }
        if (engineToken.isNotEmpty()) {
            val given = req.headers["x-engine-token"]
            if (given != engineToken) {
                res.sendBytes(403, "application/json; charset=utf-8", "{\"error\":\"engine token required\"}".toByteArray(Charsets.UTF_8))
                return
            }
        }
        req.path = normalizePath(req.url.encodedPath.let { try { java.net.URLDecoder.decode(it.replace("+", "%2B"), "UTF-8") } catch (e: Exception) { it } })
        val path = req.path
        val method = req.method
        val access = c.access
        val pool = c.accountPool
        val stats = c.stats
        fun isAdmin() = access.isAdmin(req.headers, req.target)

        // 1. 控制台网页
        val isWebPath = path == "/" || WEB_PREFIX.containsMatchIn(path) || WEB_FILE.matches(path)
        if (method == "GET" && isWebPath && serveWeb(path, res)) return
        if (path == "/token" || path == "/get-token" || path == "/token.html") {
            res.sendBytes(302, null, ByteArray(0), mapOf("Location" to "/"))
            return
        }

        // 1.0.1 引擎状态
        if (path == "/panel/api/engine/state" || path == "/m/api/engine/state") {
            sendJson(res, 200, JSONObject().put("supported", true).put("enabled", true).put("state", "READY").put("port", port)
                .put("default_engine", "ag").put("standalone", true).put("auth", access.enabled))
            return
        }

        // 1.0.4 前门分流
        if (method == "POST" && (path == "/v1/messages" || path == "/v1/chat/completions")) {
            val raw = req.readRawBody()
            var model = ""
            try { model = JsCompat.str(JsCompat.or((JsCompat.parse(raw) as? JSONObject)?.opt("model"), "")) } catch (e: Exception) {}
            if (model.startsWith("wb:") || model.startsWith("ais:")) {
                sendJson(res, 400, JSONObject().put("error", JSONObject().put("type", "invalid_request_error")
                    .put("message", "Linux 版暂不内置 AIS 引擎").put("code", "ais_not_supported")))
                return
            }
            req.setRawBody(stripModelPrefix(raw, "ag:"))
        }

        // 1.5 OAuth 回调
        if (path == "/oauth-callback" || path == "/oauth-result") {
            val reply = c.oauth.handleHttp(req.target)
            if (reply != null) {
                val h = LinkedHashMap(reply.headers)
                val ct = h.remove("Content-Type") ?: reply.contentType
                res.sendBytes(reply.status, ct, reply.body.toByteArray(Charsets.UTF_8), h)
                return
            }
        }

        // 1.6 健康检查
        if (path == "/health") {
            sendJson(res, 200, JSONObject().put("ok", true).put("app", "ag-open-gateway").put("version", VERSION).put("auth", access.enabled))
            return
        }

        // 1.7 管理接口鉴权拦截
        if (ADMIN_PATHS.contains(path) && !isAdmin()) {
            denyAdmin(res)
            return
        }

        // 2. 真实配额接口
        if (path == "/api/gemini/quota") {
            val email = req.query("email")
            val mgr = if (!email.isNullOrEmpty()) pool.getManager(email) else pool.getActiveManager()
            val targetMgr = mgr ?: pool.getActiveManager()
            val quotaData = QuotaFetcher.fetchRealQuota(targetMgr)
            val qEmail = quotaData.opt("email")
            if (quotaData.optBoolean("ok", false) && JsCompat.truthy(qEmail)) {
                val familyQuotas = QuotaFetcher.computeAccountQuotas(quotaData)
                c.quotaCache[qEmail.toString()] = familyQuotas
                pool.updateQuota(qEmail.toString(), quotaData)
            }
            sendJson(res, 200, quotaData)
            return
        }

        // 2.2 AG 账号池调度与切换
        if (path == "/api/accounts/pool") {
            sendJson(res, 200, JSONObject().put("ok", true).put("accounts", pool.poolStatus())
                .put("selected_email", pool.getSelectedEmail()).put("scheduling", pool.getScheduling()))
            return
        }
        if (path == "/api/scheduling" && method == "POST") {
            try {
                val b = req.readBody()
                val body = JSONObject()
                for (k in arrayOf("mode", "fixed_email", "prewarm_weekly")) if (b.has(k)) body.put(k, b.opt(k))
                val scheduling = pool.setScheduling(body)
                sendJson(res, 200, JSONObject().put("ok", true).put("scheduling", scheduling))
            } catch (e: Exception) {
                sendJson(res, 400, JSONObject().put("ok", false).put("error", e.message))
            }
            return
        }
        if (path == "/api/accounts/test" && method == "POST") {
            try {
                val body = req.readBody()
                val email = JsCompat.str(JsCompat.or(body.opt("email"), ""))
                val model = JsCompat.str(JsCompat.or(body.opt("model"), "gemini-3.8-flash"))
                sendJson(res, 200, AccountTester.testAccount(email, model, pool, c.cooldowns))
            } catch (e: Exception) {
                sendJson(res, 500, JSONObject().put("ok", false).put("error", e.message))
            }
            return
        }
        if (path == "/api/accounts/test-all" && method == "POST") {
            try {
                val body = req.readBody()
                val model = JsCompat.str(JsCompat.or(body.opt("model"), "gemini-3.8-flash"))
                sendJson(res, 200, AccountTester.testAllAccounts(model, pool, c.cooldowns))
            } catch (e: Exception) {
                sendJson(res, 500, JSONObject().put("ok", false).put("error", e.message))
            }
            return
        }
        if (path == "/api/accounts/select" && method == "POST") {
            try {
                val emailV = req.readBody().opt("email")
                val email = if (emailV == null || emailV == JSONObject.NULL) null else emailV.toString()
                pool.setSelectedEmail(email)
                sendJson(res, 200, JSONObject().put("ok", true).put("selected_email", pool.getSelectedEmail())
                    .put("message", if (!email.isNullOrEmpty()) "已锁定账号 $email" else "已改为全自动智能轮询"))
            } catch (e: Exception) {
                sendJson(res, 500, JSONObject().put("ok", false).put("error", e.message))
            }
            return
        }
        if (path == "/api/accounts/clear-cooldown" && method == "POST") {
            pool.clearAllCooldowns()
            c.cooldowns.clear()
            sendJson(res, 200, JSONObject().put("ok", true).put("message", "AG 账号池冷却已全部清除"))
            return
        }
        if (path == "/api/accounts/clear-validation" && method == "POST") {
            val email = str(req.readBody(), "email")
            if (email.isNotEmpty()) pool.clearValidationBlocked(email) else pool.clearAllValidationBlocks()
            sendJson(res, 200, JSONObject().put("ok", true)
                .put("message", if (email.isNotEmpty()) "账号 $email 验证封禁已清除" else "所有账号验证封禁已清除"))
            return
        }

        // 3. 统计数据与日志
        if (path == "/api/stats") {
            val s = stats.getStats()
            s.put("cooldowns", c.cooldowns.list())
            sendJson(res, 200, s)
            return
        }
        if (path == "/api/token-stats") {
            val range = req.query("range").let { if (it.isNullOrEmpty()) "day" else it }
            sendJson(res, 200, stats.getTokenStats(range))
            return
        }
        if (path == "/api/debug/cache") {
            sendJson(res, 200, JSONObject().put("pin", HistoryPin.historyPin.stats()).put("session", SessionRouter.sessionStats())
                .put("clientHeaders", lastClientHeaders ?: JSONObject.NULL).put("requests", JSONArray()))
            return
        }
        if (path == "/api/stats/timing") {
            val n = req.query("n")?.toDoubleOrNull()?.toInt()?.takeIf { it != 0 } ?: 20
            sendJson(res, 200, stats.getTimingSummary(n))
            return
        }
        if (path == "/api/logs") {
            sendJson(res, 200, stats.getAllLogs(100))
            return
        }
        if (path == "/api/logs/clear" && method == "POST") {
            val resetAll = req.query("all") == "1"
            if (resetAll) stats.resetStats() else stats.clearAllLogs()
            sendJson(res, 200, JSONObject().put("ok", true).put("resetAll", resetAll))
            return
        }
        if (path == "/api/stats/reset" && method == "POST") {
            stats.resetStats()
            sendJson(res, 200, JSONObject().put("ok", true).put("message", "统计数据已归零"))
            return
        }

        // 4. 模型列表
        if (path == "/v1/models" || path == "/models" || path == "/api/models") {
            sendJson(res, 200, ModelsCatalog.getModelsResponse())
            return
        }

        // 5. 服务状态
        if (path == "/api/status") {
            val activeMgr = pool.getActiveManager()
            val host = req.headers["host"] ?: ""
            val status = JSONObject()
                .put("app", "ag-open-gateway")
                .put("version", VERSION)
                .put("auth_enabled", access.enabled)
                .put("port", port)
                .put("auth_url", c.oauth.getAuthUrl(host))
                .put("active_account", activeMgr?.getStatus() ?: JSONObject.NULL)
                .put("accounts", pool.getAllStatus())
                .put("stats", stats.getStats())
                .put("signature_cache_size", SignatureCache.signatureCache.size())
                .put("persist", JSONObject().put("enabled", false).put("branch", JSONObject.NULL).put("last_sync", JSONObject.NULL).put("error", JSONObject.NULL))
            sendJson(res, 200, status)
            return
        }

        // 6. 出字测速 / 预热 / 集群测速：安卓版不移植（test-runner / prewarm / host-bench）
        if (path == "/api/gemini/test" && method == "POST") { notSupported(res); return }
        if (path == "/api/prewarm") {
            if (!isAdmin()) { denyAdmin(res); return }
            notSupported(res); return
        }
        if (path == "/api/bench/hosts") {
            if (!isAdmin()) { denyAdmin(res); return }
            notSupported(res); return
        }

        // 7. OAuth 授权链接
        if (path == "/api/gemini/auth" && method == "POST") {
            val authUrl = c.oauth.getAuthUrl(req.headers["host"] ?: "")
            sendJson(res, 200, JSONObject().put("ok", true).put("auth_url", authUrl).put("message", "授权链接已就绪"))
            return
        }

        // 8. 手动回贴回调 URL 或 Code 换票入池
        if (path == "/api/oauth/exchange" && method == "POST") {
            try {
                val input = req.readBody().opt("code_or_url")
                if (!JsCompat.truthy(input)) {
                    sendJson(res, 400, JSONObject().put("ok", false).put("error", "请粘贴回调 URL 或 Code"))
                    return
                }
                val r = c.oauth.exchangeRawInput(input)
                if (r.refreshToken.isNotEmpty() && r.email.isNotEmpty()) pool.addAccount(r.refreshToken, r.email)
                sendJson(res, 200, JSONObject().put("ok", true).put("message", "账号 ${r.email} 授权成功并加入账号池！")
                    .put("email", r.email).put("refreshToken", r.refreshToken))
            } catch (e: Exception) {
                sendJson(res, 500, JSONObject().put("ok", false).put("error", e.message))
            }
            return
        }

        // 8.5 专门提取 Token 的 API
        if (path == "/api/oauth/token-exchange" && method == "POST") {
            try {
                val input = req.readBody().opt("code_or_url")
                if (!JsCompat.truthy(input)) {
                    sendJson(res, 400, JSONObject().put("ok", false).put("error", "请粘贴回调 URL 或 Code"))
                    return
                }
                val r = c.oauth.exchangeRawInput(input)
                sendJson(res, 200, JSONObject().put("ok", true).put("email", r.email).put("refreshToken", r.refreshToken).put("accessToken", r.accessToken))
            } catch (e: Exception) {
                sendJson(res, 500, JSONObject().put("ok", false).put("error", e.message))
            }
            return
        }

        // 8.6 直接通过 Refresh Token 添加账号
        if (path == "/api/accounts/add-token" && method == "POST") {
            try {
                val rt = req.readBody().opt("refresh_token")
                if (rt !is String || rt.trim().isEmpty()) {
                    sendJson(res, 400, JSONObject().put("ok", false).put("error", "请提供有效的 Refresh Token"))
                    return
                }
                val r = c.oauth.validateAndAddRefreshToken(rt)
                sendJson(res, 200, JSONObject().put("ok", true).put("message", "账号 ${r.email} 验证通过并已成功加入账号池！").put("email", r.email))
            } catch (e: Exception) {
                sendJson(res, 500, JSONObject().put("ok", false).put("error", e.message))
            }
            return
        }

        // 8.7 账号导出（含 Refresh Token，可直接回导）
        if (path == "/api/accounts/export") {
            val only = (req.query("email") ?: "").trim().lowercase(Locale.ROOT)
            val accounts = JSONArray()
            for ((email, tm) in pool.managers) {
                if (only.isNotEmpty() && email != only) continue
                if (tm.tokenData.refreshToken.isEmpty()) continue
                accounts.put(JSONObject().put("email", email).put("refresh_token", tm.tokenData.refreshToken).put("project_id", tm.tokenData.projectId))
            }
            sendJson(res, 200, JSONObject().put("ok", true).put("format", "wag2api-ag").put("version", 1)
                .put("exported_at", isoNow()).put("accounts", accounts))
            return
        }

        // 8.8 批量导入
        if (path == "/api/accounts/import" && method == "POST") {
            val raw = req.readBody().opt("raw")
            val items = AgImport.parseAgImport(raw)
            if (items.length() == 0) {
                sendJson(res, 400, JSONObject().put("ok", false).put("error", "没有识别到 Refresh Token（应以 1// 开头）"))
                return
            }
            val added = JSONArray()
            val failed = JSONArray()
            for (i in 0 until items.length()) {
                val it = items.optJSONObject(i) ?: continue
                val rt = str(it, "refresh_token")
                try {
                    val r = c.oauth.validateAndAddRefreshToken(rt)
                    added.put(r.email)
                } catch (e: Exception) {
                    val em = str(it, "email")
                    failed.put(JSONObject().put("email", if (em.isNotEmpty()) em else rt.take(12) + "…").put("error", e.message))
                }
            }
            sendJson(res, 200, JSONObject().put("ok", added.length() > 0).put("added", added).put("failed", failed)
                .put("message", "导入成功 ${added.length()} 个" + (if (failed.length() > 0) "，失败 ${failed.length()} 个" else "")))
            return
        }

        // 8.9 全部账号汇总的 24 小时趋势
        if (path == "/api/trend") {
            sendJson(res, 200, stats.getAggregateTrend())
            return
        }

        // 9. 账号切换与管理
        if (path == "/api/accounts/switch" && method == "POST") {
            try {
                val email = str(req.readBody(), "email")
                pool.switchAccount(email)
                sendJson(res, 200, JSONObject().put("ok", true).put("message", "已切换至账号 $email"))
            } catch (e: Exception) {
                sendJson(res, 500, JSONObject().put("ok", false).put("error", e.message))
            }
            return
        }
        if (path == "/api/accounts/remove" && method == "POST") {
            try {
                val email = str(req.readBody(), "email")
                pool.removeAccount(email)
                sendJson(res, 200, JSONObject().put("ok", true).put("message", "已移除账号 $email"))
            } catch (e: Exception) {
                sendJson(res, 500, JSONObject().put("ok", false).put("error", e.message))
            }
            return
        }

        // 9.5 Anthropic count_tokens：本地估算
        if (path == "/v1/messages/count_tokens" && method == "POST") {
            if (access.enabled && !isAdmin()) {
                sendJson(res, 401, JSONObject().put("type", "error").put("error", JSONObject().put("type", "authentication_error").put("message", "API Key 无效或缺失 (x-api-key)")))
                return
            }
            val body = try { JsCompat.parse(req.readRawBody().ifEmpty { "{}" }) } catch (e: Exception) { null }
            if (body !is JSONObject) {
                sendJson(res, 400, JSONObject().put("type", "error").put("error", JSONObject().put("type", "invalid_request_error").put("message", "请求体不是合法 JSON 对象")))
                return
            }
            sendJson(res, 200, JSONObject().put("input_tokens", TokenEstimate.estimateAnthropicInputTokens(body)))
            return
        }

        // 10. 核心推理接口
        val isOaiChat = path == "/v1/chat/completions"
        val isAnthropicMsg = path == "/v1/messages"
        if ((isOaiChat || isAnthropicMsg) && method == "POST") {
            handleInference(c, req, res, isOaiChat)
            return
        }

        Log.w(TAG, "[404] $method ${Redact.pathOnly(req.target)}")
        sendJson(res, 404, JSONObject().put("error", "Endpoint not found").put("method", method).put("path", path))
    }

    // ---------------------------------------------------------------- 推理

    private fun shallowCopy(o: JSONObject): JSONObject {
        val out = JSONObject()
        val it = o.keys()
        while (it.hasNext()) { val k = it.next(); out.put(k, o.opt(k)) }
        return out
    }

    private fun sendInferenceError(res: AgResponse, isOaiChat: Boolean, status: Int, oaiErr: JSONObject, anthErr: JSONObject) {
        if (isOaiChat) sendJson(res, status, JSONObject().put("error", oaiErr))
        else sendJson(res, status, JSONObject().put("type", "error").put("error", anthErr))
    }

    private fun handleInference(c: Core, req: AgRequest, res: AgResponse, isOaiChat: Boolean) {
        val body = req.readRawBody()
        val startTime = System.currentTimeMillis()
        val pool = c.accountPool
        val stats = c.stats
        // 分段打点：各时间点均为相对 startTime 的毫秒数；多次尝试时保留最后一次
        val timing = JSONObject()
            .put("t_token", JSONObject.NULL).put("t_payload", JSONObject.NULL).put("t_headers", JSONObject.NULL).put("t_tls", JSONObject.NULL)
            .put("conn_reused", JSONObject.NULL).put("host", JSONObject.NULL).put("attempts", 0)
            .put("switched_account", false).put("switched_host", false)
        fun mark(k: String) { synchronized(timing) { timing.put(k, System.currentTimeMillis() - startTime) } }
        fun markHeaders(u: String, r: Response?) {
            mark("t_headers")
            synchronized(timing) {
                u.toHttpUrlOrNull()?.host?.let { timing.put("host", it) }
                if (r != null) {
                    timing.put("conn_reused", UpstreamFetch.gwReused(r) ?: JSONObject.NULL)
                    timing.put("t_tls", UpstreamFetch.gwTlsMs(r) ?: JSONObject.NULL)
                }
            }
        }
        fun timingOut(extra: JSONObject? = null): JSONObject = synchronized(timing) {
            val o = shallowCopy(timing)
            val host = timing.opt("host")
            o.put("switched_host", host is String && host.isNotEmpty() && host != DAILY_HOST)
            if (extra != null) { val it = extra.keys(); while (it.hasNext()) { val k = it.next(); o.put(k, extra.opt(k)) } }
            o
        }
        var statsRecorded = false
        var statsEmail: String? = null
        var statsModel: String? = null
        try {
            if (c.access.enabled && !c.access.isAdmin(req.headers, req.target)) {
                if (isOaiChat) sendJson(res, 401, JSONObject().put("error", JSONObject().put("message", "Incorrect API key").put("type", "invalid_request_error")))
                else sendJson(res, 401, JSONObject().put("type", "error").put("error", JSONObject().put("type", "authentication_error").put("message", "API Key 无效或缺失 (x-api-key)")))
                return
            }

            val rawParsed = try { JsCompat.parse(body.ifEmpty { "{}" }) } catch (e: Exception) { null }
            if (rawParsed !is JSONObject) {
                // 非法 JSON 属于客户端错误：400 + 各协议标准错误体
                val msg = "请求体不是合法 JSON 对象"
                if (isOaiChat) sendJson(res, 400, JSONObject().put("error", JSONObject().put("message", msg).put("type", "invalid_request_error").put("code", JSONObject.NULL)))
                else sendJson(res, 400, JSONObject().put("type", "error").put("error", JSONObject().put("type", "invalid_request_error").put("message", msg)))
                return
            }
            val anthropicReq = if (isOaiChat) OpenaiAgConverter.openaiRequestToAnthropic(rawParsed) else rawParsed
            if (isOaiChat && rawParsed.has("stream")) {
                anthropicReq.put("stream", JsCompat.truthy(rawParsed.opt("stream")))
            }
            val reqModel: String = (anthropicReq.opt("model") as? String) ?: JsCompat.str(JsCompat.or(anthropicReq.opt("model"), ""))
            statsModel = anthropicReq.opt("model")?.takeIf { it != JSONObject.NULL }?.toString()

            // OpenAI 请求体里的 session_id / conversation_id / metadata 在协议转换时会丢，取会话 id 时用原始请求体（不用 user 字段）
            val sessionSrc = if (isOaiChat) shallowCopy(rawParsed).also { it.remove("user") } else anthropicReq
            val sessionKey = SessionRouter.clientSessionKey(req.headers, sessionSrc)
            anthropicReq.put("_gwSessionKey", sessionKey)
            val meta = anthropicReq.optJSONObject("metadata")
            lastClientHeaders = JSONObject()
                .put("names", JSONArray(req.headers.keys.sorted()))
                .put("metadataKeys", JSONArray(meta?.keys()?.asSequence()?.toList() ?: emptyList<String>()))
                .put("hasClientSession", sessionKey.isNotEmpty())

            // 智能选号：优先命中会话亲和表（保持 KV-Cache），新会话按最小负载轮询分发
            var activeMgr: TokenManager? = pool.pickManager(sessionKey, emptySet(), JSONObject().put("model", reqModel))
            if (activeMgr == null) {
                val errMsg = "账号池暂无可用 Google 账号，请在控制台添加账号"
                sendInferenceError(res, isOaiChat, 503, JSONObject().put("message", errMsg).put("type", "server_error"),
                    JSONObject().put("type", "api_error").put("message", errMsg))
                return
            }
            statsEmail = activeMgr.tokenData.email
            val isStreaming = JsCompat.truthy(anthropicReq.opt("stream"))

            val send: (JSONObject, TokenManager, String, Long) -> Response? = { payload, mgr, host, timeoutMs ->
                val tok = mgr.getValidAccessToken()
                val targetUrl = if (isStreaming) "$host/v1internal:streamGenerateContent?alt=sse" else "$host/v1internal:generateContent"
                synchronized(timing) { timing.put("attempts", timing.optInt("attempts", 0) + 1) }
                val r = UpstreamFetch.upstreamFetch(
                    targetUrl,
                    UpstreamFetch.Options(
                        method = "POST",
                        headers = Cloudcode.buildAntigravityHeaders(tok),
                        body = JsCompat.stringify(payload) ?: "{}",
                        headerTimeoutMs = timeoutMs,
                    )
                )
                markHeaders(targetUrl, r)
                r
            }

            val ctx = UpstreamPolicy.Ctx<TokenManager>(
                model = reqModel,
                upstreamOf = { m -> Cloudcode.mapToUpstreamModel(m) },
                accounts = { pool.managers.values.toList() },
                emailOf = { m -> m.tokenData.email },
                projectOf = { m -> m.tokenData.projectId },
                cooldowns = c.cooldowns,
                buildPayload = { model, mgr ->
                    if (model == reqModel) {
                        anthropicReq.put("_gwEmail", mgr.tokenData.email)
                        val p = Cloudcode.buildCloudCodePayload(anthropicReq, mgr.tokenData.projectId)
                        mark("t_payload")
                        p
                    } else {
                        val copy = shallowCopy(anthropicReq).put("model", model).put("_gwEmail", mgr.tokenData.email)
                        val p = Cloudcode.buildCloudCodePayload(copy, mgr.tokenData.projectId)
                        mark("t_payload")
                        p
                    }
                },
                send = send,
                hosts = listOf(Constants.ANTIGRAVITY_ENDPOINT_DAILY, Constants.ANTIGRAVITY_ENDPOINT_AUTOPUSH),
            )
            ctx.anthropicReq = anthropicReq
            ctx.activeEmail = activeMgr.tokenData.email
            ctx.quotaOf = { email, family ->
                val fam = if (family.isNotEmpty()) family else QuotaFetcher.getModelFamily(reqModel)
                val q = pool.getQuota(email, fam)
                if (q != null) q else {
                    val cached = c.quotaCache[email]
                    (cached?.opt(fam) as? Number)?.toDouble()
                }
            }
            ctx.recordPerf = { email, ok, latencyMs -> pool.recordResult(email, ok, latencyMs) }
            ctx.onCooldown = { email, delayMs, _ -> pool.markCooling(email, delayMs) }
            ctx.prepare = { mgr ->
                val tok = mgr.getValidAccessToken()
                if (tok.isNullOrEmpty()) false else {
                    if (mgr.tokenData.projectId.isEmpty()) {
                        try { mgr.ensureProjectId() } catch (_: Exception) {}
                    }
                    mark("t_token")
                    true
                }
            }
            ctx.onBadRequest = { b, mgr -> SessionRouter.bumpSessionOnOverflow(anthropicReq, mgr.tokenData.email, b) }
            ctx.onValidationRequired = { mgr, b ->
                pool.markValidationBlocked(mgr.tokenData.email, b.take(300), UpstreamPolicy.extractValidationUrl(b))
            }
            ctx.isBlocked = { e -> pool.isValidationBlocked(e) }
            ctx.chain = Cloudcode.MODEL_FALLBACK_CHAINS[reqModel] ?: emptyList()
            ctx.allowDowngrade = POLICY_ALLOW_DOWNGRADE
            ctx.headerTimeoutMs = if (isStreaming) POLICY_STREAM_HEADER_TIMEOUT_MS else POLICY_NONSTREAM_HEADER_TIMEOUT_MS
            ctx.deadlineMs = POLICY_RETRY_DEADLINE_MS
            ctx.startedAt = startTime
            ctx.log = { m -> Log.w(TAG, m) }

            val result = UpstreamPolicy.runWithPolicy(ctx)

            synchronized(timing) { timing.put("switched_account", result.switchedAccount) }
            val resultMgr = result.mgr
            if (result.ok && resultMgr != null && resultMgr.tokenData.email.isNotEmpty()) {
                pool.clearValidationBlocked(resultMgr.tokenData.email)
            }
            if (resultMgr != null) {
                activeMgr = resultMgr
                statsEmail = resultMgr.tokenData.email
                if (sessionKey.isNotEmpty()) pool.bindSession(sessionKey, resultMgr.tokenData.email)
            }
            val mgrNow: TokenManager = activeMgr!!
            val modelUsed = result.modelUsed.ifEmpty { reqModel }
            val downgradeReason: Any = if (!result.reason.isNullOrEmpty() && result.downgraded) result.reason else JSONObject.NULL
            fun withDg(o: JSONObject): JSONObject = o.put("model_used", modelUsed).put("downgraded", result.downgraded).put("downgrade_reason", downgradeReason)
            res.setHeader("X-Gateway-Model-Requested", reqModel)
            res.setHeader("X-Gateway-Model-Used", modelUsed)
            if (result.downgraded) {
                res.setHeader("X-Gateway-Downgrade-Reason", downgradeReason.toString())
                Log.w(TAG, "[Downgrade] $reqModel → $modelUsed（$downgradeReason）")
            }
            val notice: String? = if (result.downgraded && DowngradeNotice.shouldInsertNotice(anthropicReq))
                DowngradeNotice.buildDowngradeNotice(reqModel, modelUsed, result.reason) else null

            if (!result.ok) {
                val e = result.error
                val errDetail = e?.body?.takeIf { it.isNotEmpty() } ?: "Google 集群无响应"
                var status = 502
                var type = "upstream_error"
                if (e?.kind == "bad_request") {
                    status = if (e.status in 400..499) e.status else 400
                    type = "invalid_request_error"
                } else if (e?.kind == "quota") {
                    status = 429
                    type = "rate_limit_error"
                    pool.markCooling(mgrNow.tokenData.email, 10 * 1000L)
                }
                if (!result.reason.isNullOrEmpty() && e?.kind != "bad_request") res.setHeader("X-Gateway-Failure-Reason", result.reason)
                if (isOaiChat) {
                    sendJson(res, status, JSONObject().put("error", JSONObject().put("message", errDetail).put("type", type).put("code", status)))
                } else {
                    // Anthropic 错误类型里没有 upstream_error，统一用 api_error
                    sendJson(res, status, JSONObject().put("type", "error").put("error", JSONObject()
                        .put("type", if (type == "upstream_error") "api_error" else type).put("message", errDetail)))
                }
                stats.recordRequest(withDg(JSONObject()
                    .put("email", mgrNow.tokenData.email)
                    .put("model", reqModel)
                    .put("latency_ms", System.currentTimeMillis() - startTime)
                    .put("status", status)
                    .put("error", errDetail.take(100))
                    .put("timing", timingOut())))
                statsRecorded = true
                return
            }
            val response = result.response ?: throw IOException("上游没有返回响应")

            if (isStreaming) {
                val onFinish: (JSONObject) -> Unit = { usage ->
                    val outcome = usage.optString("outcome")
                    val status = if (outcome == "ok") 200 else if (outcome == "client_abort") 499 else 502
                    stats.recordRequest(withDg(JSONObject()
                        .put("email", mgrNow.tokenData.email)
                        .put("model", reqModel)
                        .put("latency_ms", System.currentTimeMillis() - startTime)
                        .put("ttft_ms", usage.opt("ttft_ms"))
                        .put("status", status)
                        .put("is_stream", true)
                        .put("input_tokens", usage.opt("input_tokens"))
                        .put("output_tokens", usage.opt("output_tokens"))
                        .put("cached_tokens", usage.opt("cached_tokens"))
                        .put("thoughts_tokens", usage.opt("thoughts_tokens"))
                        .put("error", usage.opt("error").takeIf { JsCompat.truthy(it) } ?: JSONObject.NULL)
                        .put("timing", timingOut(JSONObject()
                            .put("t_first_thought", usage.opt("t_first_thought") ?: JSONObject.NULL)
                            .put("t_first_text", usage.opt("t_first_text") ?: JSONObject.NULL)))))
                }
                statsRecorded = true
                try {
                    if (isOaiChat) {
                        val includeUsage = rawParsed.optJSONObject("stream_options")?.opt("include_usage") == true
                        OpenaiAgConverter.handleOpenAIStreamConversion(response, res, modelUsed, onFinish, startTime, notice, includeUsage)
                    } else {
                        SseStreamer.handleStreamConversion(response, res, modelUsed, onFinish, startTime, notice)
                    }
                } finally {
                    // [P3] 转换器在拿到 lines 之前抛错时也要释放上游连接（close 幂等）
                    try { response.close() } catch (_: Throwable) {}
                }
            } else {
                val text = try { response.body?.string() ?: "" } finally { response.close() }
                val googleData = JsCompat.parse(text) as? JSONObject ?: throw IOException("上游返回的不是 JSON 对象")
                val out: JSONObject
                if (isOaiChat) {
                    out = OpenaiAgConverter.convertGoogleToOpenAI(googleData, modelUsed)
                    val m = out.optJSONArray("choices")?.optJSONObject(0)?.optJSONObject("message")
                    if (notice != null && m != null) {
                        val cur = m.opt("content")
                        m.put("content", if (JsCompat.truthy(cur)) notice + cur.toString() else notice)
                    }
                } else {
                    out = ContentConverter.convertGoogleToAnthropic(googleData, modelUsed)
                    if (notice != null) {
                        val content = out.optJSONArray("content")
                        if (content != null) {
                            for (i in 0 until content.length()) {
                                val b = content.optJSONObject(i) ?: continue
                                if (b.opt("type") == "text") { b.put("text", notice + str(b, "text")); break }
                            }
                        }
                    }
                }
                sendJson(res, 200, out)
                val u = Usage.gwUsage(out) ?: JSONObject()
                stats.recordRequest(withDg(JSONObject()
                    .put("email", mgrNow.tokenData.email)
                    .put("model", reqModel)
                    .put("latency_ms", System.currentTimeMillis() - startTime)
                    .put("status", 200)
                    .put("is_stream", false)
                    .put("input_tokens", u.optLong("input_tokens", 0))
                    .put("output_tokens", u.optLong("output_tokens", 0))
                    .put("cached_tokens", u.optLong("cached_tokens", 0))
                    .put("thoughts_tokens", u.optLong("thoughts_tokens", 0))
                    .put("timing", timingOut())))
                statsRecorded = true
            }
        } catch (err: Throwable) {
            Log.e(TAG, Redact.redact("[Inference Handler Error] $err"))
            if (!statsRecorded && statsEmail != null) {
                stats.recordRequest(JSONObject()
                    .put("email", statsEmail)
                    .put("model", statsModel ?: JSONObject.NULL)
                    .put("latency_ms", System.currentTimeMillis() - startTime)
                    .put("status", 500)
                    .put("error", (err.message ?: err.toString()).take(100))
                    .put("timing", timingOut()))
            }
            if (!res.headersSent) {
                val msg = err.message ?: err.toString()
                if (isOaiChat) sendJson(res, 500, JSONObject().put("error", JSONObject().put("message", msg).put("type", "api_error")))
                else sendJson(res, 500, JSONObject().put("type", "error").put("error", JSONObject().put("type", "api_error").put("message", msg)))
            }
        }
    }
}
