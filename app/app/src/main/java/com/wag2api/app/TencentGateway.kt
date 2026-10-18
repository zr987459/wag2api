package com.wag2api.app

import okhttp3.*
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONArray
import org.json.JSONObject
import java.io.BufferedReader
import java.io.InputStreamReader
import java.io.IOException
import java.security.MessageDigest
import java.util.UUID
import java.util.concurrent.TimeUnit
import android.util.Log

class UpstreamException(
    val status: Int,
    val code: Int?,
    val endpoint: String,
    val snippet: String
) : IOException("upstream HTTP $status code=$code @ $endpoint: $snippet")

object TencentGateway {

    private const val TAG = "TencentGateway"

    /** 最多轮换几个账号 */
    private const val MAX_ACCOUNT_ATTEMPTS = 3
    /** 换账号前的退避时长 */
    private const val RETRY_BACKOFF_MS = 1200L
    /** 全部繁忙时的额外退避轮数 */
    private const val FINAL_BACKOFF_ROUNDS = 2

    /** 由 GatewayService 在启动时注入，供账号调度器读取偏好 */
    @Volatile private var appCtx: android.content.Context? = null
    fun attach(ctx: android.content.Context) { appCtx = ctx.applicationContext }
    private fun applicationContextOrNull(): android.content.Context =
        appCtx ?: throw IllegalStateException("TencentGateway 未初始化")

    private fun upstreamCode(line: String): Int? {
        val s = line.removePrefix("data:").trim()
        if (!s.startsWith("{")) return null
        return try { JSONObject(s).takeIf { it.has("code") }?.optInt("code") } catch (e: Exception) { null }
    }

    private fun isChannelCheck(code: Int?, body: String): Boolean {
        if (code == 11128 || body.contains("11128") || body.contains("11-128")) {
            val lower = body.lowercase()
            return body.contains("渠道校验") || lower.contains("channel verification") || lower.contains("official client")
        }
        return false
    }

    private fun isWafBlocked(status: Int, body: String): Boolean {
        return status == 403 && (body.contains("WAF Block Page") || body.contains("myqcloud.com") || !body.contains("\"code\":"))
    }

    private fun shouldTryNext(status: Int, code: Int?, body: String): Boolean {
        if (status == 404 || status >= 500) return true
        if (isChannelCheck(code, body)) return true
        if (isWafBlocked(status, body)) return true
        return false
    }

    /** 429 / 14003：上游限流（模型繁忙），属于可重试的瞬时错误 */
    private fun isRateLimited(status: Int, code: Int?, body: String): Boolean {
        if (status == 429) return true
        if (code == 14003) return true
        val lower = body.lowercase()
        return lower.contains("too many requests") ||
                lower.contains("model busy") ||
                lower.contains("模型繁忙") ||
                lower.contains("saturated")
    }

    /** 401 / 403：token 失效，需要刷新 */
    private fun isAuthExpired(status: Int, body: String): Boolean {
        if (status == 401) return true
        if (status == 403 && !isWafBlocked(status, body)) {
            val lower = body.lowercase()
            return lower.contains("unauthorized") ||
                    lower.contains("token expired") ||
                    lower.contains("invalid token") ||
                    lower.contains("登录") ||
                    lower.contains("expired")
        }
        return false
    }

    // LRU 缓存：$uid:$tool_call_id -> reasoning_content
    // 内存上限设为 100 条，保护手机内存低耗运行
    private val reasoningCache = object : LinkedHashMap<String, String>(50, 0.75f, true) {
        override fun removeEldestEntry(eldest: MutableMap.MutableEntry<String, String>?): Boolean = size > 100
    }

    @Synchronized
    fun recordReasoning(key: String, content: String) {
        if (key.isNotEmpty() && content.isNotEmpty()) {
            reasoningCache[key] = content
        }
    }

    @Synchronized
    fun getReasoning(key: String): String? = reasoningCache[key]

