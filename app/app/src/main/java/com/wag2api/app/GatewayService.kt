package com.wag2api.app

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.net.ConnectivityManager
import android.net.Network
import android.os.Build
import android.os.IBinder
import android.os.PowerManager
import androidx.core.app.NotificationCompat
import com.wag2api.app.engine.EngineFactory
import com.wag2api.app.engine.EngineState
import com.wag2api.app.engine.NodeEngineApi
import java.net.InetAddress
import java.net.InetSocketAddress
import java.net.ServerSocket
import java.util.concurrent.atomic.AtomicInteger
import java.util.concurrent.TimeUnit
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody

/**
 * 网关守护服务：**唯一的**前台通知、悬浮球与 WakeLock 持有者。
 *
 * 启动顺序：先起前门（WB 毫秒级就绪），再异步 bind Node 引擎，Node 不阻塞前台服务启动。
 */
class GatewayService : Service() {

    companion object {
        const val CHANNEL_ID = "wag2api_gateway_channel"
        const val NOTIF_ID = 8800
        /** 默认端口，可在设置里改 */
        const val DEFAULT_PORT = 8800

        private const val PREF = "wag2api_settings"
        private const val KEY_PORT = "listen_port"

        /** 读取用户自定义端口，非法值回退默认 */
        fun getPort(ctx: Context): Int {
            val p = ctx.getSharedPreferences(PREF, Context.MODE_PRIVATE)
                .getInt(KEY_PORT, DEFAULT_PORT)
            return if (p in 1024..65535) p else DEFAULT_PORT
        }

        fun setPort(ctx: Context, port: Int): Boolean {
            if (port !in 1024..65535) return false
            ctx.getSharedPreferences(PREF, Context.MODE_PRIVATE)
                .edit().putInt(KEY_PORT, port).commit()
            return true
        }

        /** 试绑定 127.0.0.1:port 后立即释放，用于保存前判断端口是否可用 */
        fun canBind(port: Int): Boolean = try {
            ServerSocket().use {
                it.reuseAddress = true
                it.bind(InetSocketAddress(InetAddress.getByName("127.0.0.1"), port), 1)
            }
            true
        } catch (e: Exception) {
            false
        }

        /** 最近一次热切换失败的原因（已回退），GET /panel/api/settings/port 带给前端 */
        @Volatile var lastPortSwitchError: String? = null

        /**
         * 热切换前门端口：在后台线程里先在新端口起一个新的 LocalGatewayServer，成功后再停旧的；
         * 新端口起不来就保留旧前门并把设置改回旧端口。只动前门，Node AG 引擎不重启。
         * 调用方应已把响应发出去（本方法会先等一小会儿让旧连接收尾）。
         */
        fun switchFrontDoorPort(ctx: Context, newPort: Int, oldPort: Int) {
            val svc = instance
            if (svc == null) {
                // 服务不在（理论上不会，因为请求就是它的前门收的）：只保存，下次启动生效
                return
            }
            lastPortSwitchError = null
            svc.restartFrontDoor(newPort, oldPort)
        }

        private const val KEY_GATEWAY_ON = "gateway_enabled"

        /** 网关总开关：关闭后前门停止监听，客户端全部断开 */
        fun isGatewayEnabled(ctx: Context): Boolean =
            ctx.getSharedPreferences(PREF, Context.MODE_PRIVATE)
                .getBoolean(KEY_GATEWAY_ON, true)

        /**
         * 开关网关。
         * 数据面开关：关闭时在分流层拒绝对外推理 API（返回 503），但控制面与本地管理控制台保持常驻运行，
         * 绝不停止前门 HTTP 服务，确保 App 内嵌 WebView 绝不会断网或崩溃。
         * @return 操作后的状态
         */
        fun setGatewayEnabled(ctx: Context, enabled: Boolean): Boolean {
            ctx.getSharedPreferences(PREF, Context.MODE_PRIVATE)
                .edit().putBoolean(KEY_GATEWAY_ON, enabled).apply()
            instance?.updateNotification()
            return enabled
        }

        @Volatile var isRunning = false
        @Volatile private var instance: GatewayService? = null

        /** 供 UI / 引擎回调刷新通知 */
        fun refreshNotification() {
            instance?.updateNotification()
        }
    }

    @Volatile private var server: LocalGatewayServer? = null
    private val frontDoorLock = Any()

    private fun newFrontDoor(port: Int) = LocalGatewayServer(
        applicationContext, port, engine,
        onBusy = ::onRequestStart,
        onIdle = ::onRequestEnd
    )

