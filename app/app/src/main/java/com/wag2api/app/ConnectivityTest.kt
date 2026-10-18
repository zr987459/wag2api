package com.wag2api.app

import android.content.Context
import android.util.Log
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONArray
import org.json.JSONObject
import java.util.concurrent.TimeUnit

/**
 * 连通性测试：真实发一次最小请求，验证账号是否可用。
 *
 * 返回结构化结果，方便前端直接展示：
 *  - ok / 失败原因
 *  - 耗时
 *  - 命中的端点
 *  - 模型是否可用
 */
object ConnectivityTest {

    private const val TAG = "ConnectivityTest"
    private const val TIMEOUT_SEC = 30L

    private val jsonMedia = "application/json; charset=utf-8".toMediaType()

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

        // 2. 构造最小请求（非流式，只要一个字就够验证链路）
        val payload = JSONObject().apply {
            put("model", model)
            put("stream", false)
            put("max_tokens", 16)
            put("messages", JSONArray().apply {
                put(JSONObject().apply {
                    put("role", "user")
                    put("content", "hi")
                })
            })
        }

        val client = OkHttpClient.Builder()
            .connectTimeout(TIMEOUT_SEC, TimeUnit.SECONDS)
            .readTimeout(TIMEOUT_SEC, TimeUnit.SECONDS)
            .writeTimeout(TIMEOUT_SEC, TimeUnit.SECONDS)
            .build()

        val endpoints = listOf("$base/v2/chat/completions", "$base/console/chat/completions")
        var lastError = "未知错误"
        var lastStatus = 0

        for (url in endpoints) {
            try {
                val req = Request.Builder()
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
                    .post(payload.toString().toRequestBody(jsonMedia))
                    .build()

                client.newCall(req).execute().use { resp ->
                    val body = resp.body?.string().orEmpty()
                    lastStatus = resp.code

                    if (resp.isSuccessful) {
                        // 成功：判断是不是正常 JSON 回复
                        val hasContent = body.contains("\"content\"") ||
                                body.contains("\"choices\"") ||
                                body.contains("\"delta\"")
                        return if (hasContent) {
                            success(started, accUid, url, realm, model)
                        } else {
                            fail(started, "上游返回 200 但内容异常：${body.take(160)}", accUid, url)
                        }
                    }

                    // 失败：给出人话原因
                    val code = try {
                        JSONObject(body).optInt("code", 0)
                    } catch (e: Exception) { 0 }

                    lastError = when {
                        resp.code == 401 -> "Token 已失效，请重新授权或点「Token 保活」"
                        resp.code == 403 -> "被上游拒绝（403），可能是渠道校验或 Token 无权限"
                        resp.code == 429 || code == 14003 -> "模型繁忙（429），稍后重试即可"
                        resp.code >= 500 -> "上游服务异常（${resp.code}）"
                        else -> "HTTP ${resp.code}：${body.take(160)}"
                    }

                    // 429 说明账号本身是通的，只是当前繁忙
                    if (resp.code == 429 || code == 14003) {
                        return JSONObject().apply {
                            put("ok", false)
                            put("partial", true)          // 账号可用，只是上游忙
                            put("uid", accUid)
                            put("model", model)
                            put("realm", realm)
                            put("endpoint", url)
                            put("elapsed_ms", System.currentTimeMillis() - started)
                            put("status", resp.code)
                            put("msg", lastError)
                        }
                    }

                    Log.w(TAG, "测试 $url 失败: $lastError")
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
