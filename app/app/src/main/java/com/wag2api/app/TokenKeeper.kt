package com.wag2api.app

import android.util.Log
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONObject
import java.util.concurrent.TimeUnit

/**
 * Token 保活：定期检查 + 401 时即时刷新。
 *
 * 腾讯的 accessToken 有有效期，过期后上游直接 401。
 * 这里做两件事：
 *  1. 后台定时（默认 30 分钟）尝试刷新一次，提前续期
 *  2. 请求遇到 401 时立刻刷新，成功则原样重试
 */
object TokenKeeper {

    private const val TAG = "TokenKeeper"

    /** 提前刷新的间隔：30 分钟 */
    private const val REFRESH_INTERVAL_MS = 30 * 60 * 1000L

    private val jsonMedia = "application/json; charset=utf-8".toMediaType()

    private val client = OkHttpClient.Builder()
        .connectTimeout(15, TimeUnit.SECONDS)
        .readTimeout(30, TimeUnit.SECONDS)
        .build()

    @Volatile private var lastRefreshAt = 0L
    @Volatile private var running = false

    /** 启动后台保活线程 */
    fun start() {
        if (running) return
        running = true
        Thread({
            while (running) {
                try {
                    Thread.sleep(60_000)          // 每分钟检查一次是否到点
                    if (System.currentTimeMillis() - lastRefreshAt >= REFRESH_INTERVAL_MS) {
                        refreshAll()
                        lastRefreshAt = System.currentTimeMillis()
                    }
                } catch (e: InterruptedException) {
                    break
                } catch (e: Exception) {
                    Log.w(TAG, "保活循环异常: ${e.message}")
                }
            }
        }, "token-keeper").start()
    }

    fun stop() { running = false }

    /** 遍历所有有 refreshToken 的账号，尝试续期 */
    fun refreshAll() {
        val accounts = AccountVault.getAccounts()
        for (i in 0 until accounts.length()) {
            val a = accounts.optJSONObject(i) ?: continue
            if (a.optBoolean("disabled", false)) continue
            val uid = a.optString("uid")
            val refresh = a.optString("refreshToken")
            if (uid.isEmpty() || refresh.isEmpty()) continue
            try {
                refreshIfPossible(uid, force = true)
            } catch (e: Exception) {
                Log.w(TAG, "刷新 $uid 失败: ${e.message}")
            }
        }
    }

    /**
     * 刷新指定账号的 accessToken。
     * @return true 表示刷新成功
     */
    fun refreshIfPossible(uid: String, force: Boolean = false): Boolean {
        val accounts = AccountVault.getAccounts()
        var target: JSONObject? = null
        for (i in 0 until accounts.length()) {
            val a = accounts.optJSONObject(i) ?: continue
            if (a.optString("uid") == uid) { target = a; break }
        }
        val acc = target ?: return false

        val refresh = acc.optString("refreshToken")
        if (refresh.isEmpty()) return false

        val realm = acc.optString("realm", "global")
        val base = if (realm == "cn") TencentGateway.UPSTREAM_CN else TencentGateway.UPSTREAM_GLOBAL

        // 腾讯 OAuth 刷新端点
        val bodyJson = JSONObject().apply {
            put("grant_type", "refresh_token")
            put("refresh_token", refresh)
        }

        return try {
            val req = Request.Builder()
                .url("$base/v2/plugin/auth/token")
                .header("Content-Type", "application/json")
                .header("User-Agent", TencentGateway.CLIENT_UA)
                .header("Origin", base)
                .header("Referer", "$base/")
                .post(bodyJson.toString().toRequestBody(jsonMedia))
                .build()

            client.newCall(req).execute().use { resp ->
                if (!resp.isSuccessful) {
                    Log.w(TAG, "刷新 $uid 返回 ${resp.code}")
                    return false
                }
                val text = resp.body?.string() ?: return false
                val o = try { JSONObject(text) } catch (e: Exception) { return false }
                // 兼容多种返回结构
                val data = o.optJSONObject("data") ?: o
                val newAccess = data.optString("accessToken")
                    .ifEmpty { data.optString("access_token") }
                val newRefresh = data.optString("refreshToken")
                    .ifEmpty { data.optString("refresh_token") }

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
}
