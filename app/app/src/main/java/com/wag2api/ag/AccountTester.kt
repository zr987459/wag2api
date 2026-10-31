package com.wag2api.ag

import okhttp3.MediaType.Companion.toMediaType
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONArray
import org.json.JSONObject
import java.net.SocketTimeoutException
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger

/**
 * 移植自 src/account-tester.mjs：账号连通性测试（强制使用该账号，绕过调度、冷却、封禁标记）。
 * 同步阻塞，在请求线程里跑；testAllAccounts 用临时线程池并发（默认 3）。
 */
object AccountTester {

    /** 上游调用：输入 OkHttp Request，返回 (status, bodyText)。可注入以便测试；默认走 UpstreamFetch.client。 */
    fun interface FetchImpl {
        @Throws(Exception::class)
        fun fetch(request: Request, timeoutMs: Long): Pair<Int, String>
    }

    @JvmField
    val defaultFetch = FetchImpl { request, timeoutMs ->
        val call = UpstreamFetch.client.newCall(request)
        call.timeout().timeout(timeoutMs, TimeUnit.MILLISECONDS)
        try {
            call.execute().use { res -> res.code to (try { res.body?.string() ?: "" } catch (_: Throwable) { "" }) }
        } catch (e: java.io.InterruptedIOException) {
            // 对应 Node 版 AbortController 超时：TimeoutError
            if (call.isCanceled() || e.message?.contains("timeout", true) == true) {
                throw SocketTimeoutException("上游请求超时 (${timeoutMs}ms)")
            }
            throw e
        }
    }

    private val JSON_TYPE = "application/json".toMediaType()

    private fun fail(email: String, model: String, status: Int, latency: Long, error: String): JSONObject =
        JSONObject().put("ok", false).put("email", email).put("model", model)
            .put("status", status).put("latency_ms", latency).put("error", error)

    private fun failWithKind(
        accountPool: AccountPool, email: String, model: String, status: Int, latency: Long,
        errMsg: String, kind: String, validationText: String,
    ): JSONObject {
        val validationUrl: String = try { UpstreamPolicy.extractValidationUrl(validationText) ?: "" } catch (_: Throwable) { "" }
        if (kind == "validation") accountPool.markValidationBlocked(email, errMsg, validationUrl)
        val out = fail(email, model, status, latency, errMsg).put("kind", kind)
        if (validationUrl.isNotEmpty()) out.put("validation_url", validationUrl)
        return out
    }

    private fun errMessage(e: Throwable): String = (e.message ?: e.toString()).take(300)

    /** 把 Cloudcode.buildAntigravityHeaders 的返回（Map 或 JSONObject 或 okhttp Headers）套到请求上。 */
    private fun applyHeaders(b: Request.Builder, h: Any?) {
        when (h) {
            is okhttp3.Headers -> b.headers(h)
            is Map<*, *> -> for ((k, v) in h) if (k != null && v != null) b.header(k.toString(), v.toString())
            is JSONObject -> for (k in h.keys()) b.header(k, h.optString(k))
        }
    }