    /** 见 [switchFrontDoorPort] */
    private fun restartFrontDoor(newPort: Int, oldPort: Int) {
        Thread({
            try { Thread.sleep(300) } catch (ignored: InterruptedException) {}
            synchronized(frontDoorLock) {
                val old = server
                if (old != null && old.listenPort == newPort && old.isListening) return@synchronized
                val next = newFrontDoor(newPort)
                var started = next.startBlocking()
                if (!started) {
                    // 检查到真正绑定之间端口可能被抢，稍后再试一次
                    try { Thread.sleep(300) } catch (ignored: InterruptedException) {}
                    started = next.startBlocking()
                }
                if (started) {
                    server = next
                    old?.stop()
                    lastPortSwitchError = null
                } else {
                    // 新端口起不来：旧前门本来就没停，只把设置改回去
                    setPort(applicationContext, oldPort)
                    lastPortSwitchError = "端口 $newPort 启动失败，已回退到 $oldPort"
                    if (old == null || !old.isListening) {
                        val back = newFrontDoor(oldPort)
                        if (back.startBlocking()) server = back
                    }
                }
            }
            updateNotification()
        }, "FrontDoorPortSwitch").start()
    }
    private lateinit var engine: NodeEngineApi

    // PR4：网络恢复 / 切换时通知 Node 预热（token + projectId + 上游 TLS 连接），省掉下一次请求的握手
    private var netCallback: ConnectivityManager.NetworkCallback? = null
    @Volatile private var lastPrewarmAt = 0L
    private val prewarmClient by lazy {
        OkHttpClient.Builder().connectTimeout(2, TimeUnit.SECONDS).readTimeout(20, TimeUnit.SECONDS).build()
    }

    private fun triggerPrewarm(reason: String) {
        if (!::engine.isInitialized || engine.state != EngineState.READY) return
        val now = System.currentTimeMillis()
        if (now - lastPrewarmAt < 3_000L) return
        lastPrewarmAt = now
        val p = engine.port
        if (p <= 0) return
        Thread {
            try {
                Thread.sleep(1_500L)   // 等新网络的路由 / DNS 稳定
                val req = Request.Builder()
                    .url("http://127.0.0.1:$p/api/prewarm")
                    .header("X-Engine-Token", EngineTokenHolder.token)
                    .post("{\"reason\":\"$reason\"}".toRequestBody("application/json".toMediaType()))
                    .build()
                prewarmClient.newCall(req).execute().close()
            } catch (ignored: Exception) {}
        }.start()
    }

    private fun registerNetworkPrewarm() {
        val cm = getSystemService(ConnectivityManager::class.java) ?: return
        val cb = object : ConnectivityManager.NetworkCallback() {
            override fun onAvailable(network: Network) { triggerPrewarm("network") }
        }
        try {
            cm.registerDefaultNetworkCallback(cb)
            netCallback = cb
        } catch (ignored: Exception) {}
    }

    private fun unregisterNetworkPrewarm() {
        val cb = netCallback ?: return
        try { getSystemService(ConnectivityManager::class.java)?.unregisterNetworkCallback(cb) } catch (ignored: Exception) {}
        netCallback = null
    }

