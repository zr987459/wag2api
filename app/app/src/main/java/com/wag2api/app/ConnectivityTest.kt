package com.wag2api.app

import android.content.Context
import android.util.Log
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONArray
import org.json.JSONObject
import java.security.MessageDigest
import java.util.UUID
import java.util.concurrent.TimeUnit

/**
 * 连通性测试：真实发一次最小请求，验证账号是否可用。
 *
 * 注入完整腾讯客户端指纹与规范化 Payload（包含模型别名映射、System Prompt、设备指纹），
 * 彻底消除 11128 渠道强校验拦截与 11102 模型未找到报错。
 */
object ConnectivityTest {

    private const val TAG = "ConnectivityTest"
    private const val TIMEOUT_SEC = 25L

    private val jsonMedia = "application/json; charset=utf-8".toMediaType()

    private val MODEL_ALIASES = mapOf(
        "deepseek-v4.1-flash-1017" to "deepseek-v4.1-flash",
        "deepseek-flash-1017" to "deepseek-v4.1-flash",
        "deepseek-flash" to "deepseek-v4.1-flash",
        "claude-3.7-sonnet" to "default-1.1",
        "claude-4.0-sonnet" to "default-1.2",
        "kimi-k3" to "kimi-k3-1",
        "kimi-k3.1" to "kimi-k3-1",
        "hy4-preview-f" to "hy4-preview",
        "deepseek-v3.2" to "deepseek-v3-2-volc",
        "gemini-3.8-flash" to "gemini-3.5-flash"
    )

    private fun sha256Prefix(text: String): String {
        val digest = MessageDigest.getInstance("SHA-256")
        val bytes = digest.digest(text.toByteArray(Charsets.UTF_8))
        val hex = StringBuilder()
        for (b in bytes) {
            val h = Integer.toHexString(0xFF and b.toInt())
            if (h.length == 1) hex.append('0')
            hex.append(h)
        }
        return hex.toString().take(36)
    }

