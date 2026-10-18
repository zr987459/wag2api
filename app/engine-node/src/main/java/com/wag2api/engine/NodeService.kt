package com.wag2api.engine

import android.app.Service
import android.content.Intent
import android.os.Build
import android.os.IBinder
import android.util.Log
import java.io.File
import java.net.ServerSocket

/**
 * Node 引擎常驻服务，跑在独立进程 `:node`。
 *
 * 设计要点（与上游 wag2api 的差异）：
 *  - **不持有任何通知 / 悬浮球 / WakeLock**，全部交给宿主 GatewayService 统一管理
 *  - 端口由本进程随机选取后通过 Binder 回传，避免系统重建进程后拿到过期端口
 *  - 只监听 127.0.0.1，并要求 ENGINE_TOKEN，防止手机上其他 App 直连绕过前门
 */
class NodeService : Service() {

    companion object {
        private const val TAG = "Wag2apiNode"

        @Volatile
        var started = false
            private set

        init {
            System.loadLibrary("node")
            System.loadLibrary("native-lib")
        }
    }

    private external fun startNode(
        args: Array<String>,
        envs: Array<String>,
        rootDir: String
    ): Int

    private val binder = object : INodeEngine.Stub() {
        override fun getPort(): Int = boundPort
        override fun getPid(): Int = nodePid
        override fun isReady(): Boolean = ready
        override fun shutdown() {
            // 由宿主调用：走正常退出，让 Node 有机会 flush
            stopSelf()
        }
    }

    @Volatile private var boundPort: Int = 0
    @Volatile private var nodePid: Int = 0
    @Volatile private var ready = false
    private var thread: Thread? = null

    override fun onBind(intent: Intent?): IBinder = binder

    override fun onCreate() {
        super.onCreate()
        startGateway()
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int = START_NOT_STICKY

    private fun startGateway() {
        if (started) return
        started = true

        val root = File(filesDir, "gateway")
        val versionTag = "${BuildConfig.VERSION_CODE}-" +
                packageManager.getPackageInfo(packageName, 0).lastUpdateTime
        AssetCopier.sync(applicationContext, root, versionTag)

        // 随机端口：绑定 0 号端口拿到系统分配值后立即释放，再交给 Node
        boundPort = try {
            ServerSocket(0, 0, java.net.InetAddress.getByName("127.0.0.1")).use { it.localPort }
        } catch (e: Exception) {
            Log.e(TAG, "无法分配端口", e)
            started = false
            return
        }

        val token = EngineToken.get(applicationContext)
        val env = arrayOf(
            "PORT=$boundPort",
            "HOST=127.0.0.1",
            "ENGINE_TOKEN=$token",
            "DATA_DIR=${File(root, "data").absolutePath}",
            "HOME=${filesDir.absolutePath}",
            "TMPDIR=${cacheDir.absolutePath}",
            "NODE_ENV=production",
            "APP_VERSION=${BuildConfig.VERSION_NAME}"
        )

        thread = Thread(name = "node-engine") {
            try {
                nodePid = android.os.Process.myPid()
                ready = true
                Log.i(TAG, "Node 引擎启动于 127.0.0.1:$boundPort")
                startNode(emptyArray(), env, root.absolutePath)
            } catch (t: Throwable) {
                Log.e(TAG, "Node 引擎异常退出", t)
            } finally {
                ready = false
                started = false
            }
        }.also { it.start() }
    }

    override fun onDestroy() {
        ready = false
        started = false
        super.onDestroy()
        // 让 Node 有机会处理 SIGTERM；宿主侧还有 killProcess 兜底
        android.os.Process.killProcess(android.os.Process.myPid())
    }
}
