package com.wag2api.app.ais

import android.content.Context
import android.util.Log
import androidx.webkit.ProfileStore
import androidx.webkit.WebViewCompat
import com.wag2api.ag.AgServer
import com.wag2api.ag.ContentConverter
import com.wag2api.ag.OpenaiAgConverter
import com.wag2api.ag.SseStreamer
import com.wag2api.app.EngineRouter
import com.wag2api.app.engine.EngineState
import com.wag2api.app.engine.NodeEngineApi
import org.json.JSONArray
import org.json.JSONObject
import java.io.BufferedInputStream
import java.io.ByteArrayOutputStream
import java.io.EOFException
import java.io.File
import java.io.IOException
import java.io.InputStream
import java.net.InetAddress
import java.net.InetSocketAddress
import java.net.ServerSocket
import java.net.Socket
import java.net.URLDecoder
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import java.util.TimeZone
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.Executors
import java.util.concurrent.SynchronousQueue
import java.util.concurrent.ThreadPoolExecutor
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger

/**
 * AIS 引擎：用系统 WebView 承载 aistudio.google.com 页面，代替原来的 Go + SpiderMonkey 子进程。
 *
 * 在 127.0.0.1:8820 起一个进程内 HTTP 服务，前门 EngineRouter.proxyToAis 和控制台都走这里：
 *  - /v1/models、/v1/chat/completions、/v1/messages（OpenAI 先经 OpenaiAgConverter 转成 Anthropic，再经 ContentConverter 转成 Google 格式，
 *    最后由 MakerSuiteWire 组成 AI Studio 私有协议；响应经 MakerSuiteStream 还原成 Google 流，交给 SseStreamer / OpenaiAgConverter 输出）
 *  - /api/… 里控制台用到的账号管理、状态、模型等接口（字段沿用原 AIS 接口）
 *
 * 账号数据目录：filesDir/ais/auth/<id>/storage-state.json + account.json（与旧版相同，升级后账号保留）。
 * 每个账号一个隐藏 WebView（[AisWebWorker]），按需创建，空闲 10 分钟销毁。
 */
class WebViewAisEngine private constructor(private val ctx: Context) : NodeEngineApi {

    companion object {
        private const val TAG = "AIS-WV"
        const val PORT = 8820
        const val VERSION = "webview-proto-1"
        private const val IDLE_MS = 10 * 60 * 1000L
        private const val MAX_LOG = 200

        @Volatile private var instance: WebViewAisEngine? = null

        @JvmStatic
        fun get(ctx: Context): WebViewAisEngine =
            instance ?: synchronized(this) { instance ?: WebViewAisEngine(ctx.applicationContext).also { instance = it } }

        fun peek(): WebViewAisEngine? = instance
    }

    @Volatile override var state: EngineState = EngineState.OFF
        private set
    @Volatile override var port: Int = 0
        private set

    private val inflight = AtomicInteger(0)
    private val active = AtomicInteger(0)
    @Volatile private var serverSocket: ServerSocket? = null
    private var pool: ThreadPoolExecutor? = null
    private val reaper = Executors.newSingleThreadScheduledExecutor { r -> Thread(r, "ais-wv-reaper").apply { isDaemon = true } }
    private val workers = ConcurrentHashMap<String, AisWebWorker>()
    private val cooldownUntil = ConcurrentHashMap<String, Long>()
    private val logBuf = ArrayDeque<String>()
    private val records = ArrayDeque<JSONObject>()
    @Volatile private var dataPlaneOn = true
    @Volatile private var lastModels: List<MakerSuiteWire.ModelInfo> = emptyList()
    private var rr = 0

    private val authDir: File get() = File(ctx.filesDir, "ais/auth").apply { mkdirs() }

    init {
        reaper.scheduleWithFixedDelay({ reapIdle() }, 60, 60, TimeUnit.SECONDS)
    }

    // ------------------------------------------------------------------ NodeEngineApi

