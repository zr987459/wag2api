package com.wag2api.app

import android.util.Log
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONObject
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.TimeUnit

/**
 * Token 保活：定期检查 + 401 时即时刷新。
 *
 * 刷新端点：POST {base}/v2/plugin/auth/token/refresh
 *   - refreshToken 放在请求头 X-Refresh-Token，不是 body 里的 grant_type
 *   - X-Auth-Refresh-Source: plugin
 *   - 返回 {code, msg, data:{accessToken, refreshToken, expiresIn, ...}}，code != 0 即失败（HTTP 仍可能是 200）
 * 与 CodeBuddy CLI 及多个开源实现（CLIProxyAPI codebuddy、codebuddy2openai、workbuddy-cliproxy）一致。
 * 原来的 /v2/plugin/auth/token 是登录轮询端点（GET ?state=），POST 过去永远拿不到新 token。
 *
 * 并发：同一账号同一时刻只允许一个刷新在途；且短时间内刚刷新过就直接视为成功。
 * refreshToken 一般是滚动的（用一次换一个新的），并发两次刷新时第二次拿着已作废的旧 refreshToken，
 * 轻则失败，重则被上游判定为重放而吊销整条会话。
 */
object TokenKeeper {

    private const val TAG = "TokenKeeper"

    /** 提前刷新的间隔：30 分钟 */
    private const val REFRESH_INTERVAL_MS = 30 * 60 * 1000L

    /** 刚刷新过的账号在这个窗口内不重复刷新（非 force） */
    private const val DEDUPE_WINDOW_MS = 60_000L

    private val jsonMedia = "application/json; charset=utf-8".toMediaType()

    private val client = OkHttpClient.Builder()
        .connectTimeout(15, TimeUnit.SECONDS)
        .readTimeout(30, TimeUnit.SECONDS)
        .build()

    @Volatile private var lastRefreshAt = 0L
    @Volatile private var worker: Thread? = null

    /** uid -> 锁对象，保证同一账号串行刷新 */
    private val locks = ConcurrentHashMap<String, Any>()
    /** uid -> 最近一次刷新成功的时间 */
    private val refreshedAt = ConcurrentHashMap<String, Long>()

    /** 启动后台保活线程（重复调用安全；stop 后再 start 不会留下两个线程） */
    @Synchronized
    fun start() {
        if (worker?.isAlive == true) return
        val t = Thread({
            while (!Thread.currentThread().isInterrupted) {
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
        }, "token-keeper")
        t.isDaemon = true
        worker = t
        t.start()
    }

    @Synchronized
    fun stop() {
        worker?.interrupt()
        worker = null
    }

    /** 遍历所有有 refreshToken 的账号，尝试续期（直接用快照里的账号对象，不再按 uid 反查） */
    fun refreshAll() {
        val accounts = AccountVault.getAccounts()
        for (i in 0 until accounts.length()) {
            val a = accounts.optJSONObject(i) ?: continue
            if (a.optBoolean("disabled", false)) continue
            if (a.optString("uid").isEmpty() || a.optString("refreshToken").isEmpty()) continue
            try {
                refreshAccount(a, force = false)
            } catch (e: Exception) {
                Log.w(TAG, "刷新 ${a.optString("uid")} 失败: ${e.message}")
            }
        }
    }

    /**
     * 刷新指定账号的 accessToken（401 路径用）。
     * @param force true 时忽略「刚刷新过」的去重窗口
     * @return true 表示当前持有的 token 是新鲜的（本次刷新成功，或去重窗口内已有人刷新成功）
     */
    fun refreshIfPossible(uid: String, force: Boolean = false): Boolean {
        val accounts = AccountVault.getAccounts()
        for (i in 0 until accounts.length()) {
            val a = accounts.optJSONObject(i) ?: continue
            if (a.optString("uid") == uid) return refreshAccount(a, force)
        }
        return false
    }

    private fun refreshAccount(snapshot: JSONObject, force: Boolean): Boolean {
        val uid = snapshot.optString("uid")
        if (uid.isEmpty()) return false
        val lock = locks.getOrPut(uid) { Any() }
        synchronized(lock) {
            if (!force) {
                val last = refreshedAt[uid] ?: 0L
                if (System.currentTimeMillis() - last < DEDUPE_WINDOW_MS) return true
            }
            // 拿到锁后重新读一次：前一个线程可能已经换掉了 refreshToken
            val acc = currentAccount(uid) ?: snapshot
            val ok = doRefresh(uid, acc)
            if (ok) refreshedAt[uid] = System.currentTimeMillis()
            return ok
        }
    }

    private fun currentAccount(uid: String): JSONObject? {
        val accounts = AccountVault.getAccounts()
        for (i in 0 until accounts.length()) {
            val a = accounts.optJSONObject(i) ?: continue
            if (a.optString("uid") == uid) return a
        }
        return null
    }

    private fun doRefresh(uid: String, acc: JSONObject): Boolean {
        val refresh = acc.optString("refreshToken")
        if (refresh.isEmpty()) return false

        val realm = acc.optString("realm", "global")
        val isCn = realm == "cn"
        val base = if (isCn) TencentGateway.UPSTREAM_CN else TencentGateway.UPSTREAM_GLOBAL
        val origin = if (isCn) "https://www.codebuddy.cn" else TencentGateway.UPSTREAM_GLOBAL
        val domain = if (isCn) "copilot.tencent.com" else "www.workbuddy.ai"

        return try {
            val reqBuilder = Request.Builder()
                .url("$base/v2/plugin/auth/token/refresh")
                .header("Content-Type", "application/json")
                .header("Accept", "application/json, text/plain, */*")
                .header("User-Agent", TencentGateway.CLIENT_UA)
                .header("Origin", origin)
                .header("Referer", "$origin/")
                .header("X-Requested-With", "XMLHttpRequest")
                .header("X-Refresh-Token", refresh)
                .header("X-Auth-Refresh-Source", "plugin")
                .header("X-Domain", domain)
                .header("X-User-Id", uid)
            val access = acc.optString("accessToken")
            if (access.isNotEmpty()) reqBuilder.header("Authorization", "Bearer $access")
            val req = reqBuilder.post("{}".toRequestBody(jsonMedia)).build()

            client.newCall(req).execute().use { resp ->
                val text = resp.body?.string().orEmpty()
                if (!resp.isSuccessful) {
                    Log.w(TAG, "刷新 $uid 返回 HTTP ${resp.code}: ${text.take(200)}")
                    return false
                }
                val o = try { JSONObject(text) } catch (e: Exception) { return false }
                // 业务码：HTTP 200 也可能是失败
                if (o.has("code") && o.optInt("code", -1) != 0) {
                    Log.w(TAG, "刷新 $uid 失败 code=${o.optInt("code")} msg=${o.optString("msg")}")
                    return false
                }
                val data = o.optJSONObject("data") ?: o
                val newAccess = data.optString("accessToken").ifEmpty { data.optString("access_token") }
                val newRefresh = data.optString("refreshToken").ifEmpty { data.optString("refresh_token") }

                if (newAccess.isEmpty()) return false
                val saved = AccountVault.updateTokens(uid, newAccess, newRefresh.ifEmpty { null })
                if (saved) Log.i(TAG, "账号 $uid token 已续期")
                saved
            }
        } catch (e: Exception) {
            Log.w(TAG, "刷新 $uid 异常: ${e.message}")
            false
        }
    }
}