    /**
     * 只在「有请求在处理」时持有 WakeLock，空闲立即释放：
     * 熄屏后长思考/长输出不会被挂起，平时也不白白耗电。
     */
    private val activeRequests = AtomicInteger(0)
    private val wakeLock: PowerManager.WakeLock by lazy {
        (getSystemService(Context.POWER_SERVICE) as PowerManager)
            .newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "wag2api:gateway")
            .apply { setReferenceCounted(false) }
    }

    private fun onRequestStart() {
        activeRequests.incrementAndGet()
        try {
            wakeLock.acquire(10 * 60 * 1000L)
        } catch (ignored: Exception) {}
    }

    private fun onRequestEnd() {
        if (activeRequests.decrementAndGet() <= 0) {
            activeRequests.set(0)
            try {
                if (wakeLock.isHeld) wakeLock.release()
            } catch (ignored: Exception) {}
        }
    }

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onCreate() {
        super.onCreate()
        instance = this

        GatewayMetrics.init(applicationContext)
        createNotificationChannel()
        startForegroundServiceNotification()   // 必须在 startForegroundService 后 5 秒内调用

        // AIS 引擎启动（两个 flavor 都启动）
        AisEngine.start(applicationContext)
        Thread({
            val deadline = System.currentTimeMillis() + 30_000
            while (System.currentTimeMillis() < deadline && !AisEngine.isRunning()) {
                Thread.sleep(500)
            }
            if (AisEngine.isRunning()) {
                EngineRouter.syncAisModels(applicationContext)
            }
            updateNotification()
        }, "Ais-ModelSync-Init").apply {
            isDaemon = true
            start()
        }

        engine = EngineFactory.create(applicationContext)
        EngineFactory.injectToken(applicationContext)

        // 前门服务启动，管理面板始终保持可用
        val listenPort = getPort(applicationContext)
        server = newFrontDoor(listenPort)
        server?.start()
        isRunning = true

        // Node 引擎异步启动，不阻塞前台服务
        if (EngineFactory.SUPPORTS_NODE && isNodeEnabled()) {
            Thread {
                try {
                    wakeLock.acquire(30_000L)   // 首次 AssetCopier 复制文件较慢，短时保活
                } catch (ignored: Exception) {}
                engine.start()

                // 等就绪后拉模型表，落盘缓存
                val deadline = System.currentTimeMillis() + 30_000
                while (System.currentTimeMillis() < deadline && engine.state != EngineState.READY) {
                    Thread.sleep(200)
                }
                if (engine.state == EngineState.READY) {
                    EngineRouter.syncNodeModels(
                        applicationContext, engine, EngineTokenHolder.token
                    )
                }

                try { if (wakeLock.isHeld) wakeLock.release() } catch (ignored: Exception) {}
                updateNotification()
            }.start()
        }
        registerNetworkPrewarm()
        updateNotification()
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int = START_STICKY

    private fun isNodeEnabled(): Boolean =
        getSharedPreferences("wag2api_router", Context.MODE_PRIVATE)
            .getBoolean("node_enabled", true)

    private fun createNotificationChannel() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val channel = NotificationChannel(
                CHANNEL_ID,
                "wag2api 网关守护",
                NotificationManager.IMPORTANCE_DEFAULT
            ).apply {
                description = "保持 wag2api 双引擎网关在后台持续运行"
                setShowBadge(true)
            }
            getSystemService(NotificationManager::class.java)?.createNotificationChannel(channel)
        }
    }

    private fun aisStateLabel(): String = when {
        AisEngine.isRunning() -> "AIS ✓"
        AisEngine.isAvailable(this) -> "AIS 启动中"
        else -> "AIS 未安装"
    }

    private fun nodeStateLabel(): String = when (engine.state) {
        EngineState.READY -> "AG ✓"
        EngineState.STARTING -> "AG 启动中"
        EngineState.FAILED -> "AG 异常"
        EngineState.DRAINING, EngineState.STOPPING -> "AG 停止中"
        EngineState.OFF -> if (EngineFactory.SUPPORTS_NODE) "AG 已关闭" else "AG 不支持"
    }

    private fun updateNotification() {
        val nm = getSystemService(NotificationManager::class.java) ?: return
        val on = isGatewayEnabled(this)
        val text = if (!on) {
            "网关已暂停 · 控制台运行中 (点按打开)"
        } else {
            "${aisStateLabel()} · ${nodeStateLabel()} · 本地端口 :${server?.listenPort ?: getPort(this)}"
        }
        nm.notify(NOTIF_ID, buildNotification(text))
    }

    private fun buildNotification(text: String): Notification {
        val launchIntent = packageManager.getLaunchIntentForPackage(packageName)
        val pendingIntent = PendingIntent.getActivity(
            this, 0, launchIntent,
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT
        )
        return NotificationCompat.Builder(this, CHANNEL_ID)
            .setContentTitle("wag2api 网关运行中")
            .setContentText(text)
            .setSmallIcon(R.drawable.ic_launcher)
            .setContentIntent(pendingIntent)
            .setOngoing(true)
            .setPriority(NotificationCompat.PRIORITY_DEFAULT)
            .setVisibility(NotificationCompat.VISIBILITY_PUBLIC)
            .build()
    }

    private fun startForegroundServiceNotification() {
        val notification = buildNotification("网关服务启动中 · 本地端口 :${getPort(this)}")
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
            // Android 14+ 要求显式声明 specialUse，否则后台启动会被拒
            startForeground(NOTIF_ID, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE)
        } else if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            startForeground(NOTIF_ID, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC)
        } else {
            startForeground(NOTIF_ID, notification)
        }
    }

    override fun onDestroy() {
        super.onDestroy()
        AisEngine.stop()
        unregisterNetworkPrewarm()
        try { engine.stop() } catch (ignored: Exception) {}
        server?.stop()
        isRunning = false
        instance = null
        try {
            if (wakeLock.isHeld) wakeLock.release()
        } catch (ignored: Exception) {}
    }
}
