package com.wag2api.app

import android.content.Context
import org.json.JSONArray
import org.json.JSONObject
import java.io.*
import java.net.InetAddress
import java.net.InetSocketAddress
import java.net.ServerSocket
import java.net.Socket
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import java.util.TimeZone
import kotlin.concurrent.thread

class LocalGatewayServer(
    private val context: Context,
    private val port: Int = 8800,
    private val engine: com.wag2api.app.engine.NodeEngineApi,
    private val onBusy: () -> Unit = {},
    private val onIdle: () -> Unit = {}
) {

    private var serverSocket: ServerSocket? = null
    @Volatile private var isRunning = false

    /** 本实例监听的端口（热切换时 GatewayService 用它判断新旧） */
    val listenPort: Int get() = port

    /** 是否已成功绑定并在接受连接 */
    val isListening: Boolean get() = isRunning && serverSocket?.isClosed == false

    /** 异步启动（服务 onCreate 用，不在主线程做 bind） */
    fun start() {
        if (isRunning) return
        thread(name = "LocalGatewayServer-boot") { startBlocking() }
    }

    /**
     * 同步绑定 127.0.0.1:port，成功后在后台线程接受连接。
     * @return 是否绑定成功（端口被占用等返回 false），热切换端口时据此决定是否回退
     */
    fun startBlocking(): Boolean {
        val ss: ServerSocket
        synchronized(this) {
            if (isRunning) return serverSocket?.isClosed == false
            ss = try {
                ServerSocket().apply {
                    reuseAddress = true
                    bind(InetSocketAddress(InetAddress.getByName("127.0.0.1"), port), 50)
                }
            } catch (e: Exception) {
                return false
            }
            serverSocket = ss
            isRunning = true
        }
        thread(name = "LocalGatewayServer:$port") {
            try {
                while (isRunning) {
                    val client = ss.accept()
                    client.tcpNoDelay = true
                    client.soTimeout = 120000
                    thread {
                        onBusy()
                        try {
                            client.use { handleConnection(it) }
                        } finally {
                            onIdle()
                        }
                    }
                }
            } catch (e: Exception) {
                // server closed
            }
        }
        return true
    }

    /** 关闭监听 */
    fun stop() {
        synchronized(this) {
            isRunning = false
            try {
                serverSocket?.close()
            } catch (ignored: Exception) {}
        }
    }

    private fun readHeaderBlock(input: InputStream, max: Int = 64 * 1024): ByteArray? {
        val buf = ByteArrayOutputStream(512)
        var lineLen = 0
        while (true) {
            val b = input.read()
            if (b == -1) return if (buf.size() == 0) null else throw EOFException("headers truncated")
            if (buf.size() >= max) throw IOException("request header too large")
            buf.write(b)
            when (b) {
                '\n'.code -> {
                    if (lineLen == 0) return buf.toByteArray()
                    lineLen = 0
                }
                '\r'.code -> {}
                else -> lineLen++
            }
        }
    }

    /** [P3] 请求体过大 */
    private class BodyTooLarge : IOException("request body too large")

    /** [P3] 支持 Transfer-Encoding: chunked（部分 SDK / curl --data-binary @- 会这样发）；总长度有上限 */
    private fun readChunkedBody(input: InputStream): String {
        val out = ByteArrayOutputStream()
        fun line(): String? {
            val b = ByteArrayOutputStream(16)
            while (true) {
                val c = input.read()
                if (c < 0) return if (b.size() == 0) null else b.toString("ISO-8859-1")
                if (c == '\n'.code) break
                if (c != '\r'.code) b.write(c)
                if (b.size() > 8192) throw IOException("chunk line too long")
            }
            return b.toString("ISO-8859-1")
        }
        while (true) {
            val sizeLine = line() ?: break
            val size = sizeLine.substringBefore(';').trim().toIntOrNull(16) ?: throw IOException("bad chunk size")
            if (size == 0) { while (true) { val t = line() ?: break; if (t.isEmpty()) break }; break }
            if (size < 0 || out.size().toLong() + size > com.wag2api.ag.AgServer.MAX_BODY_BYTES) throw BodyTooLarge()
            val buf = ByteArray(size)
            var off = 0
            while (off < size) {
                val n = input.read(buf, off, size - off)
                if (n < 0) throw EOFException("client closed in chunk")
                off += n
            }
            out.write(buf)
            line()
        }
        return out.toString("UTF-8")
    }

    /** [P3] 管理密钥开启时校验；不通过就回 401 并返回 true */
    private fun denyIfNotAdmin(output: OutputStream, headers: Map<String, String>, target: String, dataPlane: Boolean): Boolean {
        if (com.wag2api.ag.AgServer.frontDoorAllows(context, headers, target)) return false
        val body = if (dataPlane) JSONObject().put("type", "error").put("error", JSONObject()
            .put("type", "authentication_error").put("message", "API Key 无效或缺失 (x-api-key)"))
        else JSONObject().put("ok", false).put("need_admin", true).put("error", "需要管理密钥")
        sendJsonResponse(output, 401, body.toString())
        return true
    }

    private fun readRequestBody(input: InputStream, contentLength: Int): String {
        if (contentLength <= 0) return ""
        if (contentLength.toLong() > com.wag2api.ag.AgServer.MAX_BODY_BYTES) throw BodyTooLarge()
        val buf = ByteArray(contentLength)
        var off = 0
        while (off < contentLength) {
            val n = input.read(buf, off, contentLength - off)
            if (n < 0) throw EOFException("client closed: got $off / $contentLength bytes")
            off += n
        }
        return String(buf, Charsets.UTF_8)
    }

    private fun isStaticPath(path: String): Boolean {
        return path == "/" ||
                path.isEmpty() ||
                path == "/index.html" ||
                path == "/m" ||
                path == "/m/" ||
                (path.startsWith("/m/") && !path.startsWith("/m/api/")) ||
                path.endsWith(".html") ||
                path.endsWith(".css") ||
                path.endsWith(".js") ||
                path.endsWith(".json") ||
                path.endsWith(".png") ||
                path.endsWith(".svg") ||
                path.endsWith(".ico")
    }

    private fun handleConnection(client: Socket) {
        try {
            val input = BufferedInputStream(client.getInputStream())
            val output = client.getOutputStream()

            val rawHead = readHeaderBlock(input) ?: return client.close()
            val headLines = String(rawHead, Charsets.ISO_8859_1).split('\n')
                .map { it.removeSuffix("\r") }.filter { it.isNotEmpty() }
            if (headLines.isEmpty()) return client.close()

            val parts = headLines[0].split(' ')
            if (parts.size < 2) return client.close()

            val method = parts[0].uppercase()
            val fullPath = parts[1]
            val path = fullPath.substringBefore("?")
            val query = fullPath.substringAfter("?", "")

            // 解析 Headers (小写标准化)
            val headers = HashMap<String, String>()
            for (l in headLines.drop(1)) {
                val i = l.indexOf(':')
                if (i <= 0) continue
                val k = l.substring(0, i).trim().lowercase()
                val v = l.substring(i + 1).trim()
                headers[k] = headers[k]?.let { "$it, $v" } ?: v
            }

            // 处理 OPTIONS 预检请求
            if (method == "OPTIONS") {
                val preflight = "HTTP/1.1 204 No Content\r\n" +
                        "Access-Control-Allow-Origin: *\r\n" +
                        "Access-Control-Allow-Methods: GET, POST, PUT, PATCH, DELETE, OPTIONS\r\n" +
                        "Access-Control-Allow-Headers: *\r\n" +
                        "Connection: close\r\n\r\n"
                output.write(preflight.toByteArray(Charsets.US_ASCII))
                output.flush()
                client.close()
                return
            }

            // 读取 Body
            val chunked = headers["transfer-encoding"]?.contains("chunked", ignoreCase = true) == true
            val contentLength = headers["content-length"]?.trim()?.toLongOrNull()?.let { if (it > Int.MAX_VALUE) Int.MAX_VALUE else it.toInt() } ?: 0
            val body = try {
                if (chunked) readChunkedBody(input) else readRequestBody(input, contentLength)
            } catch (e: BodyTooLarge) {
                sendJsonResponse(output, 413, JSONObject().put("error", JSONObject()
                    .put("message", "请求体超过 ${com.wag2api.ag.AgServer.MAX_BODY_BYTES / 1024 / 1024}MB 上限").put("type", "invalid_request_error")).toString())
                client.close()
                return
            }

            // ── 数据面与控制面安全隔离 ──────────────────────
            val isControlPlane = path == "/" ||
                    path.isEmpty() ||
                    path == "/index.html" ||
                    path == "/health" ||
                    path == "/ais/logs" ||
                    path.startsWith("/panel/") ||
                    path.startsWith("/m/") ||
                    path.startsWith("/api/") ||
                    path.startsWith("/ais/api/") || path == "/ais/api" ||
                    path.startsWith("/ais-local/") ||
                    path == "/ag" || (path.startsWith("/ag/") && !path.contains("/v1/")) ||
                    path.endsWith(".css") ||
                    path.endsWith(".js") ||
                    path.endsWith(".json") ||
                    path.endsWith(".png") ||
                    path.endsWith(".svg") ||
                    path.endsWith(".ico")

            if (!GatewayService.isGatewayEnabled(context) && !isControlPlane) {
                val errJson = JSONObject().apply {
                    put("error", JSONObject().apply {
                        put("message", "wag2api 网关已关闭，请在管理面板开启")
                        put("type", "gateway_disabled")
                        put("code", "gateway_disabled")
                    })
                }.toString()
                val bytes = errJson.toByteArray(Charsets.UTF_8)
                val respHead = "HTTP/1.1 503 Service Unavailable\r\n" +
                        "Content-Type: application/json; charset=utf-8\r\n" +
                        "Content-Length: ${bytes.size}\r\n" +
                        "Retry-After: 30\r\n" +
                        "Access-Control-Allow-Origin: *\r\n" +
                        "Connection: close\r\n\r\n"
                output.write(respHead.toByteArray(Charsets.US_ASCII))
                output.write(bytes)
                output.flush()
                client.close()
                return
            }

            // 1. 静态资源
            if (isStaticPath(path)) {
                serveStaticAsset(output, path)
                output.flush()
                client.close()
                return
            }

            // 2. 健康检查
            if (path == "/health") {
                val h = JSONObject().apply {
                    put("status", "ok")
                    put("ais", AisEngine.isRunning())
                    put("ag", engine.state.name)
                }
                sendJsonResponse(output, 200, h.toString())
                output.flush()
                client.close()
                return
            }

            // 3. 合并后的模型列表
            if (path == "/v1/models" || path == "/v1/v1/models") {
                sendJsonResponse(output, 200, EngineRouter.mergedModels(context).toString())
                output.flush()
                client.close()
                return
            }

            // 4. AIS 日志
            if (path == "/ais/logs") {
                if (denyIfNotAdmin(output, headers, fullPath, dataPlane = false)) { client.close(); return }
                val logs = AisEngine.getLogs()
                val json = JSONObject().apply {
                    put("ok", true)
                    put("logs", JSONArray(logs))
                }
                sendJsonResponse(output, 200, json.toString())
                output.flush()
                client.close()
                return
            }

            // 5. 面板 API
            if (path.startsWith("/panel/api/") || path.startsWith("/m/api/") || path == "/panel/api/status") {
                dispatchPanelApi(output, method, path, query, body)
                output.flush()
                client.close()
                return
            }

            // 5.5 AIS 本地账号导出（含 storage-state.json Cookie）
            if (path == "/ais-local/export") {
                // [P3] 这里导出的是 AIS 账号 Cookie，以前不校验管理密钥，同机任何 App 都能读走
                if (denyIfNotAdmin(output, headers, fullPath, dataPlane = false)) { client.close(); return }
                if (method != "GET") {
                    val err = JSONObject().put(
                        "error",
                        JSONObject().put("message", "Method Not Allowed")
                    ).toString()
                    sendJsonResponse(output, 405, err)
                } else {
                    try {
                        val exported = exportAisAccounts()
                        sendJsonResponse(output, 200, exported.toString())
                    } catch (e: Exception) {
                        val err = JSONObject().put(
                            "error",
                            JSONObject().put("message", e.message ?: "导出 AIS 账号失败")
                        ).toString()
                        sendJsonResponse(output, 500, err)
                    }
                }
                output.flush()
                client.close()
                return
            }

            // 6. AIS API 透传：/ais/api/* -> AIS /api/*
            if (path.startsWith("/ais/api/") || path == "/ais/api") {
                if (denyIfNotAdmin(output, headers, fullPath, dataPlane = false)) { client.close(); return }
                val targetPath = path.removePrefix("/ais")
                EngineRouter.proxyToAis(
                    method = method,
                    path = targetPath,
                    query = query,
                    headers = headers,
                    body = body,
                    out = output
                )
                output.flush()
                client.close()
                return
            }

            // 7. 路由判断（Node 或 AIS）
            val decision = EngineRouter.decide(context, engine, path, body)
            when (decision) {
                is EngineRouter.Route.Reject -> {
                    sendJsonResponse(output, decision.status, decision.payload)
                    output.flush()
                    client.close()
                    return
                }
                is EngineRouter.Route.ToNode -> {
                    EngineRouter.proxyToNode(
                        engine = engine,
                        token = EngineTokenHolder.token,
                        method = method,
                        path = decision.path,
                        query = query,
                        headers = headers,
                        body = body,
                        out = output,
                        stripModelPrefix = if (decision.path.startsWith("/v1/")) "ag:" else null
                    )
                    output.flush()
                    client.close()
                    return
                }
                is EngineRouter.Route.ToAis -> {
                    // [P3] AIS 推理与 AG 一样受管理密钥保护（AG 引擎内部会校验，AIS 以前不校验）
                    if (denyIfNotAdmin(output, headers, fullPath, dataPlane = !decision.path.startsWith("/api/"))) { client.close(); return }
                    EngineRouter.proxyToAis(
                        method = method,
                        path = decision.path,
                        query = query,
                        headers = headers,
                        body = body,
                        out = output,
                        stripModelPrefix = decision.stripPrefix
                    )
                    output.flush()
                    client.close()
                    return
                }
            }
        } catch (e: Exception) {
            try { client.close() } catch (ignored: Exception) {}
        }
    }

    private fun dispatchPanelApi(
        output: OutputStream,
        method: String,
        path: String,
        query: String,
        body: String
    ) {
        when {
            // 状态概览
            path == "/panel/api/overview" || path == "/m/api/overview" -> {
                val json = JSONObject().apply {
                    put("healthy", if (AisEngine.isRunning()) 1 else 0)
                    put("total", if (AisEngine.isAvailable(context)) 1 else 0)
                    put("accounts", JSONArray())
                    put("today_requests", GatewayMetrics.getTodayRequests())
                    put("today_tokens", GatewayMetrics.getTodayTokens())
                    put("auth_required", false)
                    put("version", "1.3.0-android")
                    put("ais", JSONObject().apply {
                        put("available", AisEngine.isAvailable(context))
                        put("running", AisEngine.isRunning())
                        put("base_url", AisEngine.baseUrl)
                    })
                }
                sendJsonResponse(output, 200, json.toString())
            }

            // 请求日志
            path == "/panel/api/logs" || path == "/m/api/logs" -> {
                val json = JSONObject().apply {
                    put("ok", true)
                    put("logs", GatewayMetrics.getLogsJson())
                    put("today_requests", GatewayMetrics.getTodayRequests())
                    put("today_tokens", GatewayMetrics.getTodayTokens())
                }
                sendJsonResponse(output, 200, json.toString())
            }

            path == "/panel/api/stats" || path == "/m/api/stats" -> {
                sendJsonResponse(output, 200, GatewayMetrics.statsJson().toString())
            }

            path == "/panel/api/stats/reset" || path == "/m/api/stats/reset" -> {
                GatewayMetrics.resetStats()
                sendJsonResponse(output, 200, JSONObject().put("ok", true).toString())
            }

            path == "/panel/api/logs/clear" || path == "/m/api/logs/clear" -> {
                GatewayMetrics.clearLogs()
                sendJsonResponse(output, 200, JSONObject().put("ok", true).toString())
            }

            // 引擎状态
            path == "/panel/api/engine/state" || path == "/m/api/engine/state" || path == "/panel/api/status" -> {
                val enabled = context.getSharedPreferences("wag2api_router", Context.MODE_PRIVATE)
                    .getBoolean("node_enabled", true)
                val json = JSONObject().apply {
                    put("supported", com.wag2api.app.engine.EngineFactory.SUPPORTS_NODE)
                    put("enabled", enabled)
                    put("state", engine.state.name)
                    put("port", engine.port)
                    put("default_engine", EngineRouter.getDefaultEngine(context))
                    put("ais", JSONObject().apply {
                        put("available", AisEngine.isAvailable(context))
                        put("running", AisEngine.isRunning())
                        put("base_url", AisEngine.baseUrl)
                    })
                }
                sendJsonResponse(output, 200, json.toString())
            }

            // 开关 AG 引擎
            path == "/panel/api/engine/toggle" || path == "/m/api/engine/toggle" -> {
                val on = try { JSONObject(body).optBoolean("enabled", true) } catch (e: Exception) { true }
                context.getSharedPreferences("wag2api_router", Context.MODE_PRIVATE)
                    .edit().putBoolean("node_enabled", on).apply()
                if (on) engine.start() else engine.stop()
                sendJsonResponse(output, 200, JSONObject().put("ok", true).put("enabled", on).toString())
            }

            // 重启 AG 引擎
            path == "/panel/api/engine/restart" || path == "/m/api/engine/restart" -> {
                Thread {
                    engine.stop()
                    Thread.sleep(1500)
                    engine.start()
                }.start()
                sendJsonResponse(output, 200, JSONObject().put("ok", true).toString())
            }

            // 切换默认引擎
            path == "/panel/api/engine/default" || path == "/m/api/engine/default" -> {
                val e = try { JSONObject(body).optString("engine", "ais") } catch (ex: Exception) { "ais" }
                val target = if (e == "ag" && com.wag2api.app.engine.EngineFactory.SUPPORTS_NODE) "ag" else "ais"
                EngineRouter.setDefaultEngine(context, target)
                sendJsonResponse(output, 200, JSONObject().put("ok", true).put("engine", target).toString())
            }

            // 读取 / 修改监听端口
            path == "/panel/api/settings/port" || path == "/m/api/settings/port" -> {
                if (method == "POST") {
                    val np = try { JSONObject(body).optInt("port", 0) } catch (e: Exception) { 0 }
                    val current = GatewayService.getPort(context)
                    val res = JSONObject()
                    var switchTo = 0
                    when {
                        np !in 1024..65535 -> res.put("ok", false).put("msg", "端口需在 1024~65535 之间")
                        np == current -> res.put("ok", true).put("new_port", np).put("unchanged", true)
                            .put("msg", "已在使用端口 $np")
                        engine.port > 0 && np == engine.port ->
                            res.put("ok", false).put("msg", "端口 $np 是 AG 引擎内部端口，请换一个")
                        !GatewayService.canBind(np) ->
                            res.put("ok", false).put("msg", "端口 $np 已被占用或无法监听，未保存")
                        else -> {
                            GatewayService.setPort(context, np)
                            res.put("ok", true).put("new_port", np).put("old_port", current)
                                .put("msg", "已切换到端口 $np")
                            switchTo = np
                        }
                    }
                    res.put("port", if (switchTo > 0) switchTo else current)
                    sendJsonResponse(output, 200, res.toString())
                    if (switchTo > 0) GatewayService.switchFrontDoorPort(context, switchTo, current)
                } else {
                    val json = JSONObject().apply {
                        put("ok", true)
                        put("port", GatewayService.getPort(context))
                        put("default_port", GatewayService.DEFAULT_PORT)
                        GatewayService.lastPortSwitchError?.let { put("switch_error", it) }
                    }
                    sendJsonResponse(output, 200, json.toString())
                }
            }

            // 网关总开关
            path == "/panel/api/settings/gateway" || path == "/m/api/settings/gateway" -> {
                if (method == "POST") {
                    val on = try { JSONObject(body).optBoolean("enabled", true) } catch (e: Exception) { true }
                    val now = GatewayService.setGatewayEnabled(context, on)
                    sendJsonResponse(output, 200, JSONObject().apply {
                        put("ok", true)
                        put("enabled", now)
                        put("msg", if (now) "网关已开启" else "网关已关闭")
                    }.toString())
                } else {
                    sendJsonResponse(output, 200, JSONObject().apply {
                        put("ok", true)
                        put("enabled", GatewayService.isGatewayEnabled(context))
                    }.toString())
                }
            }

            // AIS 引擎开关（设置页）：开启立即启动，关闭立即停止并销毁 WebView（账号保留）
            path == "/panel/api/ais/enabled" || path == "/m/api/ais/enabled" -> {
                if (method == "POST") {
                    val on = try { JSONObject(body).optBoolean("enabled", true) } catch (e: Exception) { true }
                    Thread { try { AisEngine.setEnabled(context, on) } catch (ignored: Exception) {} }.start()
                    sendJsonResponse(output, 200, JSONObject().apply {
                        put("ok", true)
                        put("enabled", on)
                        put("running", AisEngine.isRunning())
                    }.toString())
                } else {
                    sendJsonResponse(output, 200, JSONObject().apply {
                        put("ok", true)
                        put("enabled", AisEngine.isEnabledInSettings(context))
                        put("has_accounts", AisEngine.hasAccounts(context))
                        put("running", AisEngine.isRunning())
                        put("available", AisEngine.isAvailable(context))
                    }.toString())
                }
            }

            // 模型清单兼容
            path == "/panel/api/models/wb" || path == "/panel/api/models/ais" ||
            path == "/m/api/models/wb" || path == "/m/api/models/ais" -> {
                val json = JSONObject().apply {
                    put("object", "list")
                    put("data", EngineRouter.getCachedAisModels(context))
                }
                sendJsonResponse(output, 200, json.toString())
            }

            // 旧接口占位响应
            else -> {
                sendJsonResponse(output, 200, JSONObject().put("ok", true).put("accounts", JSONArray()).toString())
            }
        }
    }

    private fun exportAisAccounts(): JSONObject {
        val authDir = File(context.filesDir, "ais/auth")
        val accountsArr = JSONArray()
        if (authDir.isDirectory) {
            val dirs = authDir.listFiles()
                ?.filter { it.isDirectory && !it.name.startsWith(".") }
                ?.sortedBy { it.name }
                ?: emptyList()
            for (dir in dirs) {
                val stateFile = File(dir, "storage-state.json")
                if (!stateFile.isFile) continue
                val storageState = try {
                    JSONObject(stateFile.readText(Charsets.UTF_8))
                } catch (e: Exception) {
                    continue
                }
                val accFile = File(dir, "account.json")
                val accMeta = if (accFile.isFile) {
                    try {
                        JSONObject(accFile.readText(Charsets.UTF_8))
                    } catch (e: Exception) {
                        JSONObject()
                    }
                } else {
                    JSONObject()
                }
                val item = JSONObject().apply {
                    put("email", dir.name)
                    put("label", accMeta.optString("label", ""))
                    put("enabled", accMeta.optBoolean("enabled", true))
                    put("proxy", accMeta.optString("proxy", ""))
                    put("locale", accMeta.optString("locale", ""))
                    put("timezone", accMeta.optString("timezone", ""))
                    if (accMeta.has("auth_user")) {
                        put("auth_user", accMeta.optInt("auth_user", 0))
                    }
                    put("storage_state", storageState)
                }
                accountsArr.put(item)
            }
        }
        val isoNow = SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss.SSS'Z'", Locale.US).apply {
            timeZone = TimeZone.getTimeZone("UTC")
        }.format(Date())
        return JSONObject().apply {
            put("format", "wag2api-ais")
            put("version", 1)
            put("exported_at", isoNow)
            put("accounts", accountsArr)
        }
    }

    private fun sendJsonResponse(output: OutputStream, code: Int, jsonStr: String) {
        val bytes = jsonStr.toByteArray(Charsets.UTF_8)
        val header = "HTTP/1.1 $code OK\r\n" +
                "Content-Type: application/json; charset=utf-8\r\n" +
                "Content-Length: ${bytes.size}\r\n" +
                "Access-Control-Allow-Origin: *\r\n" +
                "Connection: close\r\n\r\n"
        output.write(header.toByteArray(Charsets.US_ASCII))
        output.write(bytes)
        output.flush()
    }

    private fun serveStaticAsset(output: OutputStream, path: String) {
        val cleanPath = when {
            path == "/" || path.isEmpty() || path == "/index.html" -> "web/index.html"
            path.startsWith("/m/") -> "web/" + path.removePrefix("/m/")
            path == "/m" -> "web/index.html"
            else -> "web/" + path.removePrefix("/")
        }

        val mime = when {
            cleanPath.endsWith(".html") -> "text/html; charset=utf-8"
            cleanPath.endsWith(".css") -> "text/css; charset=utf-8"
            cleanPath.endsWith(".js") -> "application/javascript; charset=utf-8"
            cleanPath.endsWith(".json") -> "application/json; charset=utf-8"
            else -> "application/octet-stream"
        }

        val bytes = try {
            context.assets.open(cleanPath).use { it.readBytes() }
        } catch (e: Exception) {
            context.assets.open("web/index.html").use { it.readBytes() }
        }

        val header = "HTTP/1.1 200 OK\r\n" +
                "Content-Type: $mime\r\n" +
                "Content-Length: ${bytes.size}\r\n" +
                "Access-Control-Allow-Origin: *\r\n" +
                "Connection: close\r\n\r\n"
        output.write(header.toByteArray(Charsets.US_ASCII))
        output.write(bytes)
        output.flush()
    }
}
