package com.wag2api.ag

import android.util.Log
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONArray
import org.json.JSONObject
import org.json.JSONTokener
import java.io.File
import java.io.InterruptedIOException
import java.net.URLEncoder
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import java.util.TimeZone
import java.util.concurrent.CompletableFuture
import java.util.concurrent.Executors
import java.util.concurrent.ScheduledExecutorService
import java.util.concurrent.ScheduledFuture
import java.util.concurrent.ThreadFactory
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger

/**
 * 移植自 src/token-manager.mjs
 *
 * Token Manager & Project ID Resolver
 * 1. 携带 Antigravity 官方 ClientSecret 换票；
 * 2. 自动通过 loadCodeAssist / onboardUser 获取伴随项目 (cloudaicompanionProject)；
 * 3. 按到期时间提前 10 分钟主动续期。
 *
 * 存盘格式与 Node 版完全一致：账号文件就是 tokenData 本身（JSON.stringify(tokenData, null, 2)），
 * 未知字段原样保留。
 */
class TokenManager(val storagePath: String?) {

    /**
     * 与 Node 版 tokenData 相同：本身就是一个 JSONObject（其他模块可 optString("projectId")），
     * 同时提供 accessToken / refreshToken / expiresAt / email / projectId 属性；保留字段顺序与未知字段。
     */
    class TokenData private constructor(withDefaults: Boolean) : JSONObject() {
        constructor() : this(true)
        /** 用文件里读出的对象构造（原样复制，不补默认字段，与 Node 版 tokenData = JSON.parse(raw) 一致） */
        constructor(src: JSONObject) : this(false) {
            for (k in src.keys()) put(k, src.opt(k))
        }

        init {
            if (withDefaults) {
                put("accessToken", "")
                put("refreshToken", "")
                put("expiresAt", 0L)
                put("email", "")
                put("projectId", "")
            }
        }

        var accessToken: String
            get() = str("accessToken")
            set(v) { put("accessToken", v) }
        var refreshToken: String
            get() = str("refreshToken")
            set(v) { put("refreshToken", v) }
        var expiresAt: Long
            get() {
                val v = opt("expiresAt")
                return when (v) {
                    is Number -> v.toLong()
                    is String -> v.toDoubleOrNull()?.toLong() ?: 0L
                    else -> 0L
                }
            }
            set(v) { put("expiresAt", v) }
        var email: String
            get() = str("email")
            set(v) { put("email", v) }
        /** Node 版可能存了对象（cloudaicompanionProject 为对象时），取其 id */
        var projectId: String
            get() {
                val v = opt("projectId")
                return when (v) {
                    null, JSONObject.NULL -> ""
                    is JSONObject -> v.optString("id", "")
                    else -> v.toString()
                }
            }
            set(v) { put("projectId", v) }

        private fun str(k: String): String {
            val v = opt(k)
            return if (v == null || v == JSONObject.NULL) "" else v.toString()
        }
    }

    @Volatile var tokenData = TokenData()
    val clientId: String = Constants.ANTIGRAVITY_CLIENT_ID
    val clientSecret: String = Constants.ANTIGRAVITY_CLIENT_SECRET

    private val refreshLock = Any()
    private var refreshFuture: CompletableFuture<String?>? = null
    @Volatile private var keepAliveTimer: ScheduledFuture<*>? = null
    @Volatile private var refreshFails = 0

    init {
        load()
        startKeepAlive()
    }

    @Synchronized
    fun load() {
        val p = storagePath ?: return
        try {
            val f = File(p)
            if (f.exists()) {
                val v = M2Json.parse(f.readText(Charsets.UTF_8))
                if (v is JSONObject) tokenData = TokenData(v)
            }
        } catch (e: Exception) {
            M2Log.e("[TokenManager] Load error: ${e.message}")
        }
    }

