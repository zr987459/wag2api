package com.wag2api.ag

import okhttp3.Call
import okhttp3.ConnectionPool
import okhttp3.EventListener
import okhttp3.Handshake
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Protocol
import okhttp3.Request
import okhttp3.RequestBody
import okhttp3.RequestBody.Companion.toRequestBody
import okhttp3.Response
import java.io.IOException
import java.io.InterruptedIOException
import java.net.InetSocketAddress
import java.net.Proxy
import java.util.concurrent.ScheduledThreadPoolExecutor
import java.util.concurrent.ThreadFactory
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean

/**
 * PR4：上游连接复用（移植自 src/upstream-fetch.mjs）
 *
 *  - 全进程只有一个 OkHttpClient（[client]），连接池最多 4 个空闲连接、空闲 5 分钟回收。
 *  - 复用到已被服务端关掉的空闲连接时，OkHttp 的 retryOnConnectionFailure 会自动换新连接重发一次（对应 Node 版的 stale 重试）。
 *  - 打点：[gwReused] 本次是否复用了已有连接，[gwTlsMs] 新建连接时 TCP+TLS 握手耗时（复用为 0），对应 resp._gwReused / resp._gwTlsMs。
 *  - 取消：[AbortSignal.abort] 或 response.close() 会取消底层 Call，不会留下半截连接继续收数据。
 *  - 流式响应用 [readLines] 逐行读，不整段读进内存。
 */
object UpstreamFetch {
    const val RUNTIME = "kotlin"

    /** 对应 JS 的 AbortError（调用方主动取消） */
    class AbortError(message: String = "This operation was aborted") : IOException(message)

    /** 对应 JS 里 name='TimeoutError' 的错误（响应头超时） */
    class TimeoutError(message: String) : InterruptedIOException(message)

    /** 对应 AbortController/AbortSignal：abort(reason) 取消正在进行的请求 */
    class AbortSignal {
        @Volatile var aborted = false
            private set
        @Volatile var reason: IOException? = null
            private set
        @Volatile private var call: Call? = null

        fun abort(reason: IOException? = null) {
            if (aborted) return
            this.reason = reason ?: AbortError()
            aborted = true
            call?.cancel()
        }

        internal fun bind(c: Call) {
            call = c
            if (aborted) c.cancel()
        }
    }

    /** 每个请求的连接信息，挂在 Request tag 上 */
    class GwInfo {
        @Volatile var reused: Boolean = true
        @Volatile var connectStart = 0L
        @Volatile var tlsMs = 0L
    }

    private val listenerFactory = EventListener.Factory { call ->
        val info = call.request().tag(GwInfo::class.java)
        if (info == null) EventListener.NONE else object : EventListener() {
            override fun connectStart(call: Call, inetSocketAddress: InetSocketAddress, proxy: Proxy) {
                info.reused = false
                if (info.connectStart == 0L) info.connectStart = System.nanoTime()
            }

            override fun secureConnectEnd(call: Call, handshake: Handshake?) {
                if (info.connectStart != 0L) info.tlsMs = (System.nanoTime() - info.connectStart) / 1_000_000
            }

            override fun connectEnd(call: Call, inetSocketAddress: InetSocketAddress, proxy: Proxy, protocol: Protocol?) {
                if (info.connectStart != 0L && info.tlsMs == 0L) info.tlsMs = (System.nanoTime() - info.connectStart) / 1_000_000
            }
        }
    }

    /** 上游读空闲超时（毫秒），环境变量 UPSTREAM_READ_IDLE_MS 可调，默认 10 分钟（大于非流式响应头超时 5 分钟） */
    private val READ_IDLE_MS: Long = System.getenv("UPSTREAM_READ_IDLE_MS")?.toLongOrNull()?.takeIf { it > 0 } ?: 600_000L

    /** 全局唯一的 OkHttpClient（其他模块需要发请求也用它，或 client.newBuilder() 派生以共享连接池） */
    @JvmField
    val client: OkHttpClient = OkHttpClient.Builder()
        .connectionPool(ConnectionPool(4, 5, TimeUnit.MINUTES))
        .connectTimeout(30, TimeUnit.SECONDS)
        // [P3] 读空闲上限：上游半开连接（移动网络 NAT 回收后常见）不再无限期卡住请求线程。
        // 只在“连续这么久一个字节都没收到”时触发，正常流式（含长思考）不受影响；响应头超时仍由 headerTimeoutMs 控制。
        .readTimeout(READ_IDLE_MS, TimeUnit.MILLISECONDS)
        .writeTimeout(60, TimeUnit.SECONDS)
        .callTimeout(0, TimeUnit.MILLISECONDS)
        .retryOnConnectionFailure(true)
        .followRedirects(true)
        .eventListenerFactory(listenerFactory)
        .build()