    const val UPSTREAM_GLOBAL = "https://www.workbuddy.ai"
    const val UPSTREAM_CN = "https://copilot.tencent.com"
    const val CLIENT_UA = "WorkBuddy/5.5.4 WorkBuddy AI/5.5.4 CLI/2.137.1"
    const val DEFAULT_SYSTEM_PROMPT = "You are WorkBuddy, an advanced AI programming assistant developed by Tencent."

    // 模型别名映射（将客户端常用别名与快照映射至腾讯官方标准模型 ID）
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

    private val jsonMedia = "application/json; charset=utf-8".toMediaType()

    private val okHttpClient = OkHttpClient.Builder()
        .connectTimeout(15, TimeUnit.SECONDS)
        .readTimeout(180, TimeUnit.SECONDS)
        .writeTimeout(60, TimeUnit.SECONDS)
        .build()

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

    fun startLogin(realm: String = "global"): JSONObject {
        val base = if (realm == "global") UPSTREAM_GLOBAL else UPSTREAM_CN
        val origin = if (realm == "global") UPSTREAM_GLOBAL else "https://www.codebuddy.cn"

        val req = Request.Builder()
            .url("$base/v2/plugin/auth/state?platform=CLI")
            .header("Origin", origin)
            .header("Referer", "$origin/")
            .header("User-Agent", CLIENT_UA)
            .post("{}".toRequestBody(jsonMedia))
            .build()

        okHttpClient.newCall(req).execute().use { resp ->
            val body = resp.body?.string() ?: ""
            val json = JSONObject(body)
            if (json.optInt("code") == 0 && json.has("data")) {
                val data = json.getJSONObject("data")
                return JSONObject().apply {
                    put("ok", true)
                    put("state", data.optString("state"))
                    put("url", data.optString("authUrl"))
                    put("realm", realm)
                }
            }
            return JSONObject().apply {
                put("ok", false)
                put("error", json.optString("msg", "未知错误"))
            }
        }
    }

    fun pollLogin(state: String): JSONObject {
        for (tuple in listOf(
            Triple(UPSTREAM_GLOBAL, UPSTREAM_GLOBAL, "global"),
            Triple(UPSTREAM_CN, "https://www.codebuddy.cn", "cn")
        )) {
            val base = tuple.first
            val origin = tuple.second
            val realm = tuple.third

            try {
                val req = Request.Builder()
                    .url("$base/v2/plugin/auth/token?state=$state")
                    .header("Origin", origin)
                    .header("Referer", "$origin/")
                    .header("User-Agent", CLIENT_UA)
                    .get()
                    .build()

                okHttpClient.newCall(req).execute().use { resp ->
                    val body = resp.body?.string() ?: ""
                    val json = JSONObject(body)
                    if (json.optInt("code") == 0 && json.has("data")) {
                        val tok = json.getJSONObject("data")
                        val accessToken = tok.optString("accessToken")
                        if (accessToken.isNotEmpty()) {
                            var uid = "user_${System.currentTimeMillis()}"
                            var nickname = "WorkBuddy用户"

                            try {
                                val acctReq = Request.Builder()
                                    .url("$base/v2/plugin/login/account?state=$state")
                                    .header("Origin", origin)
                                    .header("Referer", "$origin/")
                                    .header("User-Agent", CLIENT_UA)
                                    .header("Authorization", "Bearer $accessToken")
                                    .get()
                                    .build()
                                okHttpClient.newCall(acctReq).execute().use { ar ->
                                    val ab = ar.body?.string() ?: ""
                                    val aj = JSONObject(ab).optJSONObject("data")
                                    if (aj != null && aj.has("uid")) {
                                        uid = aj.optString("uid")
                                        nickname = aj.optString("nickname", nickname)
                                    }
                                }
                            } catch (ignored: Exception) {}

                            // 保存到本地账号库
                            AccountVault.saveAccount(uid, nickname, realm, accessToken, tok.optString("refreshToken", ""))

                            return JSONObject().apply {
                                put("ok", true)
                                put("done", true)
                                put("uid", uid)
                                put("nickname", nickname)
                                put("realm", realm)
                            }
                        }
                    }
                }
            } catch (ignored: Exception) {}
        }

        return JSONObject().apply {
            put("ok", true)
            put("done", false)
            put("message", "waiting for login")
        }
    }