    override fun start() {
        synchronized(this) {
            if (serverSocket?.isClosed == false) { state = EngineState.READY; return }
            state = EngineState.STARTING
            try {
                val ss = ServerSocket()
                ss.reuseAddress = true
                ss.bind(InetSocketAddress(InetAddress.getByName("127.0.0.1"), PORT), 64)
                serverSocket = ss
                port = PORT
                val n = AtomicInteger(0)
                val p = ThreadPoolExecutor(2, 32, 60, TimeUnit.SECONDS, SynchronousQueue()) { r -> Thread(r, "ais-wv-http-" + n.incrementAndGet()).apply { isDaemon = true } }
                // [P3] 满载时拒绝并关连接（下面 catch 里 close），不再让 accept 线程自己去跑长请求而卡住整个端口
                p.rejectedExecutionHandler = ThreadPoolExecutor.AbortPolicy()
                pool = p
                Thread({
                    while (!ss.isClosed) {
                        val s = try { ss.accept() } catch (e: IOException) { if (ss.isClosed) break else continue }
                        try { p.execute { serve(s) } } catch (t: Throwable) { try { s.close() } catch (_: Exception) {} }
                    }
                }, "ais-wv-accept").apply { isDaemon = true }.start()
                state = EngineState.READY
                log("WebView AIS 引擎已启动 127.0.0.1:$PORT（WebView ${webViewVersion()}，独立 Profile：${AisWebWorker.multiProfile()}）")
            } catch (t: Throwable) {
                state = EngineState.FAILED
                log("WebView AIS 引擎启动失败：${t.message}")
            }
        }
    }

    override fun stop() {
        synchronized(this) {
            state = EngineState.STOPPING
            try { serverSocket?.close() } catch (_: Exception) {}
            serverSocket = null
            pool?.shutdown()
            pool = null
            for ((_, w) in workers) w.close()
            workers.clear()
            port = 0
            state = EngineState.OFF
            log("WebView AIS 引擎已停止")
        }
    }

    val isServing: Boolean get() = serverSocket?.isClosed == false

    override fun requestStart() { inflight.incrementAndGet() }
    override fun requestEnd() { inflight.decrementAndGet() }
    override fun awaitIdle(timeoutMs: Long): Boolean {
        val end = System.currentTimeMillis() + timeoutMs
        while (System.currentTimeMillis() < end) { if (inflight.get() <= 0) return true; Thread.sleep(50) }
        return inflight.get() <= 0
    }

    fun getLogs(): List<String> = synchronized(logBuf) { logBuf.toList() }

    private fun log(raw: String) {
        val line = com.wag2api.ag.Redact.redact(raw)
        Log.i(TAG, line)
        val stamped = SimpleDateFormat("HH:mm:ss", Locale.US).format(Date()) + " " + line
        synchronized(logBuf) { if (logBuf.size >= MAX_LOG) logBuf.removeFirst(); logBuf.addLast(stamped) }
    }

    private fun webViewVersion(): String = try { WebViewCompat.getCurrentWebViewPackage(ctx)?.versionName ?: "?" } catch (t: Throwable) { "?" }

    // ------------------------------------------------------------------ 账号

    private fun accountDirs(): List<File> = (authDir.listFiles() ?: emptyArray())
        .filter { it.isDirectory && !it.name.startsWith(".") && File(it, "storage-state.json").isFile }
        .sortedBy { it.name }

    private fun meta(dir: File): JSONObject = try { JSONObject(File(dir, "account.json").readText(Charsets.UTF_8)) } catch (e: Exception) { JSONObject() }

    private fun writeMeta(dir: File, m: JSONObject) = File(dir, "account.json").writeText(m.toString(), Charsets.UTF_8)

    private fun accountState(id: String, m: JSONObject): Pair<String, String?> {
        if (!m.optBoolean("enabled", true)) return "disabled" to null
        val w = workers[id]
        val cd = cooldownUntil[id] ?: 0L
        if (cd > System.currentTimeMillis()) return "cooldown" to "冷却至 " + SimpleDateFormat("HH:mm:ss", Locale.US).format(Date(cd))
        return when (w?.phase) {
            AisWebWorker.Phase.AUTH_REQUIRED -> "auth_required" to w.error
            AisWebWorker.Phase.FAILED -> "unavailable" to w.error
            AisWebWorker.Phase.BOOTING -> "busy" to "WebView 初始化中"
            AisWebWorker.Phase.READY -> (if (w.inflight.get() > 0) "busy" else "ready") to null
            else -> "ready" to "WebView 未启动（按需创建）"
        }
    }

    private fun accountJson(dir: File): JSONObject {
        val m = meta(dir)
        val id = dir.name
        val (st, msg) = accountState(id, m)
        val w = workers[id]
        return JSONObject()
            .put("id", id)
            .put("email", m.optString("email", "").ifEmpty { w?.email ?: "" })
            .put("label", m.optString("label", "").ifEmpty { id })
            .put("enabled", m.optBoolean("enabled", true))
            .put("state", st)
            .put("message", msg ?: JSONObject.NULL)
            .put("auth_user", m.optInt("auth_user", 0))
            .put("proxy", m.optString("proxy", ""))
            .put("locale", m.optString("locale", ""))
            .put("timezone", m.optString("timezone", ""))
            .put("webview", JSONObject()
                .put("phase", w?.phase?.name ?: "NEW")
                .put("page", w?.pageUrl ?: "")
                .put("headers", JSONArray(w?.headerNames ?: emptyList<String>()))
                .put("models", w?.models?.size ?: 0))
    }

