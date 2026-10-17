package org.agopen.gateway

import android.app.Activity
import android.app.AlertDialog
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.provider.Settings
import android.widget.Toast
import androidx.core.content.FileProvider
import org.json.JSONObject
import java.io.File
import java.net.HttpURLConnection
import java.net.URL

/** 检查更新：读 GitHub Releases 最新版本，带 AGOpen.apk 且版本更高就下载安装 */
object Updater {
    const val REPO = "zr987459/wag2api"
    const val ASSET = "AGOpen.apk"
    @Volatile private var apkUrl = ""

    /** "1.2.3" 比较，a > b 返回 true */
    private fun newer(a: String, b: String): Boolean {
        val x = a.trimStart('v', 'V').split('.').map { it.toIntOrNull() ?: 0 }
        val y = b.trimStart('v', 'V').split('.').map { it.toIntOrNull() ?: 0 }
        for (i in 0 until maxOf(x.size, y.size)) {
            val p = x.getOrElse(i) { 0 }; val q = y.getOrElse(i) { 0 }
            if (p != q) return p > q
        }
        return false
    }
    @Volatile private var busy = false

    fun check(act: Activity, manual: Boolean) {
        if (busy) return
        busy = true
        if (manual) Toast.makeText(act, "正在检查更新…", Toast.LENGTH_SHORT).show()
        Thread {
            try {
                val c = URL("https://api.github.com/repos/$REPO/releases/latest").openConnection() as HttpURLConnection
                c.setRequestProperty("Accept", "application/vnd.github+json")
                c.connectTimeout = 40000; c.readTimeout = 40000
                val j = JSONObject(c.inputStream.bufferedReader().readText())
                val name = j.optString("tag_name", "").removePrefix("open-")
                val notes = j.optString("body", "")
                val assets = j.optJSONArray("assets")
                var url = ""
                if (assets != null) for (i in 0 until assets.length()) {
                    val a = assets.getJSONObject(i)
                    if (a.optString("name") == ASSET) url = a.optString("browser_download_url")
                }
                apkUrl = url
                val hasNew = url.isNotEmpty() && newer(name, BuildConfig.VERSION_NAME)
                act.runOnUiThread {
                    busy = false
                    if (hasNew) {
                        AlertDialog.Builder(act)
                            .setTitle("发现新版本 $name")
                            .setMessage(if (notes.isNotEmpty()) notes else "当前 ${BuildConfig.VERSION_NAME}，更新后账号和设置都会保留。")
                            .setPositiveButton("更新") { _, _ -> download(act) }
                            .setNegativeButton("以后", null)
                            .show()
                    } else if (manual) {
                        Toast.makeText(act, "已经是最新版 ${BuildConfig.VERSION_NAME}", Toast.LENGTH_SHORT).show()
                    }
                }
            } catch (e: Exception) {
                busy = false
                if (manual) act.runOnUiThread { Toast.makeText(act, "检查失败，稍后再试", Toast.LENGTH_SHORT).show() }
            }
        }.start()
    }

    private fun download(act: Activity) {
        if (Build.VERSION.SDK_INT >= 26 && !act.packageManager.canRequestPackageInstalls()) {
            Toast.makeText(act, "请允许安装未知应用，然后再点一次更新", Toast.LENGTH_LONG).show()
            try { act.startActivity(Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES, Uri.parse("package:${act.packageName}"))) } catch (e: Exception) {}
            return
        }
        val dlg = AlertDialog.Builder(act).setTitle("正在下载").setMessage("0%").setCancelable(false).show()
        Thread {
            try {
                val dir = File(act.cacheDir, "updates").apply { mkdirs() }
                val out = File(dir, ASSET)
                val c = URL(apkUrl).openConnection() as HttpURLConnection
                c.instanceFollowRedirects = true
                c.connectTimeout = 40000; c.readTimeout = 60000
                val total = c.contentLengthLong
                var done = 0L; var last = -1
                c.inputStream.use { input ->
                    out.outputStream().use { o ->
                        val buf = ByteArray(64 * 1024)
                        while (true) {
                            val n = input.read(buf); if (n < 0) break
                            o.write(buf, 0, n); done += n
                            val pct = if (total > 0) (done * 100 / total).toInt() else 0
                            if (pct != last) { last = pct; act.runOnUiThread { dlg.setMessage("$pct%") } }
                        }
                    }
                }
                act.runOnUiThread {
                    dlg.dismiss()
                    val uri = FileProvider.getUriForFile(act, "${act.packageName}.files", out)
                    act.startActivity(Intent(Intent.ACTION_VIEW).apply {
                        setDataAndType(uri, "application/vnd.android.package-archive")
                        addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_ACTIVITY_NEW_TASK)
                    })
                }
            } catch (e: Exception) {
                act.runOnUiThread { dlg.dismiss(); Toast.makeText(act, "下载失败，稍后再试", Toast.LENGTH_SHORT).show() }
            }
        }.start()
    }
}