    @Synchronized
    fun save() {
        val p = storagePath ?: return
        try {
            val f = File(p)
            f.parentFile?.mkdirs()
            M2Json.writeFile(f, M2Json.stringify(tokenData, 2))
        } catch (e: Exception) {
            M2Log.e("[TokenManager] Save error: ${e.message}")
        }
    }

    /** 同步阻塞：写入 refresh token → 换票 → 解析伴随项目 */
    fun setRefreshToken(refreshToken: String, email: String = ""): String? {
        tokenData.refreshToken = refreshToken
        if (email.isNotEmpty()) tokenData.email = email
        save()
        val token = refreshAccessToken()
        if (!token.isNullOrEmpty()) ensureProjectId()
        return token
    }

    /** 同步阻塞；并发调用共享同一次换票（等价 Node 版 _refreshPromise） */
    fun refreshAccessToken(): String? {
        if (tokenData.refreshToken.isEmpty()) return null
        val fut: CompletableFuture<String?>
        val owner: Boolean
        synchronized(refreshLock) {
            val cur = refreshFuture
            if (cur != null) {
                fut = cur; owner = false
            } else {
                fut = CompletableFuture(); refreshFuture = fut; owner = true
            }
        }
        if (!owner) return try { fut.get() } catch (e: Exception) { null }
        var result: String? = null
        try {
            result = doRefresh()
        } finally {
            synchronized(refreshLock) { refreshFuture = null }
            fut.complete(result)
        }
        return result
    }

    private fun doRefresh(): String? {
        try {
            val body = M2Http.form(
                "client_id" to clientId,
                "client_secret" to clientSecret,
                "grant_type" to "refresh_token",
                "refresh_token" to tokenData.refreshToken,
            )
            val res = M2Http.post(Constants.GOOGLE_TOKEN_ENDPOINT, body, M2Http.FORM, emptyMap())
            if (!res.ok) {
                M2Log.e("[TokenManager] Refresh failed (${res.status}): ${res.body.take(300)}")
                return null
            }
            val data = res.json() as? JSONObject ?: throw IllegalStateException("bad json")
            val at = data.opt("access_token")
            if (at == null || at == JSONObject.NULL) tokenData.remove("accessToken") else tokenData.put("accessToken", at)
            val expiresIn = M2Json.numOr(data.opt("expires_in"), 3600.0)
            tokenData.expiresAt = (System.currentTimeMillis() + expiresIn * 1000).toLong()
            save()
            M2Log.i("[TokenManager] 令牌主动换票成功 (有效期至: ${SimpleDateFormat("HH:mm:ss", Locale.getDefault()).format(Date(tokenData.expiresAt))})")
            return if (at is String) at else at?.toString()
        } catch (e: Exception) {
            M2Log.e("[TokenManager] Refresh network error: ${e.message}")
            return null
        }
    }

    fun getValidAccessToken(): String? {
        val safeWindowMs = 5 * 60 * 1000L
        if (tokenData.accessToken.isNotEmpty() && System.currentTimeMillis() + safeWindowMs < tokenData.expiresAt) {
            return tokenData.accessToken
        }
        return refreshAccessToken()
    }