    private fun importAccount(body: JSONObject): JSONObject {
        val raw = when (val c = body.opt("cookies") ?: body.opt("storage_state")) {
            is String -> c
            is JSONObject, is JSONArray -> c.toString()
            else -> throw IllegalArgumentException("缺少 cookies")
        }
        val st = StorageState.parse(raw)
        st.requireLogin()
        val label = body.optString("label", "").trim()
        val authUser = body.optInt("auth_user", 0)
        val fp = st.fingerprint()
        // 同一个 Google 账号（同 __Secure-1PSID）重复导入时覆盖原目录
        var dir = accountDirs().firstOrNull { meta(it).optString("fingerprint") == fp && meta(it).optInt("auth_user", 0) == authUser }
        if (dir == null) {
            val base = label.ifEmpty { "ais-$fp" + if (authUser > 0) "-u$authUser" else "" }.replace(Regex("[^A-Za-z0-9@._-]"), "_")
            dir = File(authDir, base)
        }
        dir.mkdirs()
        File(dir, "storage-state.json").writeText(st.toJson().toString(), Charsets.UTF_8)
        val m = meta(dir)
        m.put("label", label.ifEmpty { m.optString("label", "") })
        m.put("enabled", true)
        m.put("auth_user", authUser)
        m.put("fingerprint", fp)
        m.put("cookies_installed", false)
        for (k in listOf("proxy", "locale", "timezone")) body.optString(k, "").takeIf { it.isNotEmpty() }?.let { m.put(k, it) }
        writeMeta(dir, m)
        workers.remove(dir.name)?.close()
        cooldownUntil.remove(dir.name)
        log("导入账号 ${dir.name}（${st.cookies.size} 个 Cookie）")
        return accountJson(dir)
    }

    private fun deleteAccount(id: String): Boolean {
        val dir = File(authDir, id)
        if (!dir.isDirectory) return false
        workers.remove(id)?.close()
        dir.deleteRecursively()
        if (AisWebWorker.multiProfile()) {
            try { ProfileStore.getInstance().deleteProfile("ais_" + id.replace(Regex("[^A-Za-z0-9_]"), "_")) } catch (t: Throwable) { log("删除 WebView Profile 失败：${t.message}") }
        }
        log("删除账号 $id")
        return true
    }

    private fun workerFor(id: String): AisWebWorker {
        workers[id]?.let { return it }
        synchronized(workers) {
            workers[id]?.let { return it }
            if (!AisWebWorker.multiProfile()) {
                // 不支持多 Profile：Cookie 全局共享，同一时间只保留一个账号的 WebView
                for ((k, w) in workers) { if (w.inflight.get() == 0) { w.close(); workers.remove(k) } }
                if (workers.isNotEmpty()) throw IOException("此 WebView 不支持多 Profile，另一个账号正在使用中")
            }
            val w = AisWebWorker(ctx, id, File(authDir, id)) { log(it) }
            workers[id] = w
            return w
        }
    }

    /** 选号：启用、不在冷却、不需重新认证；优先已就绪的 WebView，其次轮询 */
    private fun candidates(): List<String> {
        val now = System.currentTimeMillis()
        val ids = accountDirs().filter { meta(it).optBoolean("enabled", true) }.map { it.name }
            .filter { (cooldownUntil[it] ?: 0) <= now && workers[it]?.phase != AisWebWorker.Phase.AUTH_REQUIRED }
        if (ids.isEmpty()) return ids
        val readyFirst = ids.sortedBy { if (workers[it]?.phase == AisWebWorker.Phase.READY) 0 else 1 }
        val start = (rr++) % readyFirst.size
        val ready = readyFirst.filter { workers[it]?.phase == AisWebWorker.Phase.READY }
        return if (ready.size == readyFirst.size) readyFirst.drop(start) + readyFirst.take(start) else readyFirst
    }

    private fun reapIdle() {
        val now = System.currentTimeMillis()
        for ((id, w) in workers) {
            if (w.inflight.get() == 0 && now - w.lastUsed > IDLE_MS) {
                log("账号 $id 空闲超过 10 分钟，销毁 WebView")
                workers.remove(id)
                w.close()
            }
        }
    }

