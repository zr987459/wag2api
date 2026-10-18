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
 * Token 保活：定期续期 + 401 时即时刷新。
 *
 * 刷新协议（与官方 CLI / CLIProxyAPI 的 codebuddy 实现一致）：
 *   POST {base}/v2/plugin/auth/token/refresh   body = {}
 *   Authorization: Bearer <旧 accessToken>
 *   X-Refresh-Token: <refreshToken>
 *   X-Auth-Refresh-Source: plugin
 *   X-User-Id / X-Domain
 *   → { code: 0, data: { accessToken, refreshToken, expiresIn, refreshExpiresIn, domain } }
 *
 * 注意：/v2/plugin/auth/token 是登录轮询端点（GET ?state=），不是刷新端点。
 */
object TokenKeeper {

    private const val TAG = "TokenKeeper"

    /** 定时续期间隔：30 分钟 */
    private const val REFRESH_INTERVAL_MS = 30 * 60 * 1000L

    /** 同一账号两次刷新的最小间隔（定时任务会跳过刚被 401 路径刷过的账号） */
    private const val MIN_REFRESH_GAP_MS = 5 * 60 * 1000L

    private val jsonMedia = "application/json; charset=utf-8".toMediaType()

    private val client = OkHttpClient.Builder()
        .connectTimeout(15, TimeUnit.SECONDS)
        .readTimeout(30, TimeUnit.SECONDS)
        .build()

    /** uid -> 锁对象：同一账号的刷新串行化（refreshToken 可能是一次性的，并发刷新会互相作废） */
    private val locks = ConcurrentHashMap<String, Any>()
    /** uid -> 上次刷新成功时间 */
    private val lastOkAt = ConcurrentHashMap<String, Long>()

    @Volatile private var worker: Thread? = null

    /** 启动后台保活线程（幂等） */
    @Synchronized
    fun start() {
        if (worker?.isAlive == true) return
        worker = Thread({
            var lastRunAt = 0L
            while (!Thread.currentThread().isInterrupted) {
                try {
                    Thread.sleep(60_000)          // 每分钟检查一次是否到点
                    if (System.currentTimeMillis() - lastRunAt >= REFRESH_INTERVAL_MS) {
                        refreshAll()
                        lastRunAt = System.currentTimeMillis()
                    }
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

    /** 遍历所有有 refreshToken 的账号续期；最近 5 分钟内刷过的跳过 */
    fun refreshAll() {
        val accounts = AccountVault.getAccounts()
        val now = System.currentTimeMillis()
        for (i in 0 until accounts.length()) {
            val a = accounts.optJSONObject(i) ?: continue
            if (a.optBoolean("disabled", false)) continue
            val uid = a.optString("uid")
            if (uid.isEmpty() || a.optString("refreshToken").isEmpty()) continue
            if (now - (lastOkAt[uid] ?: 0L) < MIN_REFRESH_GAP_MS) continue
            try {
                refreshIfPossible(uid)
            } catch (e: Exception) {
                Log.w(TAG, "刷新 $uid 失败: ${e.message}")
            }
        }
    }

    /**
     * 刷新指定账号的 accessToken。
     *
     * @param staleAccessToken 调用方手上那个已经 401 的 token。拿到锁后若发现库里的 token
     *        已经不是它（别的请求刚刷新过），直接返回 true，不重复打上游。
     * @return true 表示库里现在有一个比 staleAccessToken 更新的 token
     */
    fun refreshIfPossible(uid: String, staleAccessToken: String? = null): Boolean {
        val lock = locks.getOrPut(uid) { Any() }
        synchronized(lock) {
            val acc = findAccount(uid) ?: return false
            val current = acc.optString("accessToken")
            if (staleAccessToken != null && current.isNotEmpty() && current != staleAccessToken) return true

            val refresh = acc.optString("refreshToken")
            if (refresh.isEmpty()) return false
            return doRefresh(uid, acc, current, refresh)
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

    private fun doRefresh(uid: String, acc: JSONObject, accessToken: String, refresh: String): Boolean {
        val realm = acc.optString("realm", "global")
        val base = if (realm == "cn") TencentGateway.UPSTREAM_CN else TencentGateway.UPSTREAM_GLOBAL
        val domain = acc.optString("domain").ifEmpty {
            if (realm == "cn") "www.codebuddy.cn" else "www.workbuddy.ai"
        }

        val req = Request.Builder()
            .url("$base/v2/plugin/auth/token/refresh")
            .header("Accept", "application/json, text/plain, */*")
            .header("Content-Type", "application/json")
            .header("X-Requested-With", "XMLHttpRequest")
            .header("User-Agent", TencentGateway.CLIENT_UA)
            .header("Authorization", "Bearer $accessToken")
            .header("X-Refresh-Token", refresh)
            .header("X-Auth-Refresh-Source", "plugin")
            .header("X-User-Id", uid)
            .header("X-Domain", domain)
            .header("X-Request-ID", UUID.randomUUID().toString().replace("-", ""))
            .post("{}".toRequestBody(jsonMedia))
            .build()

        return try {
            client.newCall(req).execute().use { resp ->
                val text = resp.body?.string().orEmpty()
                if (!resp.isSuccessful) {
                    // 401/403 = refreshToken 本身失效，只能重新登录；不要无限重试
                    Log.w(TAG, "刷新 $uid 返回 HTTP ${resp.code}: ${text.take(200)}")
                    return false
                }
                val o = try { JSONObject(text) } catch (e: Exception) { return false }
                if (o.has("code") && o.optInt("code", -1) != 0) {
                    Log.w(TAG, "刷新 $uid 业务失败 code=${o.optInt("code")} msg=${o.optString("msg")}")
                    return false
                }
                val data = o.optJSONObject("data") ?: o
                val newAccess = data.optString("accessToken").ifEmpty { data.optString("access_token") }
                val newRefresh = data.optString("refreshToken").ifEmpty { data.optString("refresh_token") }
                if (newAccess.isEmpty()) return false

                AccountVault.updateTokens(uid, newAccess, newRefresh.ifEmpty { null })
                lastOkAt[uid] = System.currentTimeMillis()
                Log.i(TAG, "账号 $uid token 已续期")
                true
            }
        } catch (e: Exception) {
            Log.w(TAG, "刷新 $uid 异常: ${e.message}")
            false
        }
    }
}
