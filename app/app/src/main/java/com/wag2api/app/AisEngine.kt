package com.wag2api.app

import android.content.Context
import com.wag2api.app.ais.WebViewAisEngine
import java.io.File

/**
 * AIS 引擎入口（只剩 WebView 版，见 [WebViewAisEngine]）。
 * 进程内服务监听 127.0.0.1:8820；EngineRouter / LocalGatewayServer / GatewayService 通过这里启停和查询。
 * WebView 按需创建，所以启动本身开销很小；设置里的 AIS 开关关闭时整个服务停掉（账号数据保留）。
 */
object AisEngine {
    const val baseUrl = "http://127.0.0.1:${WebViewAisEngine.PORT}"

    private const val PREF = "wag2api_router"
    /** WebView 版的开关，默认开（旧 Go 版的 ais_enabled 默认关、只表示“没账号也启动”，语义不同，不沿用） */
    private const val KEY_AIS_ON = "ais_webview_on"

    @Volatile private var appContext: Context? = null

    private fun engine(ctx: Context? = null): WebViewAisEngine? {
        val c = ctx ?: appContext
        return if (c != null) WebViewAisEngine.get(c) else WebViewAisEngine.peek()
    }

    /**
     * AIS 是否可用。不带 ctx 的调用来自转发入口（EngineRouter.proxyToAis）：开关开着但服务没起时顺手拉起，
     * 这样控制台添加第一个账号的请求也能打到 AIS。
     */
    fun isAvailable(ctx: Context? = null): Boolean {
        val c = ctx ?: appContext ?: return false
        if (!isEnabledInSettings(c)) return false
        if (ctx == null && !isRunning()) ensureStarted(c)
        return true
    }

    /** 已有 AIS 账号：ais/auth 下存在带 storage-state.json 的账号目录 */
    fun hasAccounts(ctx: Context): Boolean {
        val dirs = File(ctx.filesDir, "ais/auth").listFiles() ?: return false
        return dirs.any { it.isDirectory && !it.name.startsWith(".") && File(it, "storage-state.json").isFile }
    }

    fun isEnabledInSettings(ctx: Context): Boolean =
        ctx.getSharedPreferences(PREF, Context.MODE_PRIVATE).getBoolean(KEY_AIS_ON, true)

    /** 设置里开关 AIS：开启立即启动，关闭立即停止（销毁所有 WebView） */
    fun setEnabled(ctx: Context, on: Boolean) {
        val app = ctx.applicationContext
        app.getSharedPreferences(PREF, Context.MODE_PRIVATE).edit().putBoolean(KEY_AIS_ON, on).apply()
        if (on) ensureStarted(app) else stop()
    }

    fun shouldAutoStart(ctx: Context): Boolean = isEnabledInSettings(ctx)

    /** GatewayService 启动时调用 */
    fun startIfNeeded(ctx: Context): Boolean {
        val app = ctx.applicationContext
        appContext = app
        if (!shouldAutoStart(app)) return false
        start(app)
        return true
    }

    /** 按需启动；启动后后台同步一次模型表（有账号时会创建 WebView） */
    fun ensureStarted(ctx: Context, waitMs: Long = 0L): Boolean {
        val app = ctx.applicationContext
        if (isRunning()) return true
        start(app)
        if (hasAccounts(app)) {
            Thread({ EngineRouter.syncAisModels(app) }, "Ais-ModelSync-OnDemand").apply { isDaemon = true; start() }
        }
        return if (waitMs > 0) waitPort(waitMs) else isRunning()
    }

    /** 进程内服务，start() 返回时端口已经绑定好 */
    fun waitPort(timeoutMs: Long): Boolean {
        val deadline = System.currentTimeMillis() + timeoutMs
        while (System.currentTimeMillis() < deadline) {
            if (isRunning()) return true
            try { Thread.sleep(100) } catch (ie: InterruptedException) { return false }
        }
        return isRunning()
    }

    fun isRunning(): Boolean = engine()?.isServing == true

    fun start(ctx: Context) {
        val app = ctx.applicationContext
        appContext = app
        engine(app)?.start()
    }

    fun stop() {
        engine()?.stop()
    }

    fun getLogs(): List<String> = engine()?.getLogs() ?: emptyList()
}
