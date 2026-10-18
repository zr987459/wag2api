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

    /** 按 tool_call_id 后缀查找思考内容（不依赖当前账号，兼容多账号轮换） */
    @Synchronized
    fun getReasoningByToolId(toolCallId: String): String? {
        if (toolCallId.isEmpty()) return null
        val suffix = ":$toolCallId"
        for ((k, v) in reasoningCache) {
            if (k.endsWith(suffix)) return v
        }
        return null
    }

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

        // reasoning 已由 streamChat 按「实际使用的 uid」写入缓存，这里不再用 getActiveAccount 的 uid 重复写

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
                                // 按 tool_call_id 后缀匹配（跨账号可见：换号重试后仍能补回思考内容）
                                val cached = getReasoningByToolId(id)
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
        val bodyText = upstreamPayload.toString()
        val state = StreamState()

        var lastErr: Exception? = null
        var backoffRound = 0
        val tried = LinkedHashSet<String>()

        // 有界的迭代式重试：每轮最多换 MAX_ACCOUNT_ATTEMPTS 个账号；整轮都是限流才退避进下一轮，
        // 最多 FINAL_BACKOFF_ROUNDS 轮。不递归、不无限循环。
        while (true) {
            val acc = if (tried.size >= MAX_ACCOUNT_ATTEMPTS) null
                      else AccountScheduler.acquire(ctx, realm, tried)
            if (acc == null) {
                if (tried.isEmpty()) throw IllegalStateException("未登录账号，请先在面板添加账号")
                // 本轮账号已用尽：只有「全是限流」才值得退避重来
                if (lastErr !is RateLimitedException || backoffRound >= FINAL_BACKOFF_ROUNDS) break
                backoffRound++
                Log.i(TAG, "全部账号繁忙，退避第 $backoffRound 轮重试")
                sleepOrAbort(RETRY_BACKOFF_MS * backoffRound)
                tried.clear()
                continue
            }

            val uid = acc.optString("uid", "user_default")
            tried.add(uid)
            try {
                tryAccount(acc, uid, realm, base, endpoints, cId, bodyText, state, onLine)
                return
            } catch (e: RateLimitedException) {
                AccountScheduler.markCooling(uid)
                lastErr = e
                if (tried.size < MAX_ACCOUNT_ATTEMPTS) sleepOrAbort(RETRY_BACKOFF_MS / 4)
            } catch (e: RetryOnNextAccount) {
                lastErr = e.cause as? Exception ?: e
            } finally {
                AccountScheduler.release(uid)
            }
            // 已经向客户端吐过字：tryAccount 会直接抛出，不会走到这里；此处兜底再挡一次
            if (state.emitted) throw (lastErr ?: IOException("stream aborted after partial output"))
        }

        val finalErr: Exception = lastErr ?: IOException("all upstream attempts failed")
        // 把内部包装拆掉，让 errorPayload 能拿到原始 UpstreamException(429 等) 映射状态码
        throw (finalErr as? RateLimitedException)?.cause as? Exception ?: finalErr
    }

    private class StreamState { var emitted = false }

    /** 本账号被限流：换账号 */
    private class RateLimitedException(cause: Exception) : IOException(cause.message, cause)
    /** 本账号所有端点都失败但可换号重试（网络错误 / 401 刷新失败 / 端点全回退完） */
    private class RetryOnNextAccount(cause: Exception) : IOException(cause.message, cause)

    private fun sleepOrAbort(ms: Long) {
        try { Thread.sleep(ms) } catch (e: InterruptedException) {
            Thread.currentThread().interrupt()
            throw IOException("interrupted during backoff")
        }
    }

    /**
     * 用一个账号把请求打完。
     * 成功：正常返回。可重试：抛 RateLimitedException / RetryOnNextAccount（保证此时一个字都没吐）。
     * 不可重试或已吐字后出错：抛原始异常。
     */
    private fun tryAccount(
        acc: JSONObject, uid: String, realm: String, base: String,
        endpoints: List<String>, cId: String, bodyText: String,
        state: StreamState, onLine: (String) -> Boolean
    ) {
        val machineId = sha256Prefix("wb2a:machine:$uid")
        val sessionId = sha256Prefix("wb2a:session:$uid")
        var token = acc.optString("accessToken")
        var authRetried = false
        var lastErr: Exception? = null
        var i = 0

        while (i < endpoints.size) {
            val url = endpoints[i]
            val isLast = i == endpoints.lastIndex
            val req = buildChatRequest(url, token, uid, realm, base, machineId, sessionId, cId, bodyText)

            try {
                okHttpClient.newCall(req).execute().use { resp ->
                    if (!resp.isSuccessful) {
                        val body = resp.body?.string().orEmpty()
                        val errCode = upstreamCode(body)
                        val snippet = if (isWafBlocked(resp.code, body)) {
                            "Tencent Cloud WAF blocked request (pattern in prompt)"
                        } else body.take(300)
                        val err = UpstreamException(resp.code, errCode, url, snippet)
                        Log.w(TAG, err.message ?: "")

                        if (isRateLimited(resp.code, errCode, body)) throw RateLimitedException(err)

                        if (isAuthExpired(resp.code, body)) {
                            // 401：刷新一次并用新 token 重打同一端点；刷新失败则换号
                            val fresh = if (authRetried) null else TokenKeeper.refresh(uid, token)
                            if (fresh != null) {
                                authRetried = true
                                token = fresh
                                return@use          // i 不变 → 重试同一端点
                            }
                            throw RetryOnNextAccount(err)
                        }

                        if (!isLast && shouldTryNext(resp.code, errCode, body)) {
                            lastErr = err
                            i++
                            return@use
                        }
                        throw err
                    }

                    val source = resp.body?.source() ?: throw IOException("empty upstream body @ $url")
                    val reasoningBuf = StringBuilder()
                    val toolIds = ArrayList<String>()
                    // 首个 data 帧之前的行（注释 / event:）先缓存，确认不是错误帧再一起下发
                    val pending = ArrayList<String>()
                    var checked = false

                    while (true) {
                        val line = source.readUtf8Line() ?: break
                        if (line.isEmpty()) continue

                        if (!checked) {
                            if (!line.startsWith("data:")) { pending.add(line); continue }
                            checked = true
                            val code = upstreamCode(line)
                            if (code != null && code != 0) {
                                val err = UpstreamException(resp.code, code, url, line.take(500))
                                if (isRateLimited(resp.code, code, line)) throw RateLimitedException(err)
                                if (!isLast && shouldTryNext(resp.code, code, line)) {
                                    lastErr = err
                                    i++
                                    return@use
                                }
                                throw err
                            }
                        }

                        collectReasoning(line, reasoningBuf, toolIds)

                        var keepGoing = true
                        if (pending.isNotEmpty()) {
                            for (p in pending) {
                                state.emitted = true
                                if (!onLine("$p\n\n")) { keepGoing = false; break }
                            }
                            pending.clear()
                        }
                        if (keepGoing) {
                            state.emitted = true          // 先置位再写：写到一半抛异常也算已吐字
                            keepGoing = onLine("$line\n\n")
                        }
                        if (!keepGoing) break             // 客户端断开：正常结束，不重试
                    }

                    if (reasoningBuf.isNotEmpty()) {
                        val fullR = reasoningBuf.toString()
                        for (tid in toolIds) recordReasoning("$uid:$tid", fullR)
                    }
                    return
                }
            } catch (e: RateLimitedException) {
                throw e
            } catch (e: RetryOnNextAccount) {
                throw e
            } catch (e: IOException) {
                // 吐过字后的任何异常（含 UpstreamException、断网、客户端写失败）都不能重试，否则重复输出
                if (state.emitted) throw e
                if (e is UpstreamException) throw e
                Log.w(TAG, "network error @ $url: ${e.message}")
                lastErr = e
                if (isLast) throw RetryOnNextAccount(e)
                i++
            }
        }
        throw RetryOnNextAccount(lastErr ?: IOException("no endpoint succeeded"))
    }

    private fun collectReasoning(line: String, buf: StringBuilder, toolIds: MutableList<String>) {
        if (!line.startsWith("data: ")) return
        val s = line.substring(6).trim()
        if (!s.startsWith("{")) return
        try {
            val delta = JSONObject(s).optJSONArray("choices")?.optJSONObject(0)?.optJSONObject("delta") ?: return
            val r = delta.optString("reasoning_content")
            if (r.isNotEmpty()) buf.append(r)
            val tc = delta.optJSONArray("tool_calls") ?: return
            for (idx in 0 until tc.length()) {
                val tid = tc.optJSONObject(idx)?.optString("id").orEmpty()
                if (tid.isNotEmpty()) toolIds.add(tid)
            }
        } catch (ignored: Exception) {}
    }

    private fun buildChatRequest(
        url: String, token: String, uid: String, realm: String, base: String,
        machineId: String, sessionId: String, cId: String, bodyText: String
    ): Request {
        val b = Request.Builder()
            .url(url)
            .header("Authorization", "Bearer $token")
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
            .header("X-No-Enterprise-Id", "1")
        if (realm == "global") b.header("X-Domain", "www.workbuddy.ai")
        else b.header("X-No-Department-Info", "1")
        return b.post(bodyText.toRequestBody(jsonMedia)).build()
    }
}
