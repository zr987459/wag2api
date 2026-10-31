package com.wag2api.app.ais

import android.app.Presentation
import android.content.Context
import android.graphics.PixelFormat
import android.hardware.display.DisplayManager
import android.hardware.display.VirtualDisplay
import android.media.ImageReader
import android.os.Handler
import android.os.Looper
import android.view.ViewGroup
import android.webkit.WebView
import android.widget.FrameLayout

/**
 * 给隐藏 WebView 一个真正的窗口：App 私有的 VirtualDisplay（画面写进 ImageReader 后直接丢弃）+ Presentation。
 * 没挂到窗口上的 WebView 不出帧，requestAnimationFrame 不触发、页面 visibilityState=hidden，AI Studio 的发送流程会卡住。
 * 私有虚拟屏不需要任何权限，也不会出现在用户屏幕上。只在主线程调用。
 */
object WebViewHost {
    const val WIDTH = 1280
    const val HEIGHT = 2000
    private var reader: ImageReader? = null
    private var display: VirtualDisplay? = null
    private var presentation: Presentation? = null
    private var root: FrameLayout? = null
    @Volatile var lastError: String? = null
        private set

    /** 返回承载 WebView 的 Context（Presentation 的），失败返回 null */
    fun context(ctx: Context): Context? {
        if (root != null) return root!!.context
        return try {
            val dm = ctx.getSystemService(Context.DISPLAY_SERVICE) as DisplayManager
            val r = ImageReader.newInstance(WIDTH, HEIGHT, PixelFormat.RGBA_8888, 2)
            r.setOnImageAvailableListener({ ir -> try { ir.acquireLatestImage()?.close() } catch (_: Throwable) {} }, Handler(Looper.getMainLooper()))
            val vd = dm.createVirtualDisplay("wag2api-ais", WIDTH, HEIGHT, 160, r.surface, 0)
            val p = Presentation(ctx, vd.display)
            val fl = FrameLayout(p.context)
            p.setContentView(fl)
            p.show()
            reader = r; display = vd; presentation = p; root = fl
            lastError = null
            fl.context
        } catch (t: Throwable) {
            lastError = t.toString()
            release()
            null
        }
    }

    fun attach(w: WebView): Boolean {
        val fl = root ?: return false
        return try {
            (w.parent as? ViewGroup)?.removeView(w)
            fl.addView(w, FrameLayout.LayoutParams(WIDTH, HEIGHT))
            true
        } catch (t: Throwable) {
            lastError = t.toString(); false
        }
    }

    fun detach(w: WebView) {
        try { (w.parent as? ViewGroup)?.removeView(w) } catch (_: Throwable) {}
        if (root?.childCount == 0) release()
    }

    private fun release() {
        try { presentation?.dismiss() } catch (_: Throwable) {}
        try { display?.release() } catch (_: Throwable) {}
        try { reader?.close() } catch (_: Throwable) {}
        presentation = null; display = null; reader = null; root = null
    }
}
