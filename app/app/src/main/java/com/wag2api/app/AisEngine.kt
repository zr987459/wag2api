package com.wag2api.app

import android.content.Context
import android.util.Log
import java.io.File

object AisEngine {
    private const val TAG = "AIS"
    const val baseUrl = "http://127.0.0.1:8820"

    /**
     * AIS 后端：webview（默认，[com.wag2api.app.ais.WebViewAisEngine]，进程内、无 .so）或 go（libaistudio2api.so 子进程）。
     * 由 BuildConfig.AIS_BACKEND 决定（gradle -PaisBackend=go 切回 Go 版）。两者都监听 127.0.0.1:8820，前门与控制台不用改。
     */
    val useWebView: Boolean get() = BuildConfig.AIS_BACKEND == "webview"

    private fun webView(ctx: Context? = null): com.wag2api.app.ais.WebViewAisEngine? {
        val c = ctx ?: appContext
        return if (c != null) com.wag2api.app.ais.WebViewAisEngine.get(c) else com.wag2api.app.ais.WebViewAisEngine.peek()
    }

    /** 只保留最近 200 行日志（环形缓冲） */
    private const val MAX_LOG_LINES = 200

    /** 用户手动开启 AIS 的设置（与 EngineRouter 同一个 SharedPreferences） */
    private const val PREF = "wag2api_router"
    private const val KEY_AIS_ENABLED = "ais_enabled"
    private val logBuffer = ArrayDeque<String>(MAX_LOG_LINES)
    private val logLock = Any()

    @Volatile
    private var process: Process? = null

    @Volatile
    private var stopped = true

    private var supervisorThread: Thread? = null
    private var appContext: Context? = null

    /**
     * AIS 二进制是否存在。
     * 不带 ctx 的调用来自转发入口（EngineRouter.proxyToAis）：此时若子进程没起，按需拉起并等端口就绪，
     * 这样“还没有 AIS 账号、子进程未启动”时，控制台添加第一个账号的请求也能打到 AIS。
     */
    fun isAvailable(ctx: Context? = null): Boolean {
        val c = ctx ?: appContext ?: return false
        if (useWebView) {
            if (ctx == null && !isRunning()) ensureStarted(c, waitMs = 8_000L)
            return true
        }
        val bin = File(c.applicationInfo.nativeLibraryDir, "libaistudio2api.so")
        if (!bin.exists()) return false
        if (ctx == null && !isRunning()) ensureStarted(c, waitMs = 8_000L)
        return true
    }

    /** 已有 AIS 账号：ais/auth 下存在带 storage-state.json 的账号目录 */
    fun hasAccounts(ctx: Context): Boolean {
        val authDir = File(ctx.filesDir, "ais/auth")
        val dirs = authDir.listFiles() ?: return false
        return dirs.any { it.isDirectory && !it.name.startsWith(".") && File(it, "storage-state.json").isFile }
    }

    fun isEnabledInSettings(ctx: Context): Boolean =
        ctx.getSharedPreferences(PREF, Context.MODE_PRIVATE).getBoolean(KEY_AIS_ENABLED, false)

    /** 设置里开关 AIS：开启立即启动；关闭时若没有账号则停掉子进程 */
    fun setEnabled(ctx: Context, on: Boolean) {
        val app = ctx.applicationContext
        app.getSharedPreferences(PREF, Context.MODE_PRIVATE).edit().putBoolean(KEY_AIS_ENABLED, on).apply()
        if (on) ensureStarted(app) else if (!hasAccounts(app)) stop()
    }

    /** 开机自启条件：有 AIS 账号，或用户在设置里开启 */
    fun shouldAutoStart(ctx: Context): Boolean = hasAccounts(ctx) || isEnabledInSettings(ctx)

    /** 只在满足条件时启动（GatewayService 启动时调用） */
    fun startIfNeeded(ctx: Context): Boolean {
        val app = ctx.applicationContext
        appContext = app
        // WebView 版只是一个本地端口，WebView 按需创建，开销很小：总是启动
        if (useWebView) { start(app); return true }
        if (!shouldAutoStart(app)) {
            Log.i(TAG, "没有 AIS 账号且未在设置中开启，AIS 子进程不启动")
            return false
        }
        start(app)
        return true
    }