    fun chatSync(payload: JSONObject, convId: String? = null): JSONObject {
        val modelRaw = payload.optString("model", "deepseek-v4.1-flash-1017")
        val modelLower = modelRaw.lowercase()
        val realm = if (modelLower.startsWith("cn:")) "cn" else "global"
        val sb = StringBuilder()
        val sbReasoning = StringBuilder()
        var lastChunkPromptTokens = 20
        var lastChunkCompTokens = 20
        var upstreamError: String? = null
        val toolCallsMap = HashMap<Int, JSONObject>()

        streamChat(payload, convId) { line ->
            val trimmed = line.trim()
            if (trimmed.startsWith("data: ") && trimmed != "data: [DONE]") {
                try {
                    val chunk = JSONObject(trimmed.substring(6))
                    if (chunk.has("error")) {
                        upstreamError = chunk.optString("error")
                    }
                    val choice = chunk.optJSONArray("choices")?.optJSONObject(0)
                    val delta = choice?.optJSONObject("delta")
                    val content = delta?.optString("content", "") ?: ""
                    if (content.isNotEmpty()) {
                        sb.append(content)
                    }
                    val reasoning = delta?.optString("reasoning_content", "") ?: ""
                    if (reasoning.isNotEmpty()) {
                        sbReasoning.append(reasoning)
                    }
                    val toolCalls = delta?.optJSONArray("tool_calls")
                    if (toolCalls != null) {
                        for (i in 0 until toolCalls.length()) {
                            val tc = toolCalls.optJSONObject(i) ?: continue
                            val idx = tc.optInt("index", i)
                            val slot = toolCallsMap.getOrPut(idx) {
                                JSONObject().apply {
                                    put("id", tc.optString("id", "call_${UUID.randomUUID().toString().take(8)}"))
                                    put("type", "function")
                                    put("function", JSONObject().apply {
                                        put("name", "")
                                        put("arguments", "")
                                    })
                                }
                            }
                            val fn = slot.getJSONObject("function")
                            val deltaFn = tc.optJSONObject("function")
                            if (deltaFn != null) {
                                val namePiece = deltaFn.optString("name", "")
                                if (namePiece.isNotEmpty()) {
                                    fn.put("name", fn.optString("name", "") + namePiece)
                                }
                                val argPiece = deltaFn.optString("arguments", "")
                                if (argPiece.isNotEmpty()) {
                                    fn.put("arguments", fn.optString("arguments", "") + argPiece)
                                }
                            }
                        }
                    }
                    val usage = chunk.optJSONObject("usage")
                    if (usage != null) {
                        lastChunkPromptTokens = usage.optInt("prompt_tokens", lastChunkPromptTokens)
                        lastChunkCompTokens = usage.optInt("completion_tokens", lastChunkCompTokens)
                    }
                } catch (ignored: Exception) {}
            }
            true
        }

        if (upstreamError != null) {
            throw IOException("Upstream error: $upstreamError")
        }

        val text = sb.toString()
        val hasTools = toolCallsMap.isNotEmpty()
        if (text.isEmpty() && !hasTools) {
            throw IOException("Upstream returned empty completion")
        }

        val toolCallsArray = JSONArray()
        for (slot in toolCallsMap.values) {
            toolCallsArray.put(slot)
        }

        val fullR = sbReasoning.toString()
        val acc = AccountVault.getActiveAccount(realm)
        val uid = acc?.optString("uid", "user_default") ?: "user_default"
        if (fullR.isNotEmpty()) {
            for (slot in toolCallsMap.values) {
                val tid = slot.optString("id")
                if (tid.isNotEmpty()) {
                    recordReasoning("$uid:$tid", fullR)
                }
            }
        }

        return JSONObject().apply {
            put("content", text)
            put("reasoning_content", sbReasoning.toString())
            if (hasTools) {
                put("tool_calls", toolCallsArray)
            }
            put("prompt_tokens", lastChunkPromptTokens)
            put("completion_tokens", maxOf(lastChunkCompTokens, (text.length + sbReasoning.length) / 2))
        }
    }