    // ------------------------------------------------------------------ HTTP

    private class Req(val method: String, val path: String, val query: Map<String, String>, val headers: Map<String, String>, val body: String) {
        fun json(): JSONObject = try { JSONObject(body.ifEmpty { "{}" }) } catch (e: Exception) { JSONObject() }
    }

    private fun readLine(input: InputStream): String? {
        val buf = ByteArrayOutputStream(128)
        while (true) {
            val b = input.read()
            if (b < 0) return if (buf.size() == 0) null else buf.toString("ISO-8859-1")
            if (b == '\n'.code) break
            if (b != '\r'.code) buf.write(b)
            if (buf.size() > 65536) throw IOException("header line too long")
        }
        return buf.toString("ISO-8859-1")
    }

    private fun serve(s: Socket) {
        try {
            s.use { sock ->
                sock.tcpNoDelay = true
                sock.soTimeout = 600_000
                val input = BufferedInputStream(sock.getInputStream())
                val out = sock.getOutputStream()
                val line = readLine(input) ?: return
                val parts = line.split(' ')
                if (parts.size < 2) return
                val headers = LinkedHashMap<String, String>()
                while (true) {
                    val l = readLine(input) ?: break
                    if (l.isEmpty()) break
                    val i = l.indexOf(':')
                    if (i > 0) headers[l.substring(0, i).trim().lowercase(Locale.ROOT)] = l.substring(i + 1).trim()
                }
                val len = headers["content-length"]?.toIntOrNull() ?: 0
                val bodyBytes = ByteArray(Math.max(0, len))
                var off = 0
                while (off < bodyBytes.size) { val n = input.read(bodyBytes, off, bodyBytes.size - off); if (n < 0) throw EOFException(); off += n }
                val target = parts[1]
                val path = target.substringBefore('?')
                val query = LinkedHashMap<String, String>()
                target.substringAfter('?', "").split('&').filter { it.isNotEmpty() }.forEach {
                    query[URLDecoder.decode(it.substringBefore('='), "UTF-8")] = URLDecoder.decode(it.substringAfter('=', ""), "UTF-8")
                }
                val req = Req(parts[0].uppercase(Locale.ROOT), path, query, headers, String(bodyBytes, Charsets.UTF_8))
                val res = AgServer.AgResponse(sock, out)
                requestStart()
                try {
                    route(req, res)
                } catch (t: Throwable) {
                    log("[请求出错] ${req.method} ${req.path}: ${t.message}")
                    if (!res.headersSent) res.sendJson(500, errorObj(t.message ?: t.toString(), "api_error"))
                } finally {
                    requestEnd()
                }
                try { out.flush() } catch (_: IOException) {}
            }
        } catch (_: Throwable) {}
    }

    private fun errorObj(message: String, type: String = "invalid_request_error") =
        JSONObject().put("error", JSONObject().put("message", message).put("type", type))

