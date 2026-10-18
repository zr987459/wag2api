package com.wag2api.app

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder
import android.os.PowerManager
import androidx.core.app.NotificationCompat
import com.wag2api.app.engine.EngineFactory
import com.wag2api.app.engine.EngineState
import com.wag2api.app.engine.NodeEngineApi
import java.util.concurrent.atomic.AtomicInteger

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
                .edit().putInt(KEY_PORT, port).apply()
            return true
        }

        @Volatile var isRunning = false
        @Volatile private var instance: GatewayService? = null

        /** 供 UI / 引擎回调刷新通知 */
        fun refreshNotification() {
            instance?.updateNotification()
        }
    }

    private var server: LocalGatewayServer? = null
    private lateinit var engine: NodeEngineApi

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

        AccountVault.init(applicationContext)
        GatewayMetrics.init(applicationContext)
        AccountScheduler.init(applicationContext)
        TencentGateway.attach(applicationContext)
        TokenKeeper.start()          // token 后台保活
        createNotificationChannel()
        startForegroundServiceNotification()   // 必须在 startForegroundService 后 5 秒内调用

        engine = EngineFactory.create(applicationContext)
        EngineFactory.injectToken(applicationContext)

        // 前门先起来，WB 毫秒级就绪
        val listenPort = getPort(applicationContext)
        server = LocalGatewayServer(
            applicationContext, listenPort, engine,
            onBusy = ::onRequestStart,
            onIdle = ::onRequestEnd
        )
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

    private fun nodeStateLabel(): String = when (engine.state) {
        EngineState.READY -> "AG ✓"
        EngineState.STARTING -> "AG 启动中"
        EngineState.FAILED -> "AG 异常"
        EngineState.DRAINING, EngineState.STOPPING -> "AG 停止中"
        EngineState.OFF -> if (EngineFactory.SUPPORTS_NODE) "AG 已关闭" else "AG 不支持"
    }

    private fun updateNotification() {
        val nm = getSystemService(NotificationManager::class.java) ?: return
        val text = "WB ✓ · ${nodeStateLabel()} · 本地端口 :${getPort(this)}"
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
        val notification = buildNotification("WB ✓ · AG 启动中 · 本地端口 :${getPort(this)}")
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
        TokenKeeper.stop()
        try { engine.stop() } catch (ignored: Exception) {}
        server?.stop()
        isRunning = false
        instance = null
        try {
            if (wakeLock.isHeld) wakeLock.release()
        } catch (ignored: Exception) {}
    }
}
