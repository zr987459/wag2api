package com.wag2api.app

import android.util.Log
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONObject
import java.security.MessageDigest
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.TimeUnit

/**
 * Token 保活。
 *
 * 刷新协议对齐上游参考实现 workbuddy2api（internal/upstream/client.go RefreshToken +
 * headers.go RefreshHeaders）：
 *   POST {base}/v2/plugin/auth/token/refresh   （无 body）
 *   X-Refresh-Token: <refreshToken>
 *   X-Auth-Refresh-Source: plugin
 *   + 通用头（UA / Origin / Referer / X-CodeBuddy-Request / Accept-Language / X-Machine-ID / X-Session-ID）
 *   响应信封 {code:0, data:{accessToken, refreshToken, expiresIn, domain}}，
 *   accessToken / refreshToken 成对轮换，expiresIn 实测 5184000（60 天）。
 *
 * 因此不需要 30 分钟刷一次：后台每 6 小时巡检一轮；401 时按需刷新（60s 内同号去重）。
 */
object TokenKeeper {

    private const val TAG = "TokenKeeper"

    /** 后台巡检间隔：token 有效期 60 天，6 小时足够 */
    private const val SWEEP_INTERVAL_MS = 6 * 60 * 60 * 1000L
    /** 同一账号非强制刷新的最短间隔（防 401 风暴把同一个号刷 N 次） */
    private const val MIN_REFRESH_GAP_MS = 60_000L

    private val client = OkHttpClient.Builder()
        .connectTimeout(15, TimeUnit.SECONDS)
        .readTimeout(30, TimeUnit.SECONDS)
        .build()

    private val lastRefreshAt = ConcurrentHashMap<String, Long>()
    private val uidLocks = ConcurrentHashMap<String, Any>()

    @Volatile private var worker: Thread? = null

    @Synchronized
    fun start() {
        if (worker?.isAlive == true) return
        worker = Thread({
            // 启动后先等一轮，不在每次服务重启时立刻全量刷新
            while (!Thread.currentThread().isInterrupted) {
                try {
                    Thread.sleep(SWEEP_INTERVAL_MS)
                    refreshAll()
                } catch (e: InterruptedException) {
                    break
                } catch (e: Exception) {
                    Log.w(TAG, "保活循环异常: ${e.message}")
                }
            }
        }, "token-keeper").apply { isDaemon = true; start() }
    }

    @Synchronized
    fun stop() {
        worker?.interrupt()
        worker = null
    }

    /** 遍历所有账号续期；只读一次账号表，逐个传对象进去 */
    fun refreshAll(): Int {
        val accounts = AccountVault.getAccounts()
        var ok = 0
        for (i in 0 until accounts.length()) {
            val a = accounts.optJSONObject(i) ?: continue
            if (a.optBoolean("disabled", false)) continue
            if (a.optString("uid").isEmpty() || a.optString("refreshToken").isEmpty()) continue
            if (refresh(a, force = true)) ok++
        }
        return ok
    }

    /**
     * 按 uid 刷新。force=false（401 路径）时，60s 内已刷新过就直接返回 true，
     * 让调用方用最新 token 重试，而不是再打一次刷新接口。
     */
    fun refreshIfPossible(uid: String, force: Boolean = false): Boolean {
        val accounts = AccountVault.getAccounts()
        for (i in 0 until accounts.length()) {
            val a = accounts.optJSONObject(i) ?: continue
            if (a.optString("uid") == uid) return refresh(a, force)
        }
        return false
    }

    private fun refresh(acc: JSONObject, force: Boolean): Boolean {
        val uid = acc.optString("uid")
        // 同一账号串行化：并发 401 只会有一个真正去刷新，其余等它结束后命中 MIN_REFRESH_GAP_MS
        synchronized(uidLocks.getOrPut(uid) { Any() }) {
            val last = lastRefreshAt[uid] ?: 0L
            if (!force && System.currentTimeMillis() - last < MIN_REFRESH_GAP_MS) return true
            val ok = doRefresh(acc)
            if (ok) lastRefreshAt[uid] = System.currentTimeMillis()
            return ok
        }
    }

    private fun doRefresh(accSnapshot: JSONObject): Boolean {
        val uid = accSnapshot.optString("uid")
        // 锁内重新读一次，拿可能已被别的线程轮换过的最新 refreshToken
        val acc = currentAccount(uid) ?: accSnapshot
        val refresh = acc.optString("refreshToken")
        if (refresh.isEmpty()) return false

        val realm = acc.optString("realm", "global")
        val base = if (realm == "cn") TencentGateway.UPSTREAM_CN else TencentGateway.UPSTREAM_GLOBAL

        return try {
            val req = Request.Builder()
                .url("$base/v2/plugin/auth/token/refresh")
                .header("Content-Type", "application/json")
                .header("Accept", "application/json")
                .header("X-Requested-With", "XMLHttpRequest")
                .header("User-Agent", TencentGateway.CLIENT_UA)
                .header("Origin", base)
                .header("Referer", "$base/")
                .header("X-CodeBuddy-Request", "1")
                .header("Accept-Language", if (realm == "global") "en-US" else "zh-CN")
                .header("X-Machine-ID", sha256Prefix("wb2a:machine:$uid"))
                .header("X-Session-ID", sha256Prefix("wb2a:session:$uid"))
                .header("X-Refresh-Token", refresh)
                .header("X-Auth-Refresh-Source", "plugin")
                .post(ByteArray(0).toRequestBody(null))
                .build()

            client.newCall(req).execute().use { resp ->
                val text = resp.body?.string().orEmpty()
                if (!resp.isSuccessful) {
                    Log.w(TAG, "刷新 $uid HTTP ${resp.code}: ${text.take(200)}")
                    return false
                }
                val o = try { JSONObject(text) } catch (e: Exception) { return false }
                if (o.has("code") && o.optInt("code", -1) != 0) {
                    Log.w(TAG, "刷新 $uid code=${o.opt("code")}: ${o.optString("msg").take(200)}")
                    return false
                }
                val data = o.optJSONObject("data") ?: o
                val newAccess = data.optString("accessToken").ifEmpty { data.optString("access_token") }
                val newRefresh = data.optString("refreshToken").ifEmpty { data.optString("refresh_token") }
                if (newAccess.isEmpty()) return false
                AccountVault.updateTokens(uid, newAccess, newRefresh.ifEmpty { null })
                Log.i(TAG, "账号 $uid token 已续期")
                true
            }
        } catch (e: Exception) {
            Log.w(TAG, "刷新 $uid 异常: ${e.message}")
            false
        }
    }

    private fun currentAccount(uid: String): JSONObject? {
        val all = AccountVault.getAccounts()
        for (i in 0 until all.length()) {
            val a = all.optJSONObject(i) ?: continue
            if (a.optString("uid") == uid) return a
        }
        return null
    }

    private fun sha256Prefix(text: String): String {
        val bytes = MessageDigest.getInstance("SHA-256").digest(text.toByteArray(Charsets.UTF_8))
        return bytes.joinToString("") { "%02x".format(it) }.take(36)
    }
}
