package com.wag2api.app

import android.util.Log
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONObject
import java.util.UUID
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.TimeUnit

/**
 * Token 保活：后台按 JWT exp 提前续期 + 401 时即时刷新。
 *
 * 刷新协议（与官方 CLI / CLIProxyAPI codebuddy_auth.go 一致）：
 *   POST {base}/v2/plugin/auth/token/refresh   body: {}
 *   Authorization: Bearer <旧 accessToken>
 *   X-Refresh-Token: <refreshToken>
 *   X-Auth-Refresh-Source: plugin
 *   X-Domain: <域名>
 *   → { code: 0, data: { accessToken, refreshToken, expiresIn, ... } }
 * 注意 /v2/plugin/auth/token（不带 /refresh）是登录轮询端点（GET ?state=），不能用来续期。
 *
 * 并发：同一 uid 的刷新串行化（single-flight）。refreshToken 可能是一次性轮换的，
 * 两个请求同时拿旧 refreshToken 去刷，后到的那个会失败甚至触发整条 token 链吊销。
 */
object TokenKeeper {

    private const val TAG = "TokenKeeper"

    /** 后台检查间隔 */
    private const val TICK_MS = 60_000L
    /** JWT 剩余有效期低于该值就续期 */
    private const val REFRESH_AHEAD_MS = 10 * 60 * 1000L
    /** 解析不出 exp 时的兜底续期间隔 */
    private const val FALLBACK_INTERVAL_MS = 30 * 60 * 1000L

    private val jsonMedia = "application/json; charset=utf-8".toMediaType()

    private val client = OkHttpClient.Builder()
        .connectTimeout(15, TimeUnit.SECONDS)
        .readTimeout(30, TimeUnit.SECONDS)
        .build()

    private val locks = ConcurrentHashMap<String, Any>()
    private val lastRefreshAt = ConcurrentHashMap<String, Long>()

    @Volatile private var worker: Thread? = null

    /** 启动后台保活线程（幂等） */
    @Synchronized
    fun start() {
        if (worker?.isAlive == true) return
        worker = Thread({
            while (!Thread.currentThread().isInterrupted) {
                try {
                    Thread.sleep(TICK_MS)
                    refreshDue()
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

    /** 后台：只刷快过期的 */
    private fun refreshDue() {
        val accounts = AccountVault.getAccounts()
        val now = System.currentTimeMillis()
        for (i in 0 until accounts.length()) {
            val a = accounts.optJSONObject(i) ?: continue
            if (a.optBoolean("disabled", false) || a.optString("refreshToken").isEmpty()) continue
            val uid = a.optString("uid")
            val exp = jwtExpMs(a.optString("accessToken"))
            val due = if (exp > 0) exp - now < REFRESH_AHEAD_MS
                      else now - (lastRefreshAt[uid] ?: 0L) >= FALLBACK_INTERVAL_MS
            if (due) refreshNow(a)
        }
    }

    /** 面板「立即刷新」：全部刷一遍 */
    fun refreshAll() {
        val accounts = AccountVault.getAccounts()
        for (i in 0 until accounts.length()) {
            val a = accounts.optJSONObject(i) ?: continue
            if (a.optBoolean("disabled", false) || a.optString("refreshToken").isEmpty()) continue
            refreshNow(a)
        }
    }

    /**
     * 请求路径上遇到 401 时调用。
     * @param staleAccessToken 调用方刚刚用失败的那个 accessToken；若库里的 token 已经变了，
     *        说明别的线程刚刷新过，直接返回库里的新 token，不重复打刷新接口。
     * @return 成功时返回新的 accessToken，失败返回 null
     */
    fun refreshAfter401(uid: String, staleAccessToken: String): String? {
        val lock = locks.computeIfAbsent(uid) { Any() }
        synchronized(lock) {
            val acc = findAccount(uid) ?: return null
            val current = acc.optString("accessToken")
            if (current.isNotEmpty() && current != staleAccessToken) return current
            return if (doRefresh(acc)) findAccount(uid)?.optString("accessToken") else null
        }
    }

    private fun refreshNow(acc: JSONObject) {
        val uid = acc.optString("uid")
        val lock = locks.computeIfAbsent(uid) { Any() }
        synchronized(lock) {
            // 拿锁后重读一次，避免用已被别人轮换掉的 refreshToken
            val fresh = findAccount(uid) ?: return
            try { doRefresh(fresh) } catch (e: Exception) { Log.w(TAG, "刷新 $uid 失败: ${e.message}") }
        }
    }

    private fun findAccount(uid: String): JSONObject? {
        val accounts = AccountVault.getAccounts()
        for (i in 0 until accounts.length()) {
            val a = accounts.optJSONObject(i) ?: continue
            if (a.optString("uid") == uid) return a
        }
        return null
    }

    /** 调用方必须持有该 uid 的锁 */
    private fun doRefresh(acc: JSONObject): Boolean {
        val uid = acc.optString("uid")
        val refresh = acc.optString("refreshToken")
        if (refresh.isEmpty()) return false

        val realm = acc.optString("realm", "global")
        val base = TencentGateway.baseFor(realm)
        val domain = if (realm == "cn") "www.codebuddy.cn" else "www.workbuddy.ai"

        return try {
            val req = Request.Builder()
                .url("$base/v2/plugin/auth/token/refresh")
                .header("Accept", "application/json, text/plain, */*")
                .header("Content-Type", "application/json")
                .header("X-Requested-With", "XMLHttpRequest")
                .header("X-Domain", domain)
                .header("X-Refresh-Token", refresh)
                .header("X-Auth-Refresh-Source", "plugin")
                .header("X-Request-ID", UUID.randomUUID().toString().replace("-", ""))
                .header("Authorization", "Bearer ${acc.optString("accessToken")}")
                .header("X-User-Id", uid)
                .header("User-Agent", TencentGateway.CLIENT_UA)
                .post("{}".toRequestBody(jsonMedia))
                .build()

            client.newCall(req).execute().use { resp ->
                val text = resp.body?.string().orEmpty()
                if (!resp.isSuccessful) {
                    Log.w(TAG, "刷新 $uid 返回 HTTP ${resp.code}")
                    return false
                }
                val o = try { JSONObject(text) } catch (e: Exception) { return false }
                if (o.has("code") && o.optInt("code", -1) != 0) {
                    Log.w(TAG, "刷新 $uid 失败 code=${o.optInt("code")} msg=${o.optString("msg")}")
                    return false
                }
                val data = o.optJSONObject("data") ?: o
                val newAccess = data.optString("accessToken").ifEmpty { data.optString("access_token") }
                val newRefresh = data.optString("refreshToken").ifEmpty { data.optString("refresh_token") }
                if (newAccess.isEmpty()) return false

                AccountVault.updateTokens(uid, newAccess, newRefresh.ifEmpty { null })
                lastRefreshAt[uid] = System.currentTimeMillis()
                Log.i(TAG, "账号 $uid token 已续期")
                true
            }
        } catch (e: Exception) {
            Log.w(TAG, "刷新 $uid 异常: ${e.message}")
            false
        }
    }

    /** 解析 JWT 的 exp（毫秒），解析失败返回 0 */
    private fun jwtExpMs(token: String): Long {
        val parts = token.split('.')
        if (parts.size < 2) return 0
        return try {
            val json = String(
                android.util.Base64.decode(parts[1], android.util.Base64.URL_SAFE or android.util.Base64.NO_PADDING or android.util.Base64.NO_WRAP),
                Charsets.UTF_8
            )
            JSONObject(json).optLong("exp", 0L) * 1000
        } catch (e: Exception) { 0 }
    }
}