    private fun route(req: Req, res: AgServer.AgResponse) {
        val p = req.path.trimEnd('/').ifEmpty { "/" }
        val m = req.method
        when {
            p == "/health" || p == "/healthz" -> res.sendJson(200, JSONObject().put("ok", true).put("engine", "ais-webview"))
            p == "/v1/models" || p == "/api/models" || p == "/models" -> handleModels(res)
            p == "/v1/chat/completions" || p == "/chat/completions" -> handleChat(req, res, isOai = true)
            p == "/v1/messages" || p == "/messages" -> handleChat(req, res, isOai = false)
            p == "/api/status" -> res.sendJson(200, status())
            p == "/api/accounts" && m == "GET" -> res.sendJson(200, JSONObject().put("accounts", JSONArray(accountDirs().map { accountJson(it) })))
            p == "/api/accounts/import/cookies" && m == "POST" -> {
                try {
                    val acc = importAccount(req.json())
                    res.sendJson(200, JSONObject().put("ok", true).put("account", acc))
                } catch (e: Exception) {
                    res.sendJson(400, errorObj(e.message ?: "导入失败"))
                }
            }
            // WebView 版不支持“一份 Cookie 里识别多个 /u/N 账号”；控制台会回退到直接导入
            p == "/api/accounts/import/cookies/discover" -> res.sendJson(400, errorObj("WebView 版 AIS 不支持多账号识别，请直接导入"))
            p.startsWith("/api/accounts/") -> handleAccountOp(req, res, p.removePrefix("/api/accounts/"))
            p == "/api/control/start" -> { dataPlaneOn = true; res.sendJson(200, status()) }
            p == "/api/control/stop" -> {
                dataPlaneOn = false
                for ((_, w) in workers) w.close()
                workers.clear()
                res.sendJson(200, status())
            }
            p == "/api/config" -> res.sendJson(200, JSONObject().put("engine", "webview").put("idle_destroy_minutes", 10).put("multi_profile", AisWebWorker.multiProfile()))
            p == "/api/cooldowns" -> {
                val arr = JSONArray()
                val now = System.currentTimeMillis()
                for ((id, until) in cooldownUntil) if (until > now) arr.put(JSONObject().put("account_id", id).put("scope", "all").put("until", iso(until)).put("remaining_ms", until - now))
                res.sendJson(200, JSONObject().put("cooldowns", arr))
            }
            p == "/api/requests" -> res.sendJson(200, JSONObject().put("requests", JSONArray()))
            p == "/api/usage/records" -> res.sendJson(200, JSONObject().put("items", JSONArray(synchronized(records) { records.toList().reversed() })))
            p == "/api/usage" -> res.sendJson(200, usageSummary())
            p == "/api/logs" -> res.sendJson(200, JSONObject().put("logs", JSONArray(getLogs())).put("lines", JSONArray(getLogs())))
            p == "/api/webview" -> res.sendJson(200, webviewDiag())
            else -> res.sendJson(404, errorObj("WebView 版 AIS 原型未实现 $m $p", "not_found"))
        }
    }

    private fun handleAccountOp(req: Req, res: AgServer.AgResponse, rest: String) {
        val segs = rest.split('/').map { URLDecoder.decode(it, "UTF-8") }
        val id = segs[0]
        val dir = File(authDir, id)
        if (!dir.isDirectory) { res.sendJson(404, errorObj("账号不存在：$id", "not_found")); return }
        when {
            segs.size == 1 && req.method == "DELETE" -> res.sendJson(200, JSONObject().put("ok", deleteAccount(id)))
            segs.size == 1 && (req.method == "PUT" || req.method == "PATCH" || req.method == "POST") -> {
                val b = req.json()
                val m = meta(dir)
                for (k in listOf("label", "proxy", "locale", "timezone")) if (b.has(k)) m.put(k, b.optString(k))
                if (b.has("enabled")) m.put("enabled", b.optBoolean("enabled"))
                writeMeta(dir, m)
                if (!m.optBoolean("enabled", true)) workers.remove(id)?.close()
                res.sendJson(200, JSONObject().put("ok", true).put("account", accountJson(dir)))
            }
            segs.size == 1 -> res.sendJson(200, JSONObject().put("account", accountJson(dir)))
            segs.getOrNull(1) == "refresh" || segs.getOrNull(1) == "test" -> {
                // 重新初始化 WebView 并拉一次模型表，当作“测试账号”
                workers.remove(id)?.close()
                cooldownUntil.remove(id)
                try {
                    val w = workerFor(id)
                    w.ensureReady()
                    if (w.models.isNotEmpty()) lastModels = w.models
                    res.sendJson(200, JSONObject().put("ok", true).put("account", accountJson(dir)).put("models", w.models.size))
                } catch (e: Exception) {
                    res.sendJson(502, errorObj(e.message ?: "初始化失败", "api_error").put("account", accountJson(dir)))
                }
            }
            segs.getOrNull(1) == "cooldowns" -> { cooldownUntil.remove(id); res.sendJson(200, JSONObject().put("ok", true)) }
            else -> res.sendJson(404, errorObj("未实现", "not_found"))
        }
    }

    private fun status(): JSONObject {
        val dirs = accountDirs()
        var ready = 0; var busy = 0; var cd = 0; var auth = 0
        for (d in dirs) {
            when (accountState(d.name, meta(d)).first) {
                "ready" -> ready++
                "busy" -> busy++
                "cooldown" -> cd++
                "auth_required" -> auth++
            }
        }
        return JSONObject()
            .put("state", if (isServing && dataPlaneOn) "RUNNING" else "STOPPED")
            .put("running", isServing && dataPlaneOn)
            .put("ready", ready + busy > 0)
            .put("version", VERSION)
            .put("engine", "webview")
            .put("active_requests", active.get())
            .put("accounts", JSONObject().put("total", dirs.size).put("ready", ready).put("busy", busy).put("cooldown", cd).put("auth_required", auth))
            .put("live_webviews", workers.count { it.value.phase == AisWebWorker.Phase.READY })
    }