    /** 自动探测或通过 onboardUser 开通新账号的伴随项目 (ProjectID)；同步阻塞 */
    fun ensureProjectId(): String {
        if (tokenData.projectId.isNotEmpty()) return tokenData.projectId
        if (tokenData.accessToken.isEmpty()) return ""
        try {
            val headers = mapOf(
                "Authorization" to "Bearer ${tokenData.accessToken}",
                "User-Agent" to "antigravity/4.3.0 linux/arm64",
            )
            val url = "${Constants.CLOUDCODE_API_ENDPOINT}/${Constants.API_VERSION}:loadCodeAssist"
            val res = M2Http.post(url, JSONObject().put("metadata", JSONObject().put("ideType", "ANTIGRAVITY")).toString(), M2Http.JSON, headers)
            if (!res.ok) return ""
            val data = res.json() as? JSONObject ?: return ""
            var pid: Any? = M2Json.or(data.opt("cloudaicompanionProject"), data.opt("projectId"))

            // 全新账号尚未绑定伴随项目：调用 onboardUser 自动激活
            val tiers = data.optJSONArray("allowedTiers")
            if (!M2Json.truthy(pid) && tiers != null && tiers.length() > 0) {
                var defaultTier: JSONObject? = null
                for (i in 0 until tiers.length()) {
                    val t = tiers.optJSONObject(i)
                    if (t != null && M2Json.truthy(t.opt("isDefault"))) { defaultTier = t; break }
                }
                if (defaultTier == null) defaultTier = tiers.optJSONObject(0) ?: JSONObject()
                val tierIdV = defaultTier.opt("tierId")
                val tierId = if (M2Json.truthy(tierIdV)) tierIdV.toString() else "free"
                M2Log.i("[TokenManager] 全新账号，正在自动开通 Antigravity Tier: $tierId...")
                val onboardUrl = "${Constants.DAILY_API_ENDPOINT}/${Constants.API_VERSION}:onboardUser"
                val onb = M2Http.post(
                    onboardUrl,
                    JSONObject().put("tier_id", tierId)
                        .put("metadata", JSONObject().put("ide_type", "ANTIGRAVITY").put("ide_name", "antigravity")).toString(),
                    M2Http.JSON, headers,
                )
                if (onb.ok) {
                    val od = onb.json() as? JSONObject
                    if (od != null) pid = M2Json.or(od.opt("cloudaicompanionProject"), od.opt("projectId"))
                }
            }

            if (M2Json.truthy(pid)) {
                tokenData.put("projectId", pid)
                save()
                M2Log.i("[TokenManager] 成功绑定 Antigravity 伴随项目: ${tokenData.projectId}")
                return tokenData.projectId
            }
            return ""
        } catch (e: Exception) {
            M2Log.w("[TokenManager] ProjectID 自动解析告警: ${e.message}")
            return ""
        }
    }

    /** 到期前 10 分钟刷新；最少 30 秒 */
    fun nextRefreshDelay(now: Long = System.currentTimeMillis()): Long {
        val leadMs = 10 * 60 * 1000L
        val minMs = 30 * 1000L
        val exp = tokenData.expiresAt
        if (exp == 0L) return minMs
        return maxOf(minMs, exp - leadMs - now)
    }

    fun startKeepAlive() {
        keepAliveTimer?.cancel(false)
        schedule(nextRefreshDelay())
    }

    private fun schedule(delay: Long) {
        keepAliveTimer = M2Exec.scheduler.schedule({
            if (keepAliveTimer == null) return@schedule
            if (tokenData.refreshToken.isEmpty()) { schedule(5 * 60 * 1000L); return@schedule }
            var ok = false
            try { ok = !refreshAccessToken().isNullOrEmpty() } catch (e: Exception) {}
            // 失败退避：1、2、4… 分钟，最长 30 分钟
            refreshFails = if (ok) 0 else refreshFails + 1
            if (keepAliveTimer == null) return@schedule
            schedule(if (ok) nextRefreshDelay() else minOf(30L, 1L shl minOf(refreshFails - 1, 5)) * 60 * 1000L)
        }, delay, TimeUnit.MILLISECONDS)
    }

    fun stopKeepAlive() {
        val t = keepAliveTimer
        keepAliveTimer = null
        t?.cancel(false)
    }

    fun getStatus(): JSONObject {
        val td = tokenData
        return JSONObject()
            .put("hasRefreshToken", td.refreshToken.isNotEmpty())
            .put("hasAccessToken", td.accessToken.isNotEmpty())
            .put("email", td.email.ifEmpty { "unknown" })
            .put("projectId", td.projectId.ifEmpty { "pending_detection" })
            .put("expiresInMinutes", maxOf(0L, Math.round((td.expiresAt - System.currentTimeMillis()) / 60000.0)))
    }
}