    /**
     * @param uid 要测试的账号，空则用调度器挑一个
     * @param model 测试用模型
     */
    fun run(ctx: Context, uid: String, model: String): JSONObject {
        val started = System.currentTimeMillis()

        // 1. 找账号
        val acc: JSONObject? = if (uid.isNotEmpty()) {
            val all = AccountVault.getAccounts()
            (0 until all.length()).mapNotNull { all.optJSONObject(it) }
                .firstOrNull { it.optString("uid") == uid }
        } else {
            AccountScheduler.pick(ctx, "global") ?: AccountVault.getActiveAccount("global")
        }

        if (acc == null) {
            return fail(started, "未找到可用账号，请先添加账号")
        }

        val accUid = acc.optString("uid", "unknown")
        val token = acc.optString("accessToken")
        if (token.isEmpty()) {
            return fail(started, "该账号没有 accessToken，请重新授权", accUid)
        }

        val realm = acc.optString("realm", "global")
        val base = if (realm == "cn") TencentGateway.UPSTREAM_CN else TencentGateway.UPSTREAM_GLOBAL

        // 2. 模型映射与规范化
        val cleanModel = MODEL_ALIASES[model] ?: model

        // 3. 构造上游合规最小 Payload（必须带 system 角色，stream=false）
        val payload = JSONObject().apply {
            put("model", cleanModel)
            put("stream", false)
            put("max_tokens", 8)
            put("messages", JSONArray().apply {
                put(JSONObject().apply {
                    put("role", "system")
                    put("content", TencentGateway.DEFAULT_SYSTEM_PROMPT)
                })
                put(JSONObject().apply {
                    put("role", "user")
                    put("content", "ping")
                })
            })
        }

        val client = OkHttpClient.Builder()
            .connectTimeout(TIMEOUT_SEC, TimeUnit.SECONDS)
            .readTimeout(TIMEOUT_SEC, TimeUnit.SECONDS)
            .writeTimeout(TIMEOUT_SEC, TimeUnit.SECONDS)
            .build()

        val machineId = sha256Prefix("wb2a:machine:$accUid")
        val sessionId = sha256Prefix("wb2a:session:$accUid")
        val convId = UUID.randomUUID().toString().replace("-", "")

        val endpoints = listOf("$base/v2/chat/completions", "$base/console/chat/completions")
        var lastError = "未知错误"
        var lastStatus = 0

        for (url in endpoints) {
            try {
                val reqBuilder = Request.Builder()
                    .url(url)
                    .header("Authorization", "Bearer $token")
                    .header("Content-Type", "application/json")
                    .header("Accept", "application/json")
                    .header("Accept-Language", if (realm == "global") "en-US" else "zh-CN")
                    .header("X-Requested-With", "XMLHttpRequest")
                    .header("X-CodeBuddy-Request", "1")
                    .header("User-Agent", TencentGateway.CLIENT_UA)
                    .header("Origin", base)
                    .header("Referer", "$base/")
                    .header("X-User-Id", accUid)
                    .header("X-Product", "WorkBuddy")
                    .header("X-Agent-Purpose", "conversation")
                    .header("X-IDE-Name", "WorkBuddy")
                    .header("X-IDE-Type", "WorkBuddy")
                    .header("X-IDE-Version", "5.5.4")
                    .header("X-Machine-ID", machineId)
                    .header("X-Session-ID", sessionId)
                    .header("X-Conversation-ID", convId)
                    .header("X-Conversation-Request-ID", UUID.randomUUID().toString().replace("-", ""))
                    .header("X-Conversation-Message-ID", UUID.randomUUID().toString().replace("-", ""))
                    .header("X-Root-Request-ID", UUID.randomUUID().toString().replace("-", ""))
                    .header("X-Trace-ID", UUID.randomUUID().toString().replace("-", ""))

                if (realm == "global") {
                    reqBuilder.header("X-No-Enterprise-Id", "1")
                    reqBuilder.header("X-Domain", "www.workbuddy.ai")
                } else {
                    reqBuilder.header("X-No-Enterprise-Id", "1")
                    reqBuilder.header("X-No-Department-Info", "1")
                }

                val req = reqBuilder.post(payload.toString().toRequestBody(jsonMedia)).build()

                client.newCall(req).execute().use { resp ->
                    val body = resp.body?.string().orEmpty()
                    lastStatus = resp.code

                    if (resp.isSuccessful) {
                        // 成功：判断返回内容
                        val hasContent = body.contains("\"content\"") ||
                                body.contains("\"choices\"") ||
                                body.contains("\"text\"") ||
                                body.contains("\"message\"")
                        if (hasContent) {
                            return success(started, accUid, url, realm, cleanModel)
                        } else {
                            lastError = "上游返回 200 但内容异常"
                        }
                    }

                    // 失败分析
                    val code = try {
                        JSONObject(body).optInt("code", 0)
                    } catch (e: Exception) { 0 }

                    lastError = when {
                        resp.code == 401 -> "Token 已失效，请点「Token 保活」或重新授权"
                        resp.code == 403 -> "上游拒绝 (403)，可能是账号受限或渠道校验"
                        resp.code == 429 || code == 14003 -> "模型繁忙 (429)，账号健康有效"
                        code == 11102 -> "模型服务不可用 (11102)"
                        code == 11128 -> "渠道校验异常 (11128)"
                        resp.code >= 500 -> "上游服务波动 (${resp.code})"
                        else -> "HTTP ${resp.code}: ${body.take(120)}"
                    }

                    // 429 / 14003 代表链路与 Token 均有效，只是上游算力忙
                    if (resp.code == 429 || code == 14003) {
                        return JSONObject().apply {
                            put("ok", false)
                            put("partial", true)
                            put("uid", accUid)
                            put("model", cleanModel)
                            put("realm", realm)
                            put("endpoint", url)
                            put("elapsed_ms", System.currentTimeMillis() - started)
                            put("status", resp.code)
                            put("msg", lastError)
                        }
                    }

                    Log.w(TAG, "测试 $url 未通过: $lastError")
                }
            } catch (e: Exception) {
                lastError = "网络异常：${e.message}"
                Log.w(TAG, "测试 $url 异常", e)
            }
        }

        return fail(started, lastError, accUid, null, lastStatus)
    }

    private fun success(
        started: Long, uid: String, url: String, realm: String, model: String
    ): JSONObject = JSONObject().apply {
        put("ok", true)
        put("uid", uid)
        put("model", model)
        put("realm", realm)
        put("endpoint", url)
        put("elapsed_ms", System.currentTimeMillis() - started)
        put("status", 200)
        put("msg", "连通正常")
    }

    private fun fail(
        started: Long,
        msg: String,
        uid: String = "",
        url: String? = null,
        status: Int = 0
    ): JSONObject = JSONObject().apply {
        put("ok", false)
        put("partial", false)
        put("uid", uid)
        put("elapsed_ms", System.currentTimeMillis() - started)
        put("status", status)
        put("msg", msg)
        if (url != null) put("endpoint", url)
    }
}
