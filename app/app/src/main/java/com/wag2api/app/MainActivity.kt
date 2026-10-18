package com.wag2api.app

import android.annotation.SuppressLint
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.view.KeyEvent
import android.webkit.*
import androidx.appcompat.app.AppCompatActivity
import java.net.Socket

class MainActivity : AppCompatActivity() {

    private lateinit var webView: WebView
    private val handler = Handler(Looper.getMainLooper())

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        // 启动统一网关守护服务（前门 + 双引擎）
        val serviceIntent = Intent(this, GatewayService::class.java)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            startForegroundService(serviceIntent)
        } else {
            startService(serviceIntent)
        }

        // Android 13+ 请求通知权限，确保状态栏常驻图标正常显示
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            if (checkSelfPermission(android.Manifest.permission.POST_NOTIFICATIONS)
                != android.content.pm.PackageManager.PERMISSION_GRANTED) {
                requestPermissions(arrayOf(android.Manifest.permission.POST_NOTIFICATIONS), 101)
            }
        }

        webView = WebView(this).apply {
            settings.apply {
                javaScriptEnabled = true
                domStorageEnabled = true
                databaseEnabled = true
                allowFileAccess = true
                allowContentAccess = true
                mixedContentMode = WebSettings.MIXED_CONTENT_ALWAYS_ALLOW
                useWideViewPort = true
                loadWithOverviewMode = true
                cacheMode = WebSettings.LOAD_NO_CACHE
            }
            clearCache(true)
            webChromeClient = WebChromeClient()
            webViewClient = object : WebViewClient() {
                override fun shouldOverrideUrlLoading(
                    view: WebView?,
                    request: WebResourceRequest?
                ): Boolean {
                    val url = request?.url?.toString() ?: return false
                    // 官方授权链接跳出到系统浏览器完成登录
                    if (url.startsWith("https://copilot.tencent.com") ||
                        url.startsWith("https://www.workbuddy.ai") ||
                        url.startsWith("https://accounts.google.com") ||
                        url.startsWith("https://oauth2")) {
                        startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(url)))
                        return true
                    }
                    return false
                }
            }
        }

        setContentView(webView)
        waitForServerAndLoad()
    }

    private fun waitForServerAndLoad() {
        Thread {
            for (i in 1..40) {
                try {
                    Socket("127.0.0.1", GatewayService.PORT).close()
                    break
                } catch (e: Exception) {
                    Thread.sleep(150)
                }
            }
            handler.post {
                // 直接访问本地前门，100% 同源，零跨域阻断
                webView.loadUrl("http://127.0.0.1:${GatewayService.PORT}/")
            }
        }.start()
    }

    override fun onKeyDown(keyCode: Int, event: KeyEvent?): Boolean {
        if (keyCode == KeyEvent.KEYCODE_BACK) {
            if (webView.canGoBack()) {
                webView.goBack()
                return true
            }
            // 返回键切后台守护，不销毁 Activity，让前台服务持续常驻
            moveTaskToBack(true)
            return true
        }
        return super.onKeyDown(keyCode, event)
    }

    override fun onDestroy() {
        super.onDestroy()
        webView.destroy()
    }
}
