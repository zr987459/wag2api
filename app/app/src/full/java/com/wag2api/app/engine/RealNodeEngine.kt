package com.wag2api.app.engine

import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.content.ServiceConnection
import android.os.IBinder
import android.util.Log
import com.wag2api.engine.INodeEngine
import com.wag2api.engine.NodeService
import okhttp3.OkHttpClient
import okhttp3.Request
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger

/**
 * full 包：真实 Node 引擎。
 *
 * 生命周期要点：
 *  - :node 被系统杀掉时，BIND_AUTO_CREATE 会自动重建并再次回调 onServiceConnected，宿主不要手动 rebind
 *  - 宿主只做熔断：30s 内崩 3 次就 unbind 并标记 FAILED，防止一直重启耗电
 */
class RealNodeEngine(
    private val ctx: Context,
    private val tokenProvider: () -> String
) : NodeEngineApi {

    companion object {
        private const val TAG = "RealNodeEngine"
        private const val CRASH_WINDOW_MS = 30_000L
        private const val CRASH_LIMIT = 3
    }

    @Volatile override var state: EngineState = EngineState.OFF
        private set
    @Volatile override var port: Int = 0
        private set

    private var conn: ServiceConnection? = null
    private var binder: INodeEngine? = null
    private val inflight = AtomicInteger(0)
    private var exited = CountDownLatch(1)

    private val crashTimes = ArrayDeque<Long>()

    override fun start() {
        if (state == EngineState.STARTING || state == EngineState.READY) return
        state = EngineState.STARTING
        exited = CountDownLatch(1)

        val c = object : ServiceConnection {
            override fun onServiceConnected(name: ComponentName?, service: IBinder?) {
                binder = INodeEngine.Stub.asInterface(service)
                port = try { binder?.getPort() ?: 0 } catch (e: Exception) { 0 }
                // Binder 连通不代表 Node 已能服务，还要等 /health 返回 200
                state = EngineState.STARTING
                waitHealthy(port)
            }

            override fun onServiceDisconnected(name: ComponentName?) {
                binder = null
                port = 0
                exited.countDown()
                if (state == EngineState.STOPPING || state == EngineState.DRAINING) {
                    state = EngineState.OFF
                } else {
                    // 系统重建中：保持 STARTING，等下一次 onServiceConnected
                    state = EngineState.STARTING
                    onCrash()
                }
            }
        }
        conn = c

        try {
            val ok = ctx.bindService(
                Intent(ctx, NodeService::class.java),
                c,
                Context.BIND_AUTO_CREATE
            )
            if (!ok) {
                state = EngineState.FAILED
                Log.e(TAG, "bindService 返回 false")
            }
        } catch (e: Exception) {
            state = EngineState.FAILED
            Log.e(TAG, "bindService 异常", e)
        }
    }

    /**
     * 轮询内部 /health，确认 Node 真正能服务后才标记 READY。
     * 避免冷启动 2~5 秒内的请求拿到 502。
     */
    private fun waitHealthy(p: Int) {
        if (p <= 0) {
            state = EngineState.FAILED
            return
        }
        Thread({
            val client = OkHttpClient.Builder()
                .connectTimeout(2, TimeUnit.SECONDS)
                .readTimeout(2, TimeUnit.SECONDS)
                .build()
            val deadline = System.currentTimeMillis() + 30_000
            var ok = false
            while (System.currentTimeMillis() < deadline) {
                if (state == EngineState.STOPPING || state == EngineState.DRAINING) return@Thread
                try {
                    val req = Request.Builder()
                        .url("http://127.0.0.1:$p/health")
                        .header("X-Engine-Token", tokenProvider())
                        .get().build()
                    val code = client.newCall(req).execute().use { it.code }
                    if (code == 200) { ok = true; break }
                } catch (ignored: Exception) {}
                Thread.sleep(250)
            }
            if (ok) {
                state = EngineState.READY
                Log.i(TAG, "Node 引擎就绪，端口 $p")
            } else {
                Log.e(TAG, "Node 引擎健康检查超时")
                state = EngineState.FAILED
            }
        }, "node-health").start()
    }

    private fun onCrash() {
        val now = System.currentTimeMillis()
        crashTimes.addLast(now)
        while (crashTimes.isNotEmpty() && now - crashTimes.first() > CRASH_WINDOW_MS) {
            crashTimes.removeFirst()
        }
        if (crashTimes.size >= CRASH_LIMIT) {
            Log.e(TAG, "30s 内崩溃 ${crashTimes.size} 次，熔断")
            crashTimes.clear()
            unbind()
            state = EngineState.FAILED
        }
    }

    override fun stop() {
        if (state == EngineState.OFF) return
        state = EngineState.DRAINING
        Thread {
            awaitIdle(30_000)
            state = EngineState.STOPPING
            val pid = try { binder?.getPid() ?: 0 } catch (e: Exception) { 0 }
            if (pid > 0) {
                try { android.os.Process.sendSignal(pid, 15) } catch (ignored: Exception) {}
            }
            exited.await(5, TimeUnit.SECONDS)
            unbind()
            if (pid > 0) {
                try { android.os.Process.killProcess(pid) } catch (ignored: Exception) {}
            }
            port = 0
            state = EngineState.OFF
        }.start()
    }

    private fun unbind() {
        conn?.let {
            try { ctx.unbindService(it) } catch (ignored: Exception) {}
        }
        conn = null
        binder = null
    }

    override fun requestStart() { inflight.incrementAndGet() }
    override fun requestEnd() { inflight.decrementAndGet() }

    override fun awaitIdle(timeoutMs: Long): Boolean {
        val deadline = System.currentTimeMillis() + timeoutMs
        while (System.currentTimeMillis() < deadline) {
            if (inflight.get() <= 0) return true
            Thread.sleep(50)
        }
        return inflight.get() <= 0
    }
}