    private val timer: ScheduledThreadPoolExecutor by lazy {
        ScheduledThreadPoolExecutor(1, ThreadFactory { r -> Thread(r, "ag-upstream-timer").apply { isDaemon = true } }).apply {
            removeOnCancelPolicy = true
        }
    }

    private val JSON_TYPE = "application/json".toMediaType()

    /** 与 fetch(url, { method, headers, body, signal }) 同形的选项；headerTimeoutMs>0 时超时抛 [TimeoutError] */
    class Options(
        @JvmField val method: String = "GET",
        @JvmField val headers: Map<String, String> = emptyMap(),
        @JvmField val body: String? = null,
        @JvmField val signal: AbortSignal? = null,
        @JvmField val headerTimeoutMs: Long = 0,
    )

    /**
     * 同步发请求（在调用线程阻塞到收到响应头）。成功返回 Response（调用方负责 close / 读完 body）；
     * 网络错误抛 IOException（取消抛 [AbortError]，响应头超时抛 [TimeoutError]）。
     */
    @JvmStatic
    @Throws(IOException::class)
    fun upstreamFetch(url: String, opts: Options = Options()): Response {
        val signal = opts.signal
        if (signal != null && signal.aborted) throw signal.reason ?: AbortError()
        val method = opts.method.uppercase()
        val rb: RequestBody? = when {
            opts.body != null -> {
                val ct = opts.headers.entries.firstOrNull { it.key.equals("content-type", true) }?.value
                opts.body.toRequestBody(ct?.toMediaType() ?: JSON_TYPE)
            }
            method == "POST" || method == "PUT" || method == "PATCH" -> ByteArray(0).toRequestBody(null)
            else -> null
        }
        val b = Request.Builder().url(url).method(method, rb).tag(GwInfo::class.java, GwInfo())
        for ((k, v) in opts.headers) {
            // Connection / Content-Length 由 OkHttp 自己管理
            if (k.equals("connection", true) || k.equals("content-length", true)) continue
            b.header(k, v)
        }
        val call = client.newCall(b.build())
        signal?.bind(call)
        val timedOut = AtomicBoolean(false)
        val task = if (opts.headerTimeoutMs > 0) timer.schedule({
            timedOut.set(true)
            call.cancel()
        }, opts.headerTimeoutMs, TimeUnit.MILLISECONDS) else null
        try {
            return call.execute()
        } catch (e: IOException) {
            if (timedOut.get()) throw TimeoutError("upstream header timeout ${opts.headerTimeoutMs}ms").apply { initCause(e) }
            if (signal != null && signal.aborted) throw signal.reason ?: AbortError()
            throw IOException("fetch failed: " + (e.message ?: e.toString()), e)
        } finally {
            task?.cancel(false)
        }
    }

    @JvmStatic
    @Throws(IOException::class)
    fun upstreamFetch(url: String, method: String, headers: Map<String, String>, body: String?, headerTimeoutMs: Long = 0, signal: AbortSignal? = null): Response =
        upstreamFetch(url, Options(method, headers, body, signal, headerTimeoutMs))

    /** resp._gwReused：本次是否复用了已有连接 */
    @JvmStatic
    fun gwReused(resp: Response?): Boolean? = resp?.request?.tag(GwInfo::class.java)?.reused

    /** resp._gwTlsMs：新建连接时 TCP+TLS 握手耗时（复用为 0） */
    @JvmStatic
    fun gwTlsMs(resp: Response?): Long? {
        val i = resp?.request?.tag(GwInfo::class.java) ?: return null
        return if (i.reused) 0 else i.tlsMs
    }

    /** r.text()：读完整个 body（仅用于错误体等小响应）；读失败返回 "" */
    @JvmStatic
    fun textOf(resp: Response?): String {
        if (resp == null) return ""
        return try { resp.body?.string() ?: "" } catch (e: Exception) { "" } finally { try { resp.close() } catch (e: Exception) {} }
    }

    /**
     * 流式逐行读（UTF-8，去掉行尾 \r\n）。onLine 返回 false 时停止并取消上游。读完或出错后关闭响应。
     * 出错（含被取消）时抛 IOException。
     */
    @JvmStatic
    @Throws(IOException::class)
    fun readLines(resp: Response, onLine: (String) -> Boolean) {
        val body = resp.body
        if (body == null) { resp.close(); return }
        try {
            val src = body.source()
            while (true) {
                val line = src.readUtf8Line() ?: break
                if (!onLine(line)) break
            }
        } finally {
            resp.close()
        }
    }

    /** 主动断开（对应 body.getReader().cancel()） */
    @JvmStatic
    fun cancel(resp: Response?) {
        if (resp == null) return
        try { resp.close() } catch (e: Exception) {}
    }

    /** 当前连接池状态（调试用） */
    @JvmStatic
    fun poolStats(): String = "idle=${client.connectionPool.idleConnectionCount()} total=${client.connectionPool.connectionCount()}"
}