// ───────────────────────── M2 内部共用小工具（仅本包内使用） ─────────────────────────

/** 日志：统一走 android.util.Log，tag = AG */
internal object M2Log {
    /** 可选的额外日志出口（M6 可接到控制台日志环形缓冲） */
    @Volatile var sink: ((level: String, msg: String) -> Unit)? = null
    // [P3] 统一脱敏：令牌 / 密钥 / Cookie 值不进 logcat 和控制台日志
    fun i(m: String) { val r = Redact.redact(m); try { Log.i("AG", r) } catch (_: Throwable) {}; sink?.invoke("info", r) }
    fun w(m: String) { val r = Redact.redact(m); try { Log.w("AG", r) } catch (_: Throwable) {}; sink?.invoke("warn", r) }
    fun e(m: String) { val r = Redact.redact(m); try { Log.e("AG", r) } catch (_: Throwable) {}; sink?.invoke("error", r) }
}

/** 普通线程：定时任务 + 后台任务（守护线程） */
internal object M2Exec {
    private fun factory(name: String) = object : ThreadFactory {
        private val n = AtomicInteger()
        override fun newThread(r: Runnable) = Thread(r, "$name-${n.incrementAndGet()}").apply { isDaemon = true }
    }
    val scheduler: ScheduledExecutorService by lazy {
        Executors.newScheduledThreadPool(2, factory("ag-m2-timer")).also {
            (it as? java.util.concurrent.ScheduledThreadPoolExecutor)?.removeOnCancelPolicy = true
        }
    }
    val background by lazy { Executors.newCachedThreadPool(factory("ag-m2-bg")) }
    fun later(ms: Long, r: () -> Unit): ScheduledFuture<*> = scheduler.schedule({ try { r() } catch (_: Throwable) {} }, ms, TimeUnit.MILLISECONDS)
    fun bg(r: () -> Unit) { background.execute { try { r() } catch (_: Throwable) {} } }
}

/** 同步 HTTP（OkHttp，复用 UpstreamFetch.client） */
internal object M2Http {
    const val FORM = "application/x-www-form-urlencoded"
    const val JSON = "application/json"

    class Res(val status: Int, val body: String) {
        val ok get() = status in 200..299
        fun json(): Any? = M2Json.parse(body)
    }

    /** URLSearchParams.toString() 的等价编码 */
    fun form(vararg kv: Pair<String, String>): String =
        kv.joinToString("&") { enc(it.first) + "=" + enc(it.second) }

    fun enc(s: String): String = URLEncoder.encode(s, "UTF-8")

    fun client(timeoutMs: Long = 0): OkHttpClient {
        val c: OkHttpClient = UpstreamFetch.client
        return if (timeoutMs > 0) c.newBuilder().callTimeout(timeoutMs, TimeUnit.MILLISECONDS).build() else c
    }

    fun post(url: String, body: String, contentType: String, headers: Map<String, String>, timeoutMs: Long = 0): Res {
        val b = Request.Builder().url(url).post(body.toRequestBody(contentType.toMediaType()))
        for ((k, v) in headers) b.header(k, v)
        b.header("Content-Type", contentType)
        client(timeoutMs).newCall(b.build()).execute().use { r -> return Res(r.code, r.body?.string() ?: "") }
    }

    fun get(url: String, headers: Map<String, String>, timeoutMs: Long = 0): Res {
        val b = Request.Builder().url(url).get()
        for ((k, v) in headers) b.header(k, v)
        client(timeoutMs).newCall(b.build()).execute().use { r -> return Res(r.code, r.body?.string() ?: "") }
    }

    fun isTimeout(e: Throwable): Boolean = e is InterruptedIOException || e.cause is InterruptedIOException
}