    /**
     * 按需启动并（可选）等待 127.0.0.1:8820 可连接；启动后后台同步一次模型表。
     * @return 等待结束时 AIS 是否在运行
     */
    fun ensureStarted(ctx: Context, waitMs: Long = 0L): Boolean {
        val app = ctx.applicationContext
        if (!stopped && isRunning()) return if (waitMs > 0) waitPort(waitMs) else true
        start(app)
        if (stopped) return false   // 二进制不存在
        Thread({
            if (waitPort(30_000L)) EngineRouter.syncAisModels(app)
        }, "Ais-ModelSync-OnDemand").apply { isDaemon = true; start() }
        return if (waitMs > 0) waitPort(waitMs) else isRunning()
    }

    /** 等 AIS 端口可连接 */
    fun waitPort(timeoutMs: Long): Boolean {
        val deadline = System.currentTimeMillis() + timeoutMs
        while (System.currentTimeMillis() < deadline) {
            try {
                java.net.Socket().use { it.connect(java.net.InetSocketAddress("127.0.0.1", 8820), 300) }
                return true
            } catch (e: Exception) {
                try { Thread.sleep(200) } catch (ie: InterruptedException) { return false }
            }
        }
        return false
    }

    fun isRunning(): Boolean {
        if (useWebView) return webView()?.isServing == true
        val p = process ?: return false
        return try {
            p.exitValue()
            false
        } catch (e: IllegalThreadStateException) {
            true
        }
    }

    @Synchronized
    fun start(ctx: Context) {
        val app = ctx.applicationContext
        appContext = app
        if (useWebView) {
            stopped = false
            webView(app)?.start()
            return
        }
        if (!isAvailable(app)) {
            Log.w(TAG, "libaistudio2api.so 不存在，AIS 引擎不可用")
            return
        }
        if (!stopped && isRunning()) return
        val sup = supervisorThread
        if (!stopped && sup != null && sup.isAlive) {
            // 守护线程还在（处于重启退避中）：不再起第二个，只把它从 sleep 里叫醒立即重启
            if (process == null) sup.interrupt()
            return
        }

        stopped = false
        // 等子进程真正 start() 后再返回，调用方可立即用 isRunning() 判断
        val launched = java.util.concurrent.CountDownLatch(1)
        launchedSignal = launched
        supervisorThread = Thread({
            var delayMs = 5000L
            while (!stopped) {
                val ranWell = launchProcess(app)
                if (stopped) break
                if (ranWell) {
                    delayMs = 5000L
                }
                Log.w(TAG, "AIS 进程退出，将在 ${delayMs / 1000}s 后尝试重启")
                try {
                    Thread.sleep(delayMs)
                } catch (e: InterruptedException) {
                    if (stopped) break
                }
                if (stopped) break
                delayMs = (delayMs * 2).coerceAtMost(60_000L)
            }
        }, "AisEngine-Supervisor").apply {
            isDaemon = true
            start()
        }
        try { launched.await(3, java.util.concurrent.TimeUnit.SECONDS) } catch (ignored: InterruptedException) {}
    }

    @Volatile
    private var launchedSignal: java.util.concurrent.CountDownLatch? = null

    @Synchronized
    fun stop() {
        stopped = true
        if (useWebView) { webView()?.stop(); return }
        supervisorThread?.interrupt()
        supervisorThread = null
        try {
            process?.destroy()
        } catch (ignored: Exception) {}
        process = null
    }

