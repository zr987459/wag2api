package com.wag2api.app

import android.content.Context
import org.json.JSONArray
import org.json.JSONObject
import java.io.*
import java.net.InetAddress
import java.net.InetSocketAddress
import java.net.ServerSocket
import java.net.Socket
import java.util.UUID
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
                    client.tcpNoDelay = true // 减少小包网络延迟
                    client.soTimeout = 120000 // 120 秒空闲读超时，适应超长思考模型首字返回
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

    /** 关闭监听：新连接立即被拒，已在处理中的请求（含流式）各自跑完 */
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
                    if (lineLen == 0) return buf.toByteArray() // 遇到空行即头部结束
                    lineLen = 0
                }
                '\r'.code -> {}
                else -> lineLen++
            }
        }
    }

    private fun readRequestBody(input: InputStream, contentLength: Int): String {
        if (contentLength <= 0) return ""
        val buf = ByteArray(contentLength)
        var off = 0
        while (off < contentLength) {
            val n = input.read(buf, off, contentLength - off)
            if (n < 0) throw EOFException("client closed: got $off / $contentLength bytes")
            off += n
        }
        return String(buf, Charsets.UTF_8)
    }

    private fun handleConnection(client: Socket) {
        try {
            // 全连接统一使用一个 BufferedInputStream，严防 Reader 预读吃掉 Body 字节
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
                        "Access-Control-Allow-Methods: GET, POST, OPTIONS, DELETE\r\n" +
                        "Access-Control-Allow-Headers: *\r\n" +
                        "Connection: close\r\n\r\n"
                output.write(preflight.toByteArray(Charsets.US_ASCII))
                output.flush()
                client.close()
                return
            }

            // 读取 Body：使用精确字节数读取，彻底根除多字节中文卡死挂起
            val contentLength = headers["content-length"]?.toIntOrNull() ?: 0
            val body = readRequestBody(input, contentLength)

            // ── 数据面与控制面安全隔离 ──────────────────────
            // 控制面白名单：面板网页、静态资源、管理 API、健康检查
            val isControlPlane = path == "/" ||
                    path == "/index.html" ||
                    path == "/health" ||
                    path.startsWith("/panel/") ||
                    path.startsWith("/m/") ||
                    path.startsWith("/api/") ||   // AG 控制面（推理在 /v1/，不受影响）
                    path == "/ag" || (path.startsWith("/ag/") && !path.contains("/v1/")) ||
                    path.endsWith(".css") ||
                    path.endsWith(".js") ||
                    path.endsWith(".json") ||
                    path.endsWith(".png") ||
                    path.endsWith(".svg") ||
                    path.endsWith(".ico")

            // 网关总开关关闭时：仅放行控制面，数据面外部推理 API (v1/* 等) 安全拦截返回 503
            if (!GatewayService.isGatewayEnabled(context) && !isControlPlane) {
                val errJson = JSONObject().apply {
                    put("error", JSONObject().apply {
                        put("message", "WorkBuddy 网关已关闭，请在管理面板开启")
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

            // ── 前门分流：先问 EngineRouter 这条请求归谁 ──────────────
            val decision = EngineRouter.decide(context, engine, path, body)
            when (val d = decision) {
                is EngineRouter.Route.Reject -> {
                    sendJsonResponse(output, d.status, d.payload)
                    output.flush()
                    client.close()
                    return
                }
                is EngineRouter.Route.ToNode -> {
                    EngineRouter.proxyToNode(
                        engine = engine,
                        token = EngineTokenHolder.token,
                        method = method,
                        path = d.path,
                        query = query,
                        headers = headers,
                        body = body,
                        out = output,
                        // 只有推理路径需要剥掉 ag: 前缀，控制台路径不动
                        stripModelPrefix = if (d.path.startsWith("/v1/")) "ag:" else null
                    )
                    output.flush()
                    client.close()
                    return
                }
                is EngineRouter.Route.ToWorkBuddy -> {
                    // wb: 前缀在 WB 分支里剥掉
                    val wbBody = if (d.stripPrefix != null && body.isNotEmpty()) {
                        try {
                            val j = JSONObject(body)
                            val m = j.optString("model", "")
                            if (m.startsWith(d.stripPrefix)) {
                                j.put("model", m.removePrefix(d.stripPrefix))
                            }
                            j.toString()
                        } catch (e: Exception) { body }
                    } else body
                    dispatchWorkBuddy(output, method, path, query, wbBody, headers)
                    output.flush()
                    client.close()
                    return
                }
            }
        } catch (e: Exception) {
            try { client.close() } catch (ignored: Exception) {}
        }
    }

    /** 原 WB 路由表，保持不动 */
    private fun dispatchWorkBuddy(
        output: OutputStream,
        method: String,
        path: String,
        query: String,
        body: String,
        headers: Map<String, String>
    ) {
        when {
            // 1. API: 状态概览
            path == "/panel/api/overview" || path == "/m/api/overview" -> {
                val accounts = AccountVault.getAccounts()
                val healthy = (0 until accounts.length()).count {
                    !accounts.getJSONObject(it).optBoolean("disabled", false)
                }
                val json = JSONObject().apply {
                    put("healthy", healthy)
                    put("total", accounts.length())
                    put("accounts", accounts)
                    put("today_requests", GatewayMetrics.getTodayRequests())
                    put("today_tokens", GatewayMetrics.getTodayTokens())
                    put("auth_required", false)
                    put("version", "1.3.0-android")
                }
                sendJsonResponse(output, 200, json.toString())
            }

            // 1.1 API: 请求日志
            path == "/panel/api/logs" || path == "/m/api/logs" -> {
                val json = JSONObject().apply {
                    put("ok", true)
                    put("logs", GatewayMetrics.getLogsJson())
                    put("today_requests", GatewayMetrics.getTodayRequests())
                    put("today_tokens", GatewayMetrics.getTodayTokens())
                }
                sendJsonResponse(output, 200, json.toString())
            }

            // 1.1b API: 详细统计（与 AG /api/stats 同口径）
            path == "/panel/api/stats" || path == "/m/api/stats" -> {
                sendJsonResponse(output, 200, GatewayMetrics.statsJson().toString())
            }

            path == "/panel/api/stats/reset" || path == "/m/api/stats/reset" -> {
                GatewayMetrics.resetStats()
                sendJsonResponse(output, 200, JSONObject().put("ok", true).toString())
            }

            // 1.2 API: 清空日志
            path == "/panel/api/logs/clear" || path == "/m/api/logs/clear" -> {
                GatewayMetrics.clearLogs()
                sendJsonResponse(output, 200, JSONObject().put("ok", true).toString())
            }

            // 1.3 API: 导出 Token
            path == "/panel/api/tokens/export" || path == "/m/api/tokens/export" -> {
                sendJsonResponse(output, 200, AccountVault.exportTokensJson())
            }

            // 1.4 API: 导入 Token (支持 JWT 或 JSON 格式)
            path == "/panel/api/tokens/import" || path == "/m/api/tokens/import" -> {
                val raw = try { JSONObject(body).optString("raw", body) } catch (e: Exception) { body }
                val (success, msg) = AccountVault.importToken(raw)
                val res = JSONObject().put("ok", success).put("msg", msg)
                sendJsonResponse(output, 200, res.toString())
            }

            // 1.5 API: 删除账号
            path == "/panel/api/accounts/delete" || path == "/m/api/accounts/delete" -> {
                val uid = try { JSONObject(body).optString("uid") } catch (e: Exception) { "" }
                val deleted = if (uid.isNotEmpty()) AccountVault.deleteAccount(uid) else false
                sendJsonResponse(output, 200, JSONObject().put("ok", deleted).toString())
            }

            // 1.6 API: AG 引擎状态
            path == "/panel/api/engine/state" || path == "/m/api/engine/state" -> {
                val enabled = context.getSharedPreferences("wag2api_router", Context.MODE_PRIVATE)
                    .getBoolean("node_enabled", true)
                val json = JSONObject().apply {
                    put("supported", com.wag2api.app.engine.EngineFactory.SUPPORTS_NODE)
                    put("enabled", enabled)
                    put("state", engine.state.name)
                    put("port", engine.port)
                    put("default_engine", EngineRouter.getDefaultEngine(context))
                }
                sendJsonResponse(output, 200, json.toString())
            }

            // 1.7 API: 开关 AG 引擎
            path == "/panel/api/engine/toggle" || path == "/m/api/engine/toggle" -> {
                val on = try { JSONObject(body).optBoolean("enabled", true) } catch (e: Exception) { true }
                context.getSharedPreferences("wag2api_router", Context.MODE_PRIVATE)
                    .edit().putBoolean("node_enabled", on).apply()
                if (on) engine.start() else engine.stop()
                sendJsonResponse(output, 200, JSONObject().put("ok", true).put("enabled", on).toString())
            }

            // 1.8 API: 重启 AG 引擎
            path == "/panel/api/engine/restart" || path == "/m/api/engine/restart" -> {
                Thread {
                    engine.stop()
                    Thread.sleep(1500)
                    engine.start()
                }.start()
                sendJsonResponse(output, 200, JSONObject().put("ok", true).toString())
            }

            // 1.9 API: 切换默认引擎
            path == "/panel/api/engine/default" || path == "/m/api/engine/default" -> {
                val e = try { JSONObject(body).optString("engine", "wb") } catch (ex: Exception) { "wb" }
                EngineRouter.setDefaultEngine(context, if (e == "ag") "ag" else "wb")
                sendJsonResponse(output, 200, JSONObject().put("ok", true).put("engine", e).toString())
            }

            // 1.10 API: 账号池状态（含冷却、最近使用、请求数）
            path == "/panel/api/pool" || path == "/m/api/pool" -> {
                val json = JSONObject().apply {
                    put("ok", true)
                    put("accounts", AccountScheduler.poolStatus())
                    put("selected_uid", AccountScheduler.effectiveSelectedUid(context))
                }
                sendJsonResponse(output, 200, json.toString())
            }

            // 1.11 API: 切换当前账号
            path == "/panel/api/pool/select" || path == "/m/api/pool/select" -> {
                val uid = try { JSONObject(body).optString("uid") } catch (e: Exception) { "" }
                if (uid.isEmpty()) {
                    sendJsonResponse(output, 200, JSONObject().put("ok", false).put("msg", "uid 不能为空").toString())
                } else if (AccountScheduler.isDisabled(uid)) {
                    sendJsonResponse(output, 200, JSONObject().put("ok", false).put("msg", "该账号已暂停，请先启用").toString())
                } else {
                    AccountScheduler.setSelectedUid(context, uid)
                    sendJsonResponse(output, 200, JSONObject().put("ok", true).put("uid", uid).toString())
                }
            }

            // 1.12 API: 清除所有账号冷却
            path == "/panel/api/pool/clear-cooldown" || path == "/m/api/pool/clear-cooldown" -> {
                AccountScheduler.clearAllCooldowns()
                sendJsonResponse(output, 200, JSONObject().put("ok", true).toString())
            }

            // 1.13 API: 启用 / 禁用账号
            path == "/panel/api/pool/toggle" || path == "/m/api/pool/toggle" -> {
                val j = try { JSONObject(body) } catch (e: Exception) { JSONObject() }
                val uid = j.optString("uid")
                val disabled = j.optBoolean("disabled", false)
                if (uid.isNotEmpty()) {
                    AccountVault.setDisabled(uid, disabled)
                    // 暂停的正是手动选中的账号：回到「自动」，避免界面还显示它是「当前」
                    if (disabled && AccountScheduler.getSelectedUid(context) == uid) AccountScheduler.setSelectedUid(context, "")
                }
                sendJsonResponse(output, 200, JSONObject().put("ok", uid.isNotEmpty()).toString())
            }

            // 1.14 API: 手动触发 token 保活刷新
            path == "/panel/api/tokens/refresh" || path == "/m/api/tokens/refresh" -> {
                Thread {
                    try { TokenKeeper.refreshAll() } catch (ignored: Exception) {}
                }.start()
                sendJsonResponse(output, 200, JSONObject().put("ok", true).put("msg", "已在后台刷新").toString())
            }

            // 1.15 API: 读取 / 修改监听端口（保存后热切换前门，不重启 AG 引擎）
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
                    // 先把响应发出去，再由 GatewayService 在后台线程热切换前门
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

            // 1.16 API: 网关总开关（读状态 / 开关）
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

            // 1.17 API: 单个账号导出（含完整 token）
            path == "/panel/api/accounts/export-one" || path == "/m/api/accounts/export-one" -> {
                val uid = try { JSONObject(body).optString("uid") } catch (e: Exception) { "" }
                if (uid.isEmpty()) {
                    sendJsonResponse(output, 200, JSONObject().put("ok", false).put("msg", "uid 不能为空").toString())
                } else {
                    val one = AccountVault.exportOneAccount(uid)
                    if (one == null) {
                        sendJsonResponse(output, 200, JSONObject().put("ok", false).put("msg", "未找到该账号").toString())
                    } else {
                        sendJsonResponse(output, 200, JSONObject().apply {
                            put("ok", true)
                            put("account", one)
                        }.toString())
                    }
                }
            }

            // 1.18 API: 连通性测试（测指定账号能否真正跑通一次请求）
            path == "/panel/api/accounts/test" || path == "/m/api/accounts/test" -> {
                val j = try { JSONObject(body) } catch (e: Exception) { JSONObject() }
                val uid = j.optString("uid", "")
                val model = j.optString("model", "deepseek-v4.1-flash-1017")
                val result = ConnectivityTest.run(context, uid, model)
                sendJsonResponse(output, 200, result.toString())
            }

            // 2. API: 发起授权
            path == "/panel/api/login/start" || path == "/m/api/auth/start" -> {
                val realm = try { JSONObject(body).optString("realm", "global") } catch (e: Exception) { "global" }
                val res = TencentGateway.startLogin(realm)
                sendJsonResponse(output, 200, res.toString())
            }

            // 3. API: 轮询授权
            path == "/panel/api/login/poll" || path == "/m/api/auth/poll" -> {
                val state = query.split("&").find { it.startsWith("state=") }?.substringAfter("state=") ?: ""
                val res = TencentGateway.pollLogin(java.net.URLDecoder.decode(state, "UTF-8"))
                sendJsonResponse(output, 200, res.toString())
            }

            // 4. API: 合并后的模型清单（WB + AG，重名项额外提供 ag:/wb: 前缀版本）
            path == "/v1/models" || path == "/v1/v1/models" -> {
                sendJsonResponse(output, 200, EngineRouter.mergedModels(context).toString())
            }

            // 4.1 API: 仅 WB 的模型清单（旧版兼容）
            path == "/panel/api/models/wb" || path == "/m/api/models/wb" -> {
                val json = JSONObject().apply {
                    put("object", "list")
                    put("data", WbModels.list())
                }
                sendJsonResponse(output, 200, json.toString())
            }

            // 5. API: OpenAI 标准流式与非流式对话 (完整透传 tools、reasoning_content、多模态)
            path == "/v1/chat/completions" || path == "/v1/v1/chat/completions" -> {
                handleOpenAiChat(output, body, headers)
            }

            // 6. API: Anthropic Messages 协议全功能支持（双向映射 tools 与 thinking）
            path == "/v1/messages" || path == "/v1/v1/messages" -> {
                handleAnthropicMessages(output, body, headers)
            }

            // 7. 静态前端资源
            else -> {
                serveStaticAsset(output, path)
            }
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

    private fun writeChunk(output: OutputStream, chunkStr: String) {
        val bytes = chunkStr.toByteArray(Charsets.UTF_8)
        val hex = Integer.toHexString(bytes.size)
        output.write("$hex\r\n".toByteArray(Charsets.US_ASCII))
        output.write(bytes)
        output.write("\r\n".toByteArray(Charsets.US_ASCII))
        output.flush()
    }

    private fun endChunked(output: OutputStream) {
        output.write("0\r\n\r\n".toByteArray(Charsets.US_ASCII))
        output.flush()
    }

    private fun errorPayload(e: Exception): Pair<Int, JSONObject> {
        val (status, type) = when {
            e is UpstreamException && e.code == 11128 -> 403 to "upstream_channel_rejected"
            e is UpstreamException && e.status == 403 -> 403 to "upstream_forbidden"
            // 限流：映射成客户端能识别的可重试类型（Anthropic 标准 overloaded_error）
            e is UpstreamException && (e.status == 429 || e.code == 14003) ->
                529 to "overloaded_error"
            e is UpstreamException -> 502 to "upstream_error"
            else -> 500 to "gateway_error"
        }
        val msg = if (type == "overloaded_error") {
            "上游模型繁忙，请稍后重试（已自动尝试切换账号）"
        } else {
            e.message ?: type
        }
        val err = JSONObject().put("message", msg).put("type", type)
        if (e is UpstreamException) err.put("code", e.code ?: e.status)
        return status to JSONObject().put("type", "error").put("error", err)
    }

    private fun handleOpenAiChat(output: OutputStream, bodyStr: String, reqHeaders: Map<String, String>) {
        val startTime = System.currentTimeMillis()
        var model = "deepseek-v4.1-flash-1017"
        try {
            val json = JSONObject(bodyStr)
            val isStream = json.optBoolean("stream", false)
            model = json.optString("model", "deepseek-v4.1-flash-1017")
            val convId = ConversationIds.resolve(reqHeaders, json)
            val used = UsedAccount()

            if (!isStream) {
                // 非流式响应：上游透传，完整包含 reasoning_content 与 tool_calls
                try {
                    val res = TencentGateway.chatSync(json, convId, used)
                    val reply = res.optString("content")
                    val reasoning = res.optString("reasoning_content")
                    val toolCalls = res.optJSONArray("tool_calls")
                    val promptTokens = res.optInt("prompt_tokens", 20)
                    val compTokens = res.optInt("completion_tokens", 20)
                    val totalTokens = promptTokens + compTokens

                    val oaiResp = JSONObject().apply {
                        put("id", "chatcmpl_${System.currentTimeMillis()}")
                        put("object", "chat.completion")
                        put("created", System.currentTimeMillis() / 1000)
                        put("model", model)
                        put("choices", JSONArray().apply {
                            put(JSONObject().apply {
                                put("index", 0)
                                put("message", JSONObject().apply {
                                    put("role", "assistant")
                                    put("content", reply)
                                    if (reasoning.isNotEmpty()) {
                                        put("reasoning_content", reasoning)
                                    }
                                    if (toolCalls != null) {
                                        put("tool_calls", toolCalls)
                                    }
                                })
                                put("finish_reason", if (toolCalls != null) "tool_calls" else "stop")
                            })
                        })
                        put("usage", JSONObject().apply {
                            put("prompt_tokens", promptTokens)
                            put("completion_tokens", compTokens)
                            put("total_tokens", totalTokens)
                        })
                    }
                    finishWb("/v1/chat/completions", model, "sync", 200, syncUsage(res), System.currentTimeMillis() - startTime, null, null, used)
                    sendJsonResponse(output, 200, oaiResp.toString())
                } catch (e: Exception) {
                    val (st, body) = errorPayload(e)
                    finishWb("/v1/chat/completions", model, "sync", st, null, System.currentTimeMillis() - startTime, null, e.message, used)
                    sendJsonResponse(output, st, body.toString())
                }
            } else {
                // 流式 Chunked 传输：按字节原样转发 SSE 帧，上游 reasoning_content 与 tool_calls 天然完整送达
                val sseHeader = "HTTP/1.1 200 OK\r\n" +
                        "Content-Type: text/event-stream; charset=utf-8\r\n" +
                        "Cache-Control: no-cache, no-transform\r\n" +
                        "X-Accel-Buffering: no\r\n" +
                        "Transfer-Encoding: chunked\r\n" +
                        "Access-Control-Allow-Origin: *\r\n" +
                        "Connection: keep-alive\r\n\r\n"
                output.write(sseHeader.toByteArray(Charsets.US_ASCII))
                output.flush()

                var streamUsage: JSONObject? = null
                var ttft: Long? = null
                try {
                    TencentGateway.streamChat(json, convId, used) { line ->
                        try {
                            if (line.startsWith("data: ")) {
                                val s = line.substring(6).trim()
                                if (s.startsWith("{") && s != "[DONE]") {
                                    val c = JSONObject(s)
                                    c.optJSONObject("usage")?.let { streamUsage = it }
                                    if (ttft == null && hasDelta(c)) ttft = System.currentTimeMillis() - startTime
                                }
                            }
                            writeChunk(output, line)
                            true
                        } catch (e: Exception) {
                            false
                        }
                    }
                    finishWb("/v1/chat/completions", model, "stream", 200,
                        GatewayMetrics.Usage.fromOpenAi(streamUsage), System.currentTimeMillis() - startTime, ttft, null, used)
                } catch (e: Exception) {
                    val (st, payload) = errorPayload(e)
                    finishWb("/v1/chat/completions", model, "stream", st, null, System.currentTimeMillis() - startTime, null, e.message, used)
                    writeChunk(output, "data: $payload\n\n")
                    writeChunk(output, "data: [DONE]\n\n")
                } finally {
                    endChunked(output)
                }
            }
        } catch (e: Exception) {
            val (st, body) = errorPayload(e)
            GatewayMetrics.record("POST", "/v1/chat/completions", model, "error", st, 0, System.currentTimeMillis() - startTime, e.message)
            sendJsonResponse(output, st, body.toString())
        }
    }

    private fun handleAnthropicMessages(output: OutputStream, bodyStr: String, reqHeaders: Map<String, String>) {
        val startTime = System.currentTimeMillis()
        var modelRaw = "deepseek-v4.1-flash-1017"
        try {
            val json = JSONObject(bodyStr)
            val isStream = json.optBoolean("stream", false)
            modelRaw = json.optString("model", "deepseek-v4.1-flash-1017")

            // 采用 Hark 工业级转换器：完美解决 tool_use / tool_result 配对、图片、多轮会话锚点
            val convId = ConversationIds.resolve(reqHeaders, json)
            val oaiReq = AnthropicToOpenAI.convertRequest(json)
            val used = UsedAccount()

            if (!isStream) {
                // 1. 非流式响应
                try {
                    val oaiResp = TencentGateway.chatSync(oaiReq, convId, used)
                    // chatSync 返回扁平结构（content / tool_calls / prompt_tokens），先补成 OpenAI 响应再转换
                    val anthropicResp = AnthropicToOpenAI.convertResponse(toOpenAiResponse(oaiResp), modelRaw)
                    val reasoning = oaiResp.optString("reasoning_content", "")
                    if (reasoning.isNotEmpty()) {
                        val old = anthropicResp.getJSONArray("content")
                        val withThinking = JSONArray().put(JSONObject()
                            .put("type", "thinking").put("thinking", reasoning).put("signature", ""))
                        for (k in 0 until old.length()) withThinking.put(old.get(k))
                        anthropicResp.put("content", withThinking)
                    }
                    finishWb("/v1/messages", modelRaw, "sync", 200, syncUsage(oaiResp), System.currentTimeMillis() - startTime, null, null, used)
                    sendJsonResponse(output, 200, anthropicResp.toString())
                } catch (e: Exception) {
                    val (st, body) = errorPayload(e)
                    finishWb("/v1/messages", modelRaw, "sync", st, null, System.currentTimeMillis() - startTime, null, e.message, used)
                    sendJsonResponse(output, st, body.toString())
                }
            } else {
                // 2. 流式响应 (支持 thinking 与 tool_use 事件)
                val sseHeader = "HTTP/1.1 200 OK\r\n" +
                        "Content-Type: text/event-stream; charset=utf-8\r\n" +
                        "Cache-Control: no-cache, no-transform\r\n" +
                        "X-Accel-Buffering: no\r\n" +
                        "Transfer-Encoding: chunked\r\n" +
                        "Access-Control-Allow-Origin: *\r\n" +
                        "Connection: keep-alive\r\n\r\n"
                output.write(sseHeader.toByteArray(Charsets.US_ASCII))
                output.flush()

                val translator = AnthropicStreamTranslator(modelRaw) { event, data ->
                    writeChunk(output, "event: $event\ndata: $data\n\n")
                }

                var streamUsage: JSONObject? = null
                var ttft: Long? = null
                try {
                    TencentGateway.streamChat(oaiReq, convId, used) { line ->
                        val trimmed = line.trim()
                        if (trimmed.startsWith("data: ") && trimmed != "data: [DONE]") {
                            try {
                                val chunk = JSONObject(trimmed.substring(6))
                                chunk.optJSONObject("usage")?.let { streamUsage = it }
                                if (ttft == null && hasDelta(chunk)) ttft = System.currentTimeMillis() - startTime
                                translator.onChunk(chunk)
                            } catch (ignored: Exception) {}
                        }
                        true
                    }
                    translator.finish()
                    finishWb("/v1/messages", modelRaw, "stream", 200,
                        GatewayMetrics.Usage.fromOpenAi(streamUsage), System.currentTimeMillis() - startTime, ttft, null, used)
                } catch (e: Exception) {
                    val (st, body) = errorPayload(e)
                    finishWb("/v1/messages", modelRaw, "stream", st, null, System.currentTimeMillis() - startTime, null, e.message, used)
                    try {
                        translator.abort(body)
                    } catch (ignored: Exception) {}
                } finally {
                    endChunked(output)
                }
            }
        } catch (e: Exception) {
            val (st, body) = errorPayload(e)
            GatewayMetrics.record("POST", "/v1/messages", modelRaw, "error", st, 0, System.currentTimeMillis() - startTime, e.message)
            sendJsonResponse(output, st, body.toString())
        }
    }

    /**
     * 一次 WB 请求结束：写日志 / 统计（带上最终账号），并给该账号累加请求数与 Token。
     * used 由 TencentGateway 在每次选号时覆盖，重试换号只记在最后一个账号上。与 src/wb/index.mjs finish 一致。
     */
    private fun finishWb(
        path: String, model: String, endpoint: String, status: Int,
        usage: GatewayMetrics.Usage?, latencyMs: Long, ttftMs: Long?, note: String?, used: UsedAccount
    ) {
        GatewayMetrics.record("POST", path, model, endpoint, status, usage, latencyMs, ttftMs, note, used.uid, used.nickname)
        if (used.uid.isNotEmpty()) {
            try { AccountScheduler.recordUsage(used.uid, (usage?.total ?: 0).toLong()) } catch (ignored: Exception) {}
        }
    }

    /** chatSync 的扁平结果 → OpenAI chat.completion 形状（convertResponse 需要 choices / usage） */
    private fun toOpenAiResponse(res: JSONObject): JSONObject {
        val toolCalls = res.optJSONArray("tool_calls")
        val message = JSONObject().put("role", "assistant").put("content", res.optString("content"))
        if (toolCalls != null) message.put("tool_calls", toolCalls)
        return JSONObject()
            .put("choices", JSONArray().put(JSONObject()
                .put("index", 0)
                .put("message", message)
                .put("finish_reason", if (toolCalls != null) "tool_calls" else "stop")))
            .put("usage", JSONObject()
                .put("prompt_tokens", res.optInt("prompt_tokens", 0))
                .put("completion_tokens", res.optInt("completion_tokens", 0)))
    }

    /** chatSync 结果里的用量：优先上游原始 usage，否则用扁平的 prompt/completion */
    private fun syncUsage(res: JSONObject): GatewayMetrics.Usage? =
        GatewayMetrics.Usage.fromOpenAi(res.optJSONObject("usage"))
            ?: GatewayMetrics.Usage.fromOpenAi(JSONObject()
                .put("prompt_tokens", res.optInt("prompt_tokens", 0))
                .put("completion_tokens", res.optInt("completion_tokens", 0)))

    /** 流式块里是否已有正文 / 思考 / 工具调用（用于首字耗时） */
    private fun hasDelta(c: JSONObject): Boolean {
        val d = c.optJSONArray("choices")?.optJSONObject(0)?.optJSONObject("delta") ?: return false
        return d.optString("content", "").isNotEmpty() ||
            d.optString("reasoning_content", "").isNotEmpty() ||
            d.has("tool_calls")
    }

    private fun sendErrorJson(output: OutputStream, code: Int, msg: String) {
        val json = JSONObject().apply { put("error", JSONObject().apply { put("message", msg) }) }
        val bytes = json.toString().toByteArray(Charsets.UTF_8)
        val header = "HTTP/1.1 $code Error\r\n" +
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