    /**
     * 流式调用：采用黑名单思想，完整保留 tools / tool_choice / reasoning_effort / temperature 等所有客户端参数！
     *
     * 重试策略（三层）：
     *  1. 端点回退：/v2 → /console（404 / 5xx / 渠道校验 / WAF）
     *  2. 账号轮换：429 / 14003（模型繁忙）时给该账号打短冷却，立刻换下一个账号
     *  3. 同账号退避：所有账号都繁忙时，退避重试若干次，因为腾讯的限流是瞬时的
     */
    fun streamChat(
        payload: JSONObject,
        convId: String? = null,
        onLine: (String) -> Boolean
    ) {
        val modelRaw = payload.optString("model", "deepseek-v4.1-flash-1017")
        val modelLower = modelRaw.lowercase()
        val realm = if (modelLower.startsWith("cn:")) "cn" else "global"
        var cleanModel = modelLower.removePrefix("global:").removePrefix("cn:")
        cleanModel = MODEL_ALIASES[cleanModel] ?: cleanModel

        val ctx = applicationContextOrNull()
        val base = if (realm == "global") UPSTREAM_GLOBAL else UPSTREAM_CN

        // 复制上游 Payload，仅做 model 映射与 messages[0]=system 规范化，其余字段完整透传
        val upstreamPayload = JSONObject(payload.toString())
        upstreamPayload.put("model", cleanModel)
        upstreamPayload.put("stream", true)
        upstreamPayload.put("stream_options", JSONObject().put("include_usage", true))

        val messagesArray = upstreamPayload.optJSONArray("messages") ?: JSONArray()
        val normMessages = JSONArray()
        var hasSystem = false
        if (messagesArray.length() > 0) {
            val first = messagesArray.optJSONObject(0)
            val role = first?.optString("role")
            if (role == "system") {
                hasSystem = true
            } else if (role == "developer") {
                first.put("role", "system")
                hasSystem = true
            }
        }
        if (!hasSystem) {
            normMessages.put(JSONObject().apply {
                put("role", "system")
                put("content", DEFAULT_SYSTEM_PROMPT)
            })
        }
        for (i in 0 until messagesArray.length()) {
            normMessages.put(messagesArray.getJSONObject(i))
        }

        // 出站脱敏：上游对请求体中的裸数字 11-128 有敏感拦截探测，改写消除误触发
        for (i in 0 until normMessages.length()) {
            val m = normMessages.optJSONObject(i) ?: continue
            val c = m.opt("content")
            if (c is String && c.contains("11-128")) {
                m.put("content", c.replace("11-128", "11-128"))
            }
        }

        upstreamPayload.put("messages", normMessages)

        // 找到真正的新一轮 user 消息索引（排除紧跟在 role:tool 后的 user 拆分片段）
        var lastUserIdx = -1
        for (i in 0 until normMessages.length()) {
            val curr = normMessages.optJSONObject(i)
            if (curr?.optString("role") == "user") {
                val prev = if (i > 0) normMessages.optJSONObject(i - 1) else null
                if (prev == null || prev.optString("role") != "tool") {
                    lastUserIdx = i
                }
            }
        }

        // 只补当前轮次（最后一条 user 之后）的 assistant 消息，绝不污染历史更早轮次
        if (lastUserIdx >= 0) {
            for (i in (lastUserIdx + 1) until normMessages.length()) {
                val m = normMessages.optJSONObject(i) ?: continue
                if (m.optString("role") == "assistant" && m.optString("reasoning_content").isEmpty()) {
                    val calls = m.optJSONArray("tool_calls")
                    if (calls != null && calls.length() > 0) {
                        for (k in 0 until calls.length()) {
                            val id = calls.getJSONObject(k).optString("id")
                            if (id.isNotEmpty()) {
                                // 按 $uid:$tool_call_id 精准匹配，避免跨账号串味
                                val cached = getReasoning("$uid:$id")
                                if (!cached.isNullOrEmpty()) {
                                    m.put("reasoning_content", cached)
                                    break
                                }
                            }
                        }
                    }
                }
            }
        }

        val endpoints = listOf("$base/v2/chat/completions", "$base/console/chat/completions")
        val cId = convId ?: UUID.randomUUID().toString().replace("-", "")

        var lastErr: Exception? = null
        val triedUids = LinkedHashSet<String>()
        // 一旦已经向客户端吐过字，就不能再重试，否则会出现重复输出
        var emittedAny = false

        // 最多轮换 3 个账号；每个账号内部再按端点回退
        for (attempt in 1..MAX_ACCOUNT_ATTEMPTS) {
            val acc = AccountScheduler.pick(ctx, realm, triedUids)
                ?: AccountVault.getActiveAccount(realm)
                ?: throw IllegalStateException("未登录账号，请先在面板添加账号")

            val uid = acc.optString("uid", "user_default")
            triedUids.add(uid)

            val machineId = sha256Prefix("wb2a:machine:$uid")
            val sessionId = sha256Prefix("wb2a:session:$uid")

            var rateLimited = false

            for ((i, url) in endpoints.withIndex()) {
                val isLast = i == endpoints.lastIndex
                val reqBuilder = Request.Builder()
                    .url(url)
                    .header("Authorization", "Bearer ${acc.optString("accessToken")}")
                    .header("Content-Type", "application/json")
                    .header("Accept", "application/json, text/event-stream")
                    .header("Accept-Language", if (realm == "global") "en-US" else "zh-CN")
                    .header("X-Requested-With", "XMLHttpRequest")
                    .header("X-CodeBuddy-Request", "1")
                    .header("User-Agent", CLIENT_UA)
                    .header("Origin", base)
                    .header("Referer", "$base/")
                    .header("X-User-Id", uid)
                    .header("X-Product", "WorkBuddy")
                    .header("X-Agent-Purpose", "conversation")
                    .header("X-IDE-Name", "WorkBuddy")
                    .header("X-IDE-Type", "WorkBuddy")
                    .header("X-IDE-Version", "5.5.4")
                    .header("X-Machine-ID", machineId)
                    .header("X-Session-ID", sessionId)
                    .header("X-Conversation-ID", cId)
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

                val req = reqBuilder.post(upstreamPayload.toString().toRequestBody(jsonMedia)).build()

                try {
                    okHttpClient.newCall(req).execute().use { resp ->
                        if (!resp.isSuccessful) {
                            val body = resp.body?.string().orEmpty()
                            val errCode = upstreamCode(body)
                            val snippet = if (isWafBlocked(resp.code, body)) {
                                "Tencent Cloud WAF blocked request (pattern in prompt)"
                            } else {
                                body.take(300)
                            }
                            val err = UpstreamException(resp.code, errCode, url, snippet)
                            Log.w(TAG, err.message ?: "")

                            // 429 / 14003：限流，打冷却 + 换账号
                            if (isRateLimited(resp.code, errCode, body)) {
                                rateLimited = true
                                AccountScheduler.markCooling(uid)
                                lastErr = err
                                return@use
                            }

                            // token 失效：先尝试刷新，再换账号
                            if (isAuthExpired(resp.code, body)) {
                                TokenKeeper.refreshIfPossible(uid)
                                lastErr = err
                                return@use
                            }

                            if (!isLast && shouldTryNext(resp.code, errCode, body)) {
                                lastErr = err
                                return@use
                            }
                            throw err
                        }

                        val source = resp.body?.source()
                            ?: throw IOException("empty upstream body @ $url")
                        var first = true
                        val reasoningBuf = java.lang.StringBuilder()
                        val toolIds = java.util.ArrayList<String>()

                        while (!source.exhausted()) {
                            val line = source.readUtf8Line() ?: break
                            if (line.isEmpty()) continue
                            if (first) {
                                first = false
                                val code = upstreamCode(line)
                                if (code != null && code != 0) {
                                    val err = UpstreamException(resp.code, code, url, line.take(500))
                                    // 首帧就是限流错误：还没吐字，安全重试
                                    if (isRateLimited(resp.code, code, line)) {
                                        rateLimited = true
                                        AccountScheduler.markCooling(uid)
                                        lastErr = err
                                        return@use
                                    }
                                    if (!isLast && shouldTryNext(resp.code, code, line)) {
                                        lastErr = err
                                        return@use
                                    }
                                    throw err
                                }
                            }

                            try {
                                if (line.startsWith("data: ")) {
                                    val s = line.substring(6).trim()
                                    if (s.startsWith("{") && s != "[DONE]") {
                                        val delta = JSONObject(s).optJSONArray("choices")
                                            ?.optJSONObject(0)?.optJSONObject("delta")
                                        val r = delta?.optString("reasoning_content")
                                        if (!r.isNullOrEmpty()) reasoningBuf.append(r)
                                        val tc = delta?.optJSONArray("tool_calls")
                                        if (tc != null) {
                                            for (idx in 0 until tc.length()) {
                                                val tid = tc.getJSONObject(idx).optString("id")
                                                if (tid.isNotEmpty()) toolIds.add(tid)
                                            }
                                        }
                                    }
                                }
                            } catch (ignored: Exception) {}

                            emittedAny = true
                            val keepGoing = onLine("$line\n\n")
                            if (!keepGoing) break
                        }

                        if (reasoningBuf.isNotEmpty()) {
                            val fullR = reasoningBuf.toString()
                            for (tid in toolIds) {
                                recordReasoning("$uid:$tid", fullR)
                            }
                        }

                        AccountScheduler.touch(uid)
                        return
                    }
                } catch (e: UpstreamException) {
                    // 限流已在上面处理；其余错误若还有端点可退，继续
                    if (!isLast && !rateLimited) {
                        lastErr = e
                        continue
                    }
                    if (rateLimited) continue
                    throw e
                } catch (e: IOException) {
                    Log.w(TAG, "network error @ $url: ${e.message}")
                    lastErr = e
                    if (isLast) continue
                }
            }

            // 已经吐字给客户端了，无论成败都不能再重试（否则重复输出）
            if (emittedAny) {
                lastErr?.let { throw it }
                return
            }

            // 这个账号的所有端点都试完了
            if (!rateLimited && lastErr == null) break
            if (attempt < MAX_ACCOUNT_ATTEMPTS) {
                // 全是限流的话，短暂退避再换账号（腾讯限流是瞬时的）
                if (rateLimited) Thread.sleep(RETRY_BACKOFF_MS)
            }
        }

        // 已经吐字了就不再退避重试，直接结束
        if (emittedAny) return

        // 所有账号都被限流：最后再做一轮退避重试
        for (round in 1..FINAL_BACKOFF_ROUNDS) {
            val acc = AccountScheduler.pick(ctx, realm, emptySet())
                ?: AccountVault.getActiveAccount(realm)
                ?: break
            Log.i(TAG, "全部账号繁忙，退避第 $round 轮重试")
            Thread.sleep(RETRY_BACKOFF_MS * round)
            try {
                AccountScheduler.clearAllCooldowns()
                streamChat(payload, convId, onLine)
                return
            } catch (e: Exception) {
                lastErr = e
            }
        }

        lastErr?.let { throw it }
    }
}