    private fun webviewDiag(): JSONObject = JSONObject()
        .put("webview_version", webViewVersion())
        .put("multi_profile", AisWebWorker.multiProfile())
        .put("features", JSONObject()
            .put("WEB_MESSAGE_LISTENER", feature(androidx.webkit.WebViewFeature.WEB_MESSAGE_LISTENER))
            .put("REQUESTED_WITH_HEADER_ALLOW_LIST", feature(androidx.webkit.WebViewFeature.REQUESTED_WITH_HEADER_ALLOW_LIST))
            .put("USER_AGENT_METADATA", feature(androidx.webkit.WebViewFeature.USER_AGENT_METADATA))
            .put("MULTI_PROFILE", feature(androidx.webkit.WebViewFeature.MULTI_PROFILE)))
        .put("user_agent", try { AisWebWorker.cleanUserAgent(android.webkit.WebSettings.getDefaultUserAgent(ctx)) } catch (t: Throwable) { "" })
        .put("accounts", JSONArray(accountDirs().map { accountJson(it) }))

    private fun feature(f: String): Boolean = try { androidx.webkit.WebViewFeature.isFeatureSupported(f) } catch (t: Throwable) { false }

    private fun iso(ms: Long) = SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss.SSS'Z'", Locale.US).apply { timeZone = TimeZone.getTimeZone("UTC") }.format(Date(ms))

    private fun usageSummary(): JSONObject {
        var ok = 0; var failed = 0; var limited = 0; var inTok = 0L; var outTok = 0L; var cached = 0L
        synchronized(records) {
            for (r in records) {
                val st = r.optInt("status")
                when { st == 200 -> ok++; st == 429 -> limited++; else -> failed++ }
                inTok += r.optLong("input_tokens"); outTok += r.optLong("output_tokens"); cached += r.optLong("cached_tokens")
            }
        }
        val totals = JSONObject().put("succeeded", ok).put("failed", failed).put("rate_limited", limited)
            .put("input_tokens", inTok).put("output_tokens", outTok).put("cached_tokens", cached)
        return JSONObject().put("totals", totals).put("buckets", JSONArray()).put("items", JSONArray())
    }

    private fun record(account: String?, model: String, status: Int, stream: Boolean, startMs: Long, usage: JSONObject?, error: String?) {
        val r = JSONObject().put("time", iso(System.currentTimeMillis())).put("account_id", account ?: "").put("model", model)
            .put("status", status).put("stream", stream).put("latency_ms", System.currentTimeMillis() - startMs)
            .put("input_tokens", usage?.optLong("input_tokens") ?: 0).put("output_tokens", usage?.optLong("output_tokens") ?: 0)
            .put("cached_tokens", usage?.optLong("cached_tokens") ?: 0)
        if (error != null) r.put("error", error.take(300))
        synchronized(records) { if (records.size >= 200) records.removeFirst(); records.addLast(r) }
    }

    // ------------------------------------------------------------------ 模型

    private fun handleModels(res: AgServer.AgResponse) {
        var list = lastModels
        if (list.isEmpty()) {
            for (id in candidates()) {
                try {
                    val w = workerFor(id)
                    w.ensureReady()
                    w.lastUsed = System.currentTimeMillis()
                    if (w.models.isEmpty()) w.models = MakerSuiteWire.parseModels(w.rpcUnary("ListModels", "[]", 30_000))
                    list = w.models
                    if (list.isNotEmpty()) break
                } catch (e: Exception) {
                    log("拉取模型表失败（$id）：${e.message}")
                }
            }
        }
        if (list.isNotEmpty()) lastModels = list
        val arr = JSONArray(list.map { it.toOpenAI() })
        if (arr.length() > 0) try { EngineRouter.cacheAisModels(ctx, arr) } catch (_: Throwable) {}
        res.sendJson(200, JSONObject().put("object", "list").put("data", arr).put("models", arr))
    }

    // ------------------------------------------------------------------ 对话

    private fun sendError(res: AgServer.AgResponse, isOai: Boolean, status: Int, msg: String) {
        val type = when (status) { 429 -> "rate_limit_error"; 401, 403 -> "authentication_error"; 400 -> "invalid_request_error"; else -> "api_error" }
        val body = if (isOai) errorObj(msg, type) else JSONObject().put("type", "error").put("error", JSONObject().put("type", type).put("message", msg))
        res.sendJson(status, body)
    }

