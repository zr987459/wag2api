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
        val bodyStr = upstreamPayload.toString()

        var lastErr: Exception? = null
        var attemptedAny = false

        // 外层：全忙退避轮次（迭代，不递归）。round 0 是正常尝试，之后只有「本轮全部失败都是限流」才进入。
        for (round in 0..FINAL_BACKOFF_ROUNDS) {
            if (round > 0) {
                Log.i(TAG, "全部账号繁忙，退避第 $round 轮重试")
                // SSE 注释帧：客户端会忽略；顺便探测客户端是否已断开，断开就别再空转
                if (!onLine(": upstream busy, retrying\n\n")) return
                Thread.sleep(RETRY_BACKOFF_MS * round)
            }

            val triedUids = LinkedHashSet<String>()
            var allRateLimited = true
            var attemptedThisRound = false

            // 中层：账号轮换，最多 MAX_ACCOUNT_ATTEMPTS 个不同账号
            for (attempt in 1..MAX_ACCOUNT_ATTEMPTS) {
                val acc = AccountScheduler.pick(ctx, realm, triedUids) ?: break
                val uid = acc.optString("uid", "user_default")
                triedUids.add(uid)
                attemptedThisRound = true
                attemptedAny = true

                // 内层：端点回退 + 401 刷新后重放一次（见 attemptAccount）
                when (val r = attemptAccount(acc, realm, base, endpoints, bodyStr, cId, onLine)) {
                    is Attempt.Done -> return
                    is Attempt.RateLimited -> lastErr = r.err
                    is Attempt.Failed -> { lastErr = r.err; allRateLimited = false }
                }
            }

            if (!attemptedAny) throw IllegalStateException("未登录账号，请先在面板添加账号")
            if (!attemptedThisRound || !allRateLimited) break
        }

        throw lastErr ?: IOException("upstream request failed")
    }

    private sealed class Attempt {
        object Done : Attempt()
        class RateLimited(val err: Exception) : Attempt()
        class Failed(val err: Exception) : Attempt()
    }

    private fun buildChatRequest(
        url: String, acc: JSONObject, uid: String, realm: String, base: String,
        machineId: String, sessionId: String, cId: String, body: String
    ): Request {
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
        return reqBuilder.post(body.toRequestBody(jsonMedia)).build()
    }

    /**
     * 用一个账号跑完「端点回退」：
     *  - 429 / 14003：打冷却，立即返回 RateLimited（不再拿同一个账号去打第二个端点）
     *  - 401 / token 失效：刷新，成功则用新 token 从第一个端点重放一次
     *  - 404 / 5xx / 渠道校验 / WAF：换下一个端点；最后一个端点仍失败则直接抛给客户端
     *  - 网络错误：未吐字 → 换端点；已吐字 → 立即抛出，绝不重放（否则客户端会收到重复内容）
     */
    private fun attemptAccount(
        accIn: JSONObject, realm: String, base: String, endpoints: List<String>,
        body: String, cId: String, onLine: (String) -> Boolean
    ): Attempt {
        var acc = accIn
        val uid = acc.optString("uid", "user_default")
        val machineId = sha256Prefix("wb2a:machine:$uid")
        val sessionId = sha256Prefix("wb2a:session:$uid")
        var lastErr: Exception? = null

        for (pass in 0..1) {
            var authExpired = false

            for ((i, url) in endpoints.withIndex()) {
                val isLast = i == endpoints.lastIndex
                val req = buildChatRequest(url, acc, uid, realm, base, machineId, sessionId, cId, body)
                var emitted = false

                try {
                    okHttpClient.newCall(req).execute().use { resp ->
                        if (!resp.isSuccessful) {
                            val errBody = resp.body?.string().orEmpty()
                            val errCode = upstreamCode(errBody)
                            val snippet = if (isWafBlocked(resp.code, errBody)) {
                                "Tencent Cloud WAF blocked request (pattern in prompt)"
                            } else {
                                errBody.take(300)
                            }
                            val err = UpstreamException(resp.code, errCode, url, snippet)
                            Log.w(TAG, err.message ?: "")

                            if (isRateLimited(resp.code, errCode, errBody)) {
                                AccountScheduler.markCooling(uid)
                                return Attempt.RateLimited(err)
                            }
                            if (isAuthExpired(resp.code, errBody)) {
                                lastErr = err
                                authExpired = true
                                return@use
                            }
                            if (!isLast && shouldTryNext(resp.code, errCode, errBody)) {
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
                                        AccountScheduler.markCooling(uid)
                                        return Attempt.RateLimited(err)
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

                            // 必须在 onLine 之前置位：onLine 内部写了一半再抛异常也算已吐字
                            emitted = true
                            if (!onLine("$line\n\n")) break   // 客户端断开：结束，不重试
                        }

                        if (reasoningBuf.isNotEmpty()) {
                            val fullR = reasoningBuf.toString()
                            for (tid in toolIds) {
                                recordReasoning("$uid:$tid", fullR)
                            }
                        }

                        AccountScheduler.touch(uid)
                        return Attempt.Done
                    }
                } catch (e: UpstreamException) {
                    throw e
                } catch (e: IOException) {
                    // 已经向客户端吐过字：换端点/换账号都会让客户端收到重复的开头，只能如实报错
                    if (emitted) throw e
                    Log.w(TAG, "network error @ $url: ${e.message}")
                    lastErr = e
                }

                // 401 时同一个旧 token 打第二个端点没有意义，先去刷新
                if (authExpired) break
            }

            if (authExpired && pass == 0 && TokenKeeper.refreshIfPossible(uid)) {
                val fresh = AccountVault.getAccounts().let { arr ->
                    (0 until arr.length()).asSequence()
                        .mapNotNull { arr.optJSONObject(it) }
                        .firstOrNull { it.optString("uid") == uid }
                } ?: break
                acc = fresh
                continue
            }
            break
        }
        return Attempt.Failed(lastErr ?: IOException("upstream request failed for $uid"))
    }
}