/** JSON 工具：解析 + 与 JS JSON.stringify 逐字节一致的序列化（org.json 会把 / 转义成 \/，不能直接用于存盘） */
internal object M2Json {
    /** 严格解析一个 JSON 文本（等价 JSON.parse），失败抛异常 */
    fun parse(text: String): Any? {
        val t = text.trim()
        if (t.isEmpty()) throw IllegalArgumentException("Unexpected end of JSON input")
        val c = t[0]
        if (!(c == '{' || c == '[' || c == '"' || c == '-' || c.isDigit() || t == "true" || t == "false" || t == "null")) {
            throw IllegalArgumentException("Unexpected token")
        }
        val tk = JSONTokener(t)
        val v = tk.nextValue()
        // 允许尾部空白，其他内容视为非法（与 JSON.parse 一致）
        if (tk.nextClean().code != 0) throw IllegalArgumentException("Unexpected token after JSON")
        return v
    }

    fun stringify(v: Any?, indent: Int = 0): String {
        val sb = StringBuilder()
        write(sb, v, if (indent > 0) " ".repeat(indent) else "", "")
        return sb.toString()
    }

    private fun write(sb: StringBuilder, v: Any?, gap: String, cur: String) {
        when (v) {
            null, JSONObject.NULL -> sb.append("null")
            is String -> quote(sb, v)
            is Boolean -> sb.append(if (v) "true" else "false")
            is Number -> sb.append(num(v))
            is JSONObject -> {
                val keys = v.keys().asSequence().toList()
                val items = keys.filter { v.opt(it) != null }
                if (items.isEmpty()) { sb.append("{}"); return }
                val inner = cur + gap
                sb.append('{')
                items.forEachIndexed { i, k ->
                    if (i > 0) sb.append(',')
                    if (gap.isNotEmpty()) sb.append('\n').append(inner)
                    quote(sb, k); sb.append(':'); if (gap.isNotEmpty()) sb.append(' ')
                    write(sb, v.opt(k), gap, inner)
                }
                if (gap.isNotEmpty()) sb.append('\n').append(cur)
                sb.append('}')
            }
            is JSONArray -> {
                if (v.length() == 0) { sb.append("[]"); return }
                val inner = cur + gap
                sb.append('[')
                for (i in 0 until v.length()) {
                    if (i > 0) sb.append(',')
                    if (gap.isNotEmpty()) sb.append('\n').append(inner)
                    write(sb, v.opt(i), gap, inner)
                }
                if (gap.isNotEmpty()) sb.append('\n').append(cur)
                sb.append(']')
            }
            is Map<*, *> -> write(sb, JSONObject(v), gap, cur)
            is Collection<*> -> write(sb, JSONArray(v), gap, cur)
            else -> quote(sb, v.toString())
        }
    }

    /** JS Number → 字符串（整数不带 .0，非有限数为 null） */
    fun num(n: Number): String {
        if (n is Long || n is Int || n is Short || n is Byte) return n.toString()
        val d = n.toDouble()
        if (d.isNaN() || d.isInfinite()) return "null"
        if (d == Math.rint(d) && Math.abs(d) < 1e21) {
            if (d == 0.0) return "0"
            return if (Math.abs(d) < 9.007199254740992E15) d.toLong().toString() else java.math.BigDecimal(d).toPlainString()
        }
        val s = d.toString()
        if (!s.contains('E')) return s
        // 1.0E-7 → 1e-7，1.5E-10 → 1.5e-10
        val (m, e) = s.split('E')
        val mm = if (m.endsWith(".0")) m.dropLast(2) else m
        val ev = e.toInt()
        return if (ev in -6..20) java.math.BigDecimal(s).toPlainString() else mm + "e" + (if (ev > 0) "+" else "") + ev
    }