    private fun launchProcess(ctx: Context): Boolean {
        val bin = File(ctx.applicationInfo.nativeLibraryDir, "libaistudio2api.so")
        if (!bin.exists()) return false

        val dataDir = File(ctx.filesDir, "ais").apply { mkdirs() }
        File(dataDir, "auth").mkdirs()
        updateEnvFile(dataDir)

        return try {
            val pb = ProcessBuilder(bin.path, "-open-ui=false")
            pb.directory(dataDir)
            val env = pb.environment()
            env["HOME"] = dataDir.absolutePath
            env["TMPDIR"] = ctx.cacheDir.absolutePath
            // 省内存：Go 运行时软上限 64MiB，GC 更积极
            env["GOMEMLIMIT"] = "64MiB"
            env["GOGC"] = "50"
            // 静态 musl 二进制：安卓没有 /etc/resolv.conf 与 /etc/ssl，显式给出系统 DNS 与证书目录
            systemDns(ctx)?.let { env["AIS_DNS"] = it }
            env["SSL_CERT_DIR"] = listOf("/apex/com.android.conscrypt/cacerts", "/system/etc/security/cacerts")
                .filter { File(it).isDirectory }.joinToString(":")
            pb.redirectErrorStream(true)

            val p = pb.start()
            process = p
            launchedSignal?.countDown()

            val readerThread = Thread({
                try {
                    p.inputStream.bufferedReader(Charsets.UTF_8).useLines { lines ->
                        for (line in lines) {
                            appendLog(line)
                        }
                    }
                } catch (ignored: Exception) {}
            }, "AisEngine-Output")
            readerThread.isDaemon = true
            readerThread.start()

            val startTime = System.currentTimeMillis()
            p.waitFor()
            process = null
            System.currentTimeMillis() - startTime > 60_000L
        } catch (e: Exception) {
            Log.e(TAG, "运行 AIS 进程出错", e)
            appendLog("AIS 启动失败: ${e.message}")
            process = null
            launchedSignal?.countDown()
            false
        }
    }

    private fun systemDns(ctx: Context): String? = try {
        val cm = ctx.getSystemService(Context.CONNECTIVITY_SERVICE) as android.net.ConnectivityManager
        val lp = cm.getLinkProperties(cm.activeNetwork)
        lp?.dnsServers?.mapNotNull { it.hostAddress }
            ?.map { if (it.contains(':')) "[${it.substringBefore('%')}]:53" else "$it:53" }
            ?.joinToString(",")?.ifEmpty { null }
    } catch (e: Exception) {
        null
    }

    private fun updateEnvFile(dataDir: File) {
        val envFile = File(dataDir, ".env")
        val overrides = linkedMapOf(
            "LISTEN_ADDR" to "127.0.0.1:8820",
            "PREVIEW_LISTEN_ADDR" to "127.0.0.1:8821",
            "WAA_BACKEND" to "spidermonkey",
            "AUTO_START" to "true",
            "AISTUDIO_AUTH_STATES" to "auth",
            "WARM_WORKER_LIMIT" to "1",
            "MAX_ACTIVE_WORKERS" to "2",
            "WARM_STARTUP_CONCURRENCY" to "1",
            "PER_ACCOUNT_CONCURRENCY" to "2",
            "LOG_MAX_TOTAL_MB" to "50"
        )
        val remaining = overrides.toMutableMap()
        val newLines = mutableListOf<String>()

        if (envFile.exists()) {
            try {
                envFile.readLines(Charsets.UTF_8).forEach { line ->
                    val trimmed = line.trim()
                    if (trimmed.startsWith("#") || !trimmed.contains("=")) {
                        newLines.add(line)
                    } else {
                        val eqIdx = line.indexOf('=')
                        val key = line.substring(0, eqIdx).trim()
                        if (remaining.containsKey(key)) {
                            newLines.add("$key=${remaining.remove(key)}")
                        } else {
                            newLines.add(line)
                        }
                    }
                }
            } catch (e: Exception) {
                Log.w(TAG, "读取原 .env 失败: ${e.message}")
            }
        }
        for ((k, v) in remaining) {
            newLines.add("$k=$v")
        }
        try {
            envFile.writeText(newLines.joinToString("\n") + "\n", Charsets.UTF_8)
        } catch (e: Exception) {
            Log.e(TAG, "写入 .env 失败", e)
        }
    }

    private fun appendLog(line: String) {
        Log.i(TAG, line)
        synchronized(logLock) {
            if (logBuffer.size >= MAX_LOG_LINES) {
                logBuffer.removeFirst()
            }
            logBuffer.addLast(line)
        }
    }

    fun getLogs(): List<String> {
        if (useWebView) return webView()?.getLogs() ?: emptyList()
        synchronized(logLock) {
            return logBuffer.toList()
        }
    }
}
