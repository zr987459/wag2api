package com.wag2api.ag

import android.content.Context
import android.util.Log
import com.wag2api.app.engine.EngineState
import com.wag2api.app.engine.NodeEngineApi
import java.util.concurrent.atomic.AtomicInteger

/**
 * v2 的 AG 引擎：进程内的“小 Node”。
 * start() 初始化 [AgPaths.dataDir]，在 127.0.0.1 随机端口起 [AgServer]（路由与 src/server.mjs 相同），
 * 内部令牌（X-Engine-Token）由 tokenProvider 提供（= EngineFactory.token / EngineTokenHolder）。
 */
class KotlinAgEngine(
    private val ctx: Context,
    private val tokenProvider: () -> String
) : NodeEngineApi {

    companion object {
        private const val TAG = "KotlinAgEngine"
    }

    @Volatile override var state: EngineState = EngineState.OFF
        private set
    @Volatile override var port: Int = 0
        private set

    private val inflight = AtomicInteger(0)
    private val lock = Any()

    override fun start() {
        synchronized(lock) {
            if (state == EngineState.STARTING || state == EngineState.READY) return
            state = EngineState.STARTING
        }
        Thread({
            try {
                AgPaths.init(ctx)
                val p = AgServer.start(ctx.applicationContext, tokenProvider)
                port = p
                state = EngineState.READY
                Log.i(TAG, "AG 引擎（Kotlin）就绪，端口 $p，数据目录 ${AgPaths.dataDir}")
            } catch (t: Throwable) {
                Log.e(TAG, "AG 引擎启动失败", t)
                port = 0
                state = EngineState.FAILED
            }
        }, "ag-engine-start").start()
    }

    override fun stop() {
        synchronized(lock) {
            if (state == EngineState.OFF || state == EngineState.DRAINING || state == EngineState.STOPPING) return
            state = EngineState.DRAINING
        }
        Thread({
            awaitIdle(30_000)
            state = EngineState.STOPPING
            try { AgServer.stop() } catch (t: Throwable) { Log.w(TAG, "停止 AG 服务异常: ${t.message}") }
            port = 0
            state = EngineState.OFF
        }, "ag-engine-stop").start()
    }

    override fun requestStart() { inflight.incrementAndGet() }
    override fun requestEnd() { inflight.decrementAndGet() }

    override fun awaitIdle(timeoutMs: Long): Boolean {
        val deadline = System.currentTimeMillis() + timeoutMs
        while (System.currentTimeMillis() < deadline) {
            if (inflight.get() <= 0) return true
            try { Thread.sleep(50) } catch (e: InterruptedException) { return inflight.get() <= 0 }
        }
        return inflight.get() <= 0
    }
}