    @JvmStatic
    @JvmOverloads
    fun testAccount(
        email: String?,
        model: String? = "gemini-3.8-flash",
        accountPool: AccountPool?,
        cooldowns: Cooldowns? = null,
        fetchImpl: FetchImpl = defaultFetch,
        timeoutMs: Long = 30000,
    ): JSONObject {
        val cleanEmail = (email ?: "").trim()
        val targetModel = (model ?: "gemini-3.8-flash").ifEmpty { "gemini-3.8-flash" }.trim()

        if (cleanEmail.isEmpty()) return fail("", targetModel, 400, 0, "缺少 email 参数")
        if (accountPool == null) return fail(cleanEmail, targetModel, 500, 0, "账号池未初始化")
        val mgr = accountPool.getManager(cleanEmail)
            ?: return fail(cleanEmail, targetModel, 404, 0, "账号 $cleanEmail 不存在")

        val startTime = System.currentTimeMillis()

        val tok: String
        try {
            val t = mgr.getValidAccessToken()
            if (t.isNullOrEmpty()) throw Exception("Google 凭据刷新失败 (未获取到 valid access_token)")
            tok = t
            if (mgr.tokenData?.optString("projectId", "").isNullOrEmpty()) {
                try { mgr.ensureProjectId() } catch (_: Throwable) { }
            }
        } catch (err: Throwable) {
            val latency = System.currentTimeMillis() - startTime
            val msg = errMessage(err)
            val kind = UpstreamPolicy.classifyFailure(error = err)
            return failWithKind(accountPool, cleanEmail, targetModel, 401, latency, msg, kind, msg)
        }

        val anthropicReq = JSONObject()
            .put("model", targetModel)
            .put("messages", JSONArray().put(JSONObject().put("role", "user").put("content", "ping")))
            .put("max_tokens", 16)
            .put("temperature", 0.1)

        val payloadAny: Any? = Cloudcode.buildCloudCodePayload(anthropicReq, mgr.tokenData?.optString("projectId", "") ?: "")
        val payload: JSONObject = when (payloadAny) {
            is JSONObject -> payloadAny
            is String -> JSONObject(payloadAny)
            else -> JSONObject(payloadAny.toString())
        }
        payload.optJSONObject("generationConfig")?.let { gc ->
            gc.put("maxOutputTokens", 16)
            gc.put("thinkingConfig", JSONObject().put("includeThoughts", false).put("thinkingBudget", 0))
        }

        val targetUrl = "${Constants.ANTIGRAVITY_ENDPOINT_DAILY}/v1internal:generateContent"

        try {
            val rb = Request.Builder().url(targetUrl).post(payload.toString().toRequestBody(JSON_TYPE))
            applyHeaders(rb, Cloudcode.buildAntigravityHeaders(tok))
            val (status, bodyText) = fetchImpl.fetch(rb.build(), timeoutMs)
            val latency = System.currentTimeMillis() - startTime

            if (status in 200..299) {
                accountPool.clearValidationBlocked(cleanEmail)
                accountPool.clearCooldown(cleanEmail)
                cooldowns?.clearAccount(cleanEmail)

                var reply = "pong"
                try {
                    val j = JSONObject(bodyText)
                    val cand = j.optJSONObject("response")?.optJSONArray("candidates")?.optJSONObject(0)
                        ?: j.optJSONArray("candidates")?.optJSONObject(0)
                    val parts = cand?.optJSONObject("content")?.optJSONArray("parts") ?: JSONArray()
                    var part: JSONObject? = null
                    for (i in 0 until parts.length()) {
                        val p = parts.optJSONObject(i) ?: continue
                        if (p.optString("text").isNotEmpty() && !truthy(p.opt("thought"))) { part = p; break }
                    }
                    if (part == null) for (i in 0 until parts.length()) {
                        val p = parts.optJSONObject(i) ?: continue
                        if (p.optString("text").isNotEmpty()) { part = p; break }
                    }
                    if (part == null) part = parts.optJSONObject(0)
                    val t = part?.opt("text")
                    if (t is String) reply = t.trim()
                } catch (_: Throwable) {
                    if (bodyText.isNotEmpty()) reply = bodyText.trim()
                }
                return JSONObject().put("ok", true).put("email", cleanEmail).put("model", targetModel)
                    .put("status", status).put("latency_ms", latency).put("reply", reply.take(80))
            } else {
                val kind = UpstreamPolicy.classifyFailure(status = status, body = bodyText)
                val errorMsg = bodyText.ifEmpty { "HTTP $status" }.take(300)
                return failWithKind(accountPool, cleanEmail, targetModel, status, latency, errorMsg, kind, bodyText)
            }
        } catch (err: Throwable) {
            val latency = System.currentTimeMillis() - startTime
            val msg = errMessage(err)
            val kind = UpstreamPolicy.classifyFailure(error = err)
            return failWithKind(accountPool, cleanEmail, targetModel, 0, latency, msg, kind, msg)
        }
    }

    /** 并发测试号池内所有账号（默认并发 3），返回 {results:[...]}，顺序与账号顺序一致。 */
    @JvmStatic
    @JvmOverloads
    fun testAllAccounts(
        model: String? = "gemini-3.8-flash",
        accountPool: AccountPool?,
        cooldowns: Cooldowns? = null,
        fetchImpl: FetchImpl = defaultFetch,
        concurrency: Int = 3,
        timeoutMs: Long = 30000,
    ): JSONObject {
        if (accountPool == null) return JSONObject().put("results", JSONArray())
        val emails = accountPool.managers.keys.toList()
        if (emails.isEmpty()) return JSONObject().put("results", JSONArray())

        val results = arrayOfNulls<JSONObject>(emails.size)
        val next = AtomicInteger(0)
        val workerCount = Math.max(1, Math.min(concurrency, emails.size))
        val pool = Executors.newFixedThreadPool(workerCount) { r -> Thread(r, "ag-test-all").apply { isDaemon = true } }
        try {
            val futures = (0 until workerCount).map {
                pool.submit {
                    while (true) {
                        val cur = next.getAndIncrement()
                        if (cur >= emails.size) break
                        results[cur] = try {
                            testAccount(emails[cur], model, accountPool, cooldowns, fetchImpl, timeoutMs)
                        } catch (e: Throwable) {
                            fail(emails[cur], model ?: "gemini-3.8-flash", 0, 0, errMessage(e))
                        }
                    }
                }
            }
            for (f in futures) f.get()
        } finally {
            pool.shutdown()
        }
        val arr = JSONArray()
        for (r in results) arr.put(r ?: JSONObject.NULL)
        return JSONObject().put("results", arr)
    }

    private fun truthy(v: Any?): Boolean = when (v) {
        null, JSONObject.NULL -> false
        is Boolean -> v
        is Number -> v.toDouble() != 0.0
        is String -> v.isNotEmpty()
        else -> true
    }
}