    private fun handleChat(req: Req, res: AgServer.AgResponse, isOai: Boolean) {
        val start = System.currentTimeMillis()
        if (!dataPlaneOn) { sendError(res, isOai, 503, "AIS 服务已停止"); return }
        val raw = try { JSONObject(req.body) } catch (e: Exception) { sendError(res, isOai, 400, "请求体不是 JSON"); return }
        val anthropicReq = try { if (isOai) OpenaiAgConverter.openaiRequestToAnthropic(raw) else raw } catch (e: Exception) {
            sendError(res, isOai, 400, e.message ?: "请求无效"); return
        }
        val model = anthropicReq.optString("model", "").removePrefix("ais:").removePrefix("models/")
        if (model.isEmpty()) { sendError(res, isOai, 400, "缺少 model"); return }
        anthropicReq.put("model", model)
        // OpenAI → Anthropic 转换不一定保留 stream，以客户端原始请求为准
        val stream = raw.optBoolean("stream", false) || anthropicReq.optBoolean("stream", false)
        anthropicReq.put("stream", stream)
        val google = try { ContentConverter.convertAnthropicToGoogle(anthropicReq) } catch (e: Exception) {
            sendError(res, isOai, 400, "协议转换失败：${e.message}"); return
        }
        val ids = candidates()
        if (ids.isEmpty()) { sendError(res, isOai, 503, "没有可用的 AIS 账号（请先在控制台导入 Cookie）"); return }

        active.incrementAndGet()
        var lastErr: String? = null
        var lastStatus = 502
        try {
            for ((attempt, id) in ids.withIndex()) {
                if (attempt >= 2) break // 最多换一次号
                val w = try { workerFor(id) } catch (e: IOException) { lastErr = e.message; continue }
                w.inflight.incrementAndGet()
                w.lastUsed = System.currentTimeMillis()
                try {
                    try { w.ensureReady() } catch (e: IOException) {
                        lastErr = e.message; lastStatus = if (w.phase == AisWebWorker.Phase.AUTH_REQUIRED) 401 else 502
                        continue
                    }
                    val info = (w.models.ifEmpty { lastModels }).firstOrNull { it.id == model }
                    val tz = meta(File(authDir, id)).optString("timezone", "").ifEmpty { TimeZone.getDefault().id }
                    val wire = MakerSuiteWire.buildGenerateContent(model, google, anthropicReq, info, tz)
                    val contents = wire.getJSONArray(1)
                    val proof = w.proof(MakerSuiteWire.bindingPrompt(contents), MakerSuiteWire.pagePrompt(contents))
                    val body = MakerSuiteWire.withProof(wire, proof)
                    val s = w.send("GenerateContent", body)
                    // 等响应头
                    val first = s.next(120_000) ?: run { s.cancel(); throw IOException("上游 120 秒无响应") }
                    if (first.optString("t") == "err") throw IOException("页面请求失败：" + first.optString("e"))
                    val status = first.optInt("status", 0)
                    if (status != 200) {
                        val errText = drain(s)
                        val e = if (status == 0) MakerSuiteWire.RpcError(502, 0, "页面请求被浏览器拦截（status 0，可能是 CORS 或网络）")
                            else MakerSuiteWire.decodeError(status, errText)
                        val cs = e.clientStatus()
                        log("[$id] GenerateContent HTTP $status code=${e.code}：${e.message.take(200)}")
                        if (cs == 429) cooldownUntil[id] = System.currentTimeMillis() + 60_000
                        lastErr = e.message; lastStatus = cs
                        if (cs == 429 || cs == 401) continue
                        sendError(res, isOai, cs, e.message)
                        record(id, model, cs, stream, start, null, e.message)
                        return
                    }
                    val hasSystem = (wire.opt(5) as? JSONArray) != null
                    val decoder = MakerSuiteStream(if (hasSystem) 1 else 0)
                    res.setHeader("X-Gateway-Engine", "ais-webview")
                    res.setHeader("X-Gateway-Account", id)
                    if (stream) {
                        val feed = SseFeed(s, decoder)
                        var usageOut: JSONObject? = null
                        val onFinish: (JSONObject) -> Unit = { u -> usageOut = u }
                        if (isOai) {
                            val includeUsage = raw.optJSONObject("stream_options")?.optBoolean("include_usage", false) == true
                            OpenaiAgConverter.handleOpenAIStreamConversion(feed, res, model, onFinish, start, null, includeUsage)
                        } else {
                            SseStreamer.handleStreamConversion(feed, res, model, onFinish, start, null)
                        }
                        val outcome = usageOut?.optString("outcome") ?: "ok"
                        record(id, model, if (outcome == "ok") 200 else 502, true, start, usageOut, usageOut?.optString("error")?.takeIf { it.isNotEmpty() && it != "null" })
                        log("[$id] $model 流式完成（${outcome}，${System.currentTimeMillis() - start}ms）")
                    } else {
                        val chunks = ArrayList<JSONObject>()
                        while (true) {
                            val ev = s.next(300_000) ?: throw IOException("上游响应超时")
                            when (ev.optString("t")) {
                                "d" -> chunks.addAll(decoder.feed(ev.optString("s")))
                                "end" -> break
                                "err" -> throw IOException("上游连接中断：" + ev.optString("e"))
                            }
                        }
                        decoder.end(200)
                        val googleData = MakerSuiteStream.aggregate(chunks)
                        val out = if (isOai) OpenaiAgConverter.convertGoogleToOpenAI(googleData, model) else ContentConverter.convertGoogleToAnthropic(googleData, model)
                        res.sendJson(200, out)
                        val u = googleData.optJSONObject("usageMetadata")
                        record(id, model, 200, false, start, JSONObject()
                            .put("input_tokens", u?.optLong("promptTokenCount") ?: 0).put("output_tokens", u?.optLong("candidatesTokenCount") ?: 0)
                            .put("cached_tokens", u?.optLong("cachedContentTokenCount") ?: 0), null)
                        log("[$id] $model 非流式完成（${decoder.frames} 帧，${System.currentTimeMillis() - start}ms）")
                    }
                    return
                } catch (e: MakerSuiteWire.RpcError) {
                    lastErr = e.message; lastStatus = e.clientStatus()
                    if (!res.headersSent) { sendError(res, isOai, lastStatus, e.message); record(id, model, lastStatus, stream, start, null, e.message) }
                    return
                } catch (e: IOException) {
                    lastErr = e.message; lastStatus = 502
                    log("[$id] 请求失败：${e.message}")
                    if (res.headersSent) return
                    if (w.phase == AisWebWorker.Phase.FAILED) { workers.remove(id); w.close() }
                    continue
                } finally {
                    w.inflight.decrementAndGet()
                    w.lastUsed = System.currentTimeMillis()
                }
            }
            sendError(res, isOai, lastStatus, lastErr ?: "AIS 请求失败")
            record(null, model, lastStatus, stream, start, null, lastErr)
        } finally {
            active.decrementAndGet()
        }
    }

