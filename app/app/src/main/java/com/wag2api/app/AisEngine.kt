package com.wag2api.app

import android.content.Context
import android.util.Log
import java.io.File

object AisEngine {
    private const val TAG = "AIS"
    const val baseUrl = "http://127.0.0.1:8820"

    private const val MAX_LOG_LINES = 300
    private val logBuffer = ArrayDeque<String>(MAX_LOG_LINES)
    private val logLock = Any()

    @Volatile
    private var process: Process? = null

    @Volatile
    private var stopped = true

    private var supervisorThread: Thread? = null
    private var appContext: Context? = null

    fun isAvailable(ctx: Context? = null): Boolean {
        val c = ctx ?: appContext ?: return false
        val bin = File(c.applicationInfo.nativeLibraryDir, "libaistudio2api.so")
        return bin.exists()
    }

    fun isRunning(): Boolean {
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
        if (!isAvailable(app)) {
            Log.w(TAG, "libaistudio2api.so 不存在，AIS 引擎不可用")
            return
        }
        if (!stopped && isRunning()) return

        stopped = false
        supervisorThread?.interrupt()
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
    }

    @Synchronized
    fun stop() {
        stopped = true
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
            // 静态 musl 二进制：安卓没有 /etc/resolv.conf 与 /etc/ssl，显式给出系统 DNS 与证书目录
            systemDns(ctx)?.let { env["AIS_DNS"] = it }
            env["SSL_CERT_DIR"] = listOf("/apex/com.android.conscrypt/cacerts", "/system/etc/security/cacerts")
                .filter { File(it).isDirectory }.joinToString(":")
            pb.redirectErrorStream(true)

            val p = pb.start()
            process = p

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
            process = null
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
        synchronized(logLock) {
            return logBuffer.toList()
        }
    }
}
