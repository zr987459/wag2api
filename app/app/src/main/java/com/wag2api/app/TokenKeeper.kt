package com.wag2api.app

import android.util.Base64
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
 * Token 保活：按 JWT exp 提前续期 + 401 时即时刷新。
 *
 * 刷新协议（与官方 CodeBuddy / WorkBuddy CLI 一致）：
 *   POST {base}/v2/plugin/auth/token/refresh   body: {}
 *   Authorization: Bearer <accessToken>
 *   X-Refresh-Token: <refreshToken>
 *   X-Auth-Refresh-Source: plugin
 *   -> { code: 0, data: { accessToken, refreshToken, expiresIn, ... } }
 * refreshToken 会轮换，所以同一账号的刷新必须单飞（per-uid 锁），否则并发刷新
 * 会拿着已作废的旧 refreshToken 去换，直接把账号刷死。
 */
object TokenKeeper {

    private const val TAG = "TokenKeeper"

    /** 距离过期不足这么久就续期 */
    private const val REFRESH_AHEAD_MS = 10 * 60 * 1000L
    /** 解不出 exp 时的兜底续期间隔 */
    private const val FALLBACK_INTERVAL_MS = 30 * 60 * 1000L
    /** 后台巡检间隔 */
    private const val TICK_MS = 60_000L

    private val jsonMedia = "application/json; charset=utf-8".toMediaType()

    private val client = OkHttpClient.Builder()
        .connectTimeout(15, TimeUnit.SECONDS)
        .readTimeout(30, TimeUnit.SECONDS)
        .build()

    private val locks = ConcurrentHashMap<String, Any>()
    private val lastRefreshAt = ConcurrentHashMap<String, Long>()

    @Volatile private var worker: Thread? = null

    @Synchronized
    fun start() {
        if (worker?.isAlive == true) return
        worker = Thread({
            while (!Thread.currentThread().isInterrupted) {
                try {
                    Thread.sleep(TICK_MS)
                    refreshAll(onlyIfDue = true)
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

    /** 面板「全部刷新」用 onlyIfDue=false；后台巡检用 true */
    fun refreshAll(onlyIfDue: Boolean = false) {
        val accounts = AccountVault.getAccounts()
        for (i in 0 until accounts.length()) {
            val a = accounts.optJSONObject(i) ?: continue
            if (a.optBoolean("disabled", false)) continue
            val uid = a.optString("uid")
            if (uid.isEmpty() || a.optString("refreshToken").isEmpty()) continue
            if (onlyIfDue && !isDue(uid, a.optString("accessToken"))) continue
            refresh(uid, staleAccess = null)
        }
    }

    private fun isDue(uid: String, access: String): Boolean {
        val now = System.currentTimeMillis()
        val exp = jwtExpMs(access)
        if (exp != null) return exp - now <= REFRESH_AHEAD_MS
        return now - (lastRefreshAt[uid] ?: 0L) >= FALLBACK_INTERVAL_MS
    }

    private fun jwtExpMs(token: String): Long? = try {
        val parts = token.split('.')
        if (parts.size < 3) null else {
            val payload = String(Base64.decode(parts[1], Base64.URL_SAFE or Base64.NO_PADDING or Base64.NO_WRAP), Charsets.UTF_8)
            JSONObject(payload).optLong("exp", 0L).takeIf { it > 0 }?.times(1000)
        }
    } catch (e: Exception) { null }

    /**
     * 刷新指定账号，返回可用的新 accessToken；失败返回 null。
     * @param staleAccess 调用方手里那个被 401 的 token。若库里的 token 已经不是它，
     *                    说明别的线程刚刷新过，直接返回库里的新 token，不再重复刷新。
     */
    fun refresh(uid: String, staleAccess: String?): String? {
        val lock = locks.getOrPut(uid) { Any() }
        synchronized(lock) {
            val acc = findAccount(uid) ?: return null
            val access = acc.optString("accessToken")
            if (staleAccess != null && access.isNotEmpty() && access != staleAccess) return access

            val refresh = acc.optString("refreshToken")
            if (refresh.isEmpty()) return null

            val realm = acc.optString("realm", "global")
            val base = if (realm == "cn") TencentGateway.UPSTREAM_CN else TencentGateway.UPSTREAM_GLOBAL
            val domain = if (realm == "cn") "copilot.tencent.com" else "www.workbuddy.ai"

            val req = Request.Builder()
                .url("$base/v2/plugin/auth/token/refresh")
                .header("Content-Type", "application/json")
                .header("Accept", "application/json")
                .header("User-Agent", TencentGateway.CLIENT_UA)
                .header("X-Requested-With", "XMLHttpRequest")
                .header("X-Domain", domain)
                .header("X-Refresh-Token", refresh)
                .header("X-Auth-Refresh-Source", "plugin")
                .header("X-Request-ID", UUID.randomUUID().toString().replace("-", ""))
                .apply { if (access.isNotEmpty()) header("Authorization", "Bearer $access") }
                .post("{}".toRequestBody(jsonMedia))
                .build()

            return try {
                client.newCall(req).execute().use { resp ->
                    val text = resp.body?.string().orEmpty()
                    val o = try { JSONObject(text) } catch (e: Exception) { null }
                    val data = o?.optJSONObject("data")
                    val code = o?.optInt("code", -1) ?: -1
                    if (!resp.isSuccessful || (code != 0 && code != 200) || data == null) {
                        Log.w(TAG, "刷新 $uid 失败 http=${resp.code} code=$code")
                        return null
                    }
                    val newAccess = data.optString("accessToken").ifEmpty { data.optString("access_token") }
                    val newRefresh = data.optString("refreshToken").ifEmpty { data.optString("refresh_token") }
                    if (newAccess.isEmpty()) return null
                    AccountVault.updateTokens(uid, newAccess, newRefresh.ifEmpty { null })
                    lastRefreshAt[uid] = System.currentTimeMillis()
                    Log.i(TAG, "账号 $uid token 已续期")
                    newAccess
                }
            } catch (e: Exception) {
                Log.w(TAG, "刷新 $uid 异常: ${e.message}")
                null
            }
        }
    }

    /** 兼容旧调用 */
    fun refreshIfPossible(uid: String): Boolean = refresh(uid, null) != null

    private fun findAccount(uid: String): JSONObject? {
        val accounts = AccountVault.getAccounts()
        for (i in 0 until accounts.length()) {
            val a = accounts.optJSONObject(i) ?: continue
            if (a.optString("uid") == uid) return a
        }
        return null
    }
}