    private fun drain(s: AisWebWorker.Stream): String {
        val sb = StringBuilder()
        while (true) {
            val ev = s.next(30_000) ?: break
            when (ev.optString("t")) {
                "d" -> sb.append(ev.optString("s"))
                "end", "err" -> return sb.toString()
            }
        }
        return sb.toString()
    }

    /** 页面回传的 MakerSuite 增量 → Google SSE 行，供 SseStreamer 当作上游 InputStream 读 */
    private class SseFeed(private val s: AisWebWorker.Stream, private val dec: MakerSuiteStream) : InputStream() {
        private var cur: ByteArray = ByteArray(0)
        private var off = 0
        private var eof = false

        private fun fill(): Boolean {
            while (off >= cur.size) {
                if (eof) return false
                val ev = s.next(300_000) ?: throw IOException("上游响应超时")
                when (ev.optString("t")) {
                    "d" -> {
                        val sb = StringBuilder()
                        for (c in dec.feed(ev.optString("s"))) sb.append(MakerSuiteStream.sseLine(c))
                        cur = sb.toString().toByteArray(Charsets.UTF_8); off = 0
                    }
                    "end" -> {
                        eof = true
                        dec.end(200) // 流中途错误在这里抛 RpcError（IOException 的子类之外，包一层）
                        cur = "data: [DONE]\n\n".toByteArray(); off = 0
                    }
                    "err" -> throw IOException("上游连接中断：" + ev.optString("e"))
                }
            }
            return true
        }

        override fun read(): Int {
            return try { if (!fill()) -1 else cur[off++].toInt() and 0xff } catch (e: MakerSuiteWire.RpcError) { throw IOException(e.message, e) }
        }

        override fun read(b: ByteArray, o: Int, len: Int): Int {
            try { if (!fill()) return -1 } catch (e: MakerSuiteWire.RpcError) { throw IOException(e.message, e) }
            val n = Math.min(len, cur.size - off)
            System.arraycopy(cur, off, b, o, n)
            off += n
            return n
        }

        override fun close() { if (!eof) s.cancel() }
    }
}
