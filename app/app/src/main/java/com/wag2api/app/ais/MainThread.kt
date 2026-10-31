package com.wag2api.app.ais

import android.os.Handler
import android.os.Looper
import java.io.IOException
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicReference

/**
 * [beta] 切到主线程执行并在调用线程等待结果。
 *
 * WebView / CookieManager / androidx.webkit ProfileStore（含 Profile.getCookieManager）只能在主线程调用；
 * 支持 MULTI_PROFILE 的新版 WebView 在后台线程调用会抛 “Must be called on the UI thread.”。
 * 已在主线程时直接执行（避免自己等自己死锁）；后台线程投递到主线程，超时抛 IOException。
 *
 * isMain / post 可替换，方便纯 JVM 单元测试（不依赖 Looper）。
 */
object MainThread {
    @Volatile internal var isMain: () -> Boolean = { Looper.myLooper() == Looper.getMainLooper() }
    @Volatile internal var post: (Runnable) -> Unit = { r -> handler.post(r) }

    private val handler: Handler by lazy { Handler(Looper.getMainLooper()) }

    const val DEFAULT_TIMEOUT_MS = 15_000L

    @JvmStatic
    fun <T> call(timeoutMs: Long = DEFAULT_TIMEOUT_MS, block: () -> T): T {
        if (isMain()) return block()
        val done = CountDownLatch(1)
        val result = AtomicReference<Any?>()
        val error = AtomicReference<Throwable?>()
        post(Runnable {
            try { result.set(block()) } catch (t: Throwable) { error.set(t) } finally { done.countDown() }
        })
        val ok = try { done.await(timeoutMs, TimeUnit.MILLISECONDS) } catch (e: InterruptedException) {
            Thread.currentThread().interrupt(); throw IOException("等待主线程时被中断", e)
        }
        if (!ok) throw IOException("主线程繁忙（${timeoutMs}ms 内未执行完）")
        error.get()?.let { t -> throw if (t is IOException) t else IOException(t.message ?: t.toString(), t) }
        @Suppress("UNCHECKED_CAST")
        return result.get() as T
    }
}