    private fun quote(sb: StringBuilder, s: String) {
        sb.append('"')
        var i = 0
        while (i < s.length) {
            val c = s[i]
            when {
                c == '"' -> sb.append("\\\"")
                c == '\\' -> sb.append("\\\\")
                c == '\b' -> sb.append("\\b")
                c == '\u000C' -> sb.append("\\f")
                c == '\n' -> sb.append("\\n")
                c == '\r' -> sb.append("\\r")
                c == '\t' -> sb.append("\\t")
                c < ' ' -> sb.append(String.format("\\u%04x", c.code))
                Character.isHighSurrogate(c) -> {
                    if (i + 1 < s.length && Character.isLowSurrogate(s[i + 1])) { sb.append(c).append(s[i + 1]); i++ }
                    else sb.append(String.format("\\u%04x", c.code))
                }
                Character.isLowSurrogate(c) -> sb.append(String.format("\\u%04x", c.code))
                else -> sb.append(c)
            }
            i++
        }
        sb.append('"')
    }

    /** 原子写文件（先写临时文件再改名，避免写一半断电损坏账号文件） */
    fun writeFile(f: File, text: String) {
        f.parentFile?.mkdirs()
        val tmp = File(f.parentFile, f.name + ".tmp")
        tmp.writeText(text, Charsets.UTF_8)
        if (!tmp.renameTo(f)) { f.writeText(text, Charsets.UTF_8); tmp.delete() }
    }

    fun truthy(v: Any?): Boolean = when (v) {
        null, JSONObject.NULL -> false
        is String -> v.isNotEmpty()
        is Boolean -> v
        is Number -> { val d = v.toDouble(); d != 0.0 && !d.isNaN() }
        else -> true
    }

    /** a || b */
    fun or(a: Any?, b: Any?): Any? = if (truthy(a)) a else b

    /** x ?? null（undefined/null → null） */
    fun nn(v: Any?): Any? = if (v == null || v == JSONObject.NULL) null else v

    /** (x || def) 用于数字 */
    fun numOr(v: Any?, def: Double): Double = if (v is Number && truthy(v)) v.toDouble() else if (v is String && truthy(v)) (v.toDoubleOrNull() ?: def).let { if (it == 0.0) def else it } else def

    private val ISO_PATTERNS = arrayOf(
        "yyyy-MM-dd'T'HH:mm:ss.SSSXXX", "yyyy-MM-dd'T'HH:mm:ssXXX", "yyyy-MM-dd'T'HH:mmXXX",
        "yyyy-MM-dd'T'HH:mm:ss.SSS", "yyyy-MM-dd'T'HH:mm:ss", "yyyy-MM-dd'T'HH:mm",
        "EEE, dd MMM yyyy HH:mm:ss zzz",
    )

    /** new Date(x).getTime()；无法解析返回 null（等价 NaN） */
    fun dateMs(v: Any?): Long? {
        when (v) {
            null, JSONObject.NULL -> return null
            is Number -> { val d = v.toDouble(); return if (d.isNaN()) null else d.toLong() }
            is Date -> return v.time
        }
        var s = v.toString().trim()
        if (s.isEmpty()) return null
        if (Regex("^\\d{4}-\\d{2}-\\d{2}$").matches(s)) s += "T00:00:00Z" // 纯日期按 UTC
        // 小数秒统一到 3 位；Z → +00:00
        s = s.replace(Regex("\\.(\\d{1,9})")) { m -> "." + (m.groupValues[1] + "00").substring(0, 3) }
        s = s.replace(Regex("[zZ]$"), "+00:00")
        for (p in ISO_PATTERNS) {
            try {
                val f = SimpleDateFormat(p, Locale.US)
                f.isLenient = false
                if (!p.contains("XXX") && !p.contains("zzz")) f.timeZone = TimeZone.getDefault()
                val pos = java.text.ParsePosition(0)
                val d = f.parse(s, pos)
                if (d != null && pos.index == s.length) return d.time
            } catch (_: Exception) {}
        }
        return null
    }
}
