package com.wag2api.app

import android.content.Context
import android.util.Log
import com.wag2api.app.engine.EngineFactory
import com.wag2api.app.engine.EngineState
import com.wag2api.app.engine.NodeEngineApi
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONArray
import org.json.JSONObject
import java.io.OutputStream
import java.util.concurrent.TimeUnit

/**
 * 前门路由：唯一对外端口 8800。
 *
 * 三层判断（按顺序）：
 *  1. 路径 —— /ag/ 与 /api/ 归 Node，/ais/ 归 AIS
 *  2. 模型名 —— ag: / ais: / wb: 前缀强制指定，其次查两边模型表做精确匹配
 *  3. 默认引擎 —— 重名或未知模型交给用户设置（lite 永远为 ais）
 */
object EngineRouter {

    private const val TAG = "EngineRouter"
    private const val PREF = "wag2api_router"
    private const val KEY_DEFAULT = "default_engine"
    private const val KEY_NODE_MODELS = "node_models_cache"
    private const val KEY_AIS_MODELS = "ais_models_cache"

    /** 默认引擎：ag 或 ais（旧值 wb 自动迁移为 ais；lite 永远为 ais） */
    fun getDefaultEngine(ctx: Context): String {
        if (!EngineFactory.SUPPORTS_NODE) return "ais"
        val pref = ctx.getSharedPreferences(PREF, Context.MODE_PRIVATE)
        val cur = pref.getString(KEY_DEFAULT, "ais") ?: "ais"
        if (cur == "wb") {
            pref.edit().putString(KEY_DEFAULT, "ais").apply()
            return "ais"
        }
        return if (cur == "ag") "ag" else "ais"
    }

    fun setDefaultEngine(ctx: Context, engine: String) {
        val target = if (engine == "ag" && EngineFactory.SUPPORTS_NODE) "ag" else "ais"
        ctx.getSharedPreferences(PREF, Context.MODE_PRIVATE)
            .edit().putString(KEY_DEFAULT, target).apply()
    }

    /** AG 模型表落盘缓存 */
    fun cacheNodeModels(ctx: Context, models: JSONArray) {
        ctx.getSharedPreferences(PREF, Context.MODE_PRIVATE)
            .edit().putString(KEY_NODE_MODELS, models.toString()).apply()
    }

    fun getCachedNodeModels(ctx: Context): JSONArray = try {
        val raw = ctx.getSharedPreferences(PREF, Context.MODE_PRIVATE)
            .getString(KEY_NODE_MODELS, null)
        if (raw.isNullOrEmpty()) JSONArray() else JSONArray(raw)
    } catch (e: Exception) {
        JSONArray()
    }

    /** AIS 模型表落盘缓存 */
    fun cacheAisModels(ctx: Context, models: JSONArray) {
        ctx.getSharedPreferences(PREF, Context.MODE_PRIVATE)
            .edit().putString(KEY_AIS_MODELS, models.toString()).apply()
    }

    fun getCachedAisModels(ctx: Context): JSONArray = try {
        val raw = ctx.getSharedPreferences(PREF, Context.MODE_PRIVATE)
            .getString(KEY_AIS_MODELS, null)
        if (raw.isNullOrEmpty()) JSONArray() else JSONArray(raw)
    } catch (e: Exception) {
        JSONArray()
    }

    private val client = OkHttpClient.Builder()
        .connectTimeout(15, TimeUnit.SECONDS)
        .readTimeout(0, TimeUnit.SECONDS)   // 流式不能超时
        .writeTimeout(60, TimeUnit.SECONDS)
        .retryOnConnectionFailure(false)
        .build()

    /** 路由结果 */
    sealed class Route {
        data class ToNode(val path: String) : Route()
        data class ToAis(val path: String, val stripPrefix: String? = null) : Route()
        data class Reject(val status: Int, val payload: String) : Route()
    }

    /**
     * 决定这条请求归谁。
     * @param path 已去掉 query 的路径
     * @param body 请求体原文（可能为空）
     */
    fun decide(ctx: Context, engine: NodeEngineApi, path: String, body: String): Route {
        val p = normalize(path)

        // ── 第 1 层：路径 ──────────────────────────────
        if (p.startsWith("/ag/")) return Route.ToNode(p.removePrefix("/ag"))
        if (p == "/ag") return Route.ToNode("/")
        if (p == "/api/pairing/accounts") return Route.ToAis(p)
        if (p.startsWith("/api/")) return Route.ToNode(p)   // Node 控制台内部用绝对路径 fetch

        if (p.startsWith("/ais/api/") || p == "/ais/api") return Route.ToAis(p.removePrefix("/ais"))
        if (p.startsWith("/ais/v1/") || p == "/ais/v1") return Route.ToAis(p.removePrefix("/ais"))
        if (p.startsWith("/ais/v1beta/") || p == "/ais/v1beta") return Route.ToAis(p.removePrefix("/ais"))
        if (p.startsWith("/ais/")) return Route.ToAis(p.removePrefix("/ais"))

        // ── 第 2 层：模型名（推理路径）──────────────────
        if (p == "/v1/messages" || p == "/v1/chat/completions" || p.startsWith("/v1beta/")) {
            val model = try {
                JSONObject(body).optString("model", "")
            } catch (e: Exception) { "" }

            val forced = when {
                model.startsWith("ag:") -> "ag"
                model.startsWith("ais:") -> "ais"
                model.startsWith("wb:") -> "ais" // 兼容旧 wb: 前缀
                else -> null
            }

            val target = forced ?: run {
                if (!EngineFactory.SUPPORTS_NODE) {
                    "ais"
                } else {
                    val inAg = modelInList(model, getCachedNodeModels(ctx))
                    val inAis = modelInList(model, getCachedAisModels(ctx))
                    when {
                        inAg && !inAis -> "ag"
                        inAis && !inAg -> "ais"
                        else -> getDefaultEngine(ctx)
                    }
                }
            }

            return if (target == "ag") {
                when {
                    !EngineFactory.SUPPORTS_NODE ->
                        Route.Reject(501, errorBody("此版本不含 AG 引擎，请安装 full 版"))
                    engine.state == EngineState.OFF ->
                        Route.Reject(503, errorBody("AG 引擎已关闭"))
                    engine.state == EngineState.FAILED ->
                        Route.Reject(503, errorBody("AG 引擎启动失败"))
                    engine.state == EngineState.READY ->
                        Route.ToNode(p)
                    else -> Route.Reject(503, errorBody("AG 引擎启动中，请稍后重试"))
                }
            } else {
                val strip = when {
                    model.startsWith("ais:") -> "ais:"
                    model.startsWith("wb:") -> "wb:"
                    else -> null
                }
                Route.ToAis(path = p, stripPrefix = strip)
            }
        }

        // ── 其他路径归 AIS ──────────────────────────────
        return Route.ToAis(path = p)
    }

    private fun modelInList(model: String, list: JSONArray): Boolean {
        if (model.isEmpty()) return false
        for (i in 0 until list.length()) {
            val o = list.optJSONObject(i) ?: continue
            if (o.optString("id") == model) return true
        }
        return false
    }

    /** 折叠重复斜杠、去末尾斜杠 */
    private fun normalize(path: String): String {
        var p = path.replace(Regex("/{2,}"), "/")
        if (p.length > 1 && p.endsWith("/")) p = p.dropLast(1)
        return p
    }

    fun errorBody(msg: String): String = JSONObject().apply {
        put("type", "error")
        put("error", JSONObject().apply {
            put("type", "engine_unavailable")
            put("message", msg)
        })
    }.toString()

    /** 从 Node 引擎拉取模型表并落盘缓存 */
    fun syncNodeModels(ctx: Context, engine: NodeEngineApi, token: String) {
        if (engine.state != EngineState.READY || engine.port <= 0) return
        try {
            val req = Request.Builder()
                .url("http://127.0.0.1:${engine.port}/v1/models")
                .header("X-Engine-Token", token)
                .get()
                .build()
            client.newCall(req).execute().use { resp ->
                if (!resp.isSuccessful) return
                val text = resp.body?.string() ?: return
                val arr = try {
                    val o = JSONObject(text)
                    o.optJSONArray("data") ?: JSONArray()
                } catch (e: Exception) { JSONArray() }
                if (arr.length() > 0) cacheNodeModels(ctx, arr)
            }
        } catch (e: Exception) {
            Log.w(TAG, "拉取 AG 模型表失败: ${e.message}")
        }
    }

    /** 从 AIS 引擎拉取模型表并落盘缓存 */
    fun syncAisModels(ctx: Context) {
        if (!AisEngine.isRunning()) return
        try {
            val req = Request.Builder()
                .url("${AisEngine.baseUrl}/v1/models")
                .get()
                .build()
            client.newCall(req).execute().use { resp ->
                if (!resp.isSuccessful) return
                val text = resp.body?.string() ?: return
                val arr = try {
                    val o = JSONObject(text)
                    o.optJSONArray("data") ?: JSONArray()
                } catch (e: Exception) { JSONArray() }
                if (arr.length() > 0) cacheAisModels(ctx, arr)
            }
        } catch (e: Exception) {
            Log.w(TAG, "拉取 AIS 模型表失败: ${e.message}")
        }
    }

    /** 转发请求到 AIS 引擎 */
    fun proxyToAis(
        method: String,
        path: String,
        query: String,
        headers: Map<String, String>,
        body: String,
        out: OutputStream,
        stripModelPrefix: String? = null
    ) {
        if (!AisEngine.isAvailable()) {
            writeError(out, 503, errorBody("AIS 引擎未安装或不可用"))
            return
        }

        val realBody = if (stripModelPrefix != null && body.isNotEmpty()) {
            try {
                val j = JSONObject(body)
                val m = j.optString("model", "")
                if (m.startsWith(stripModelPrefix)) {
                    j.put("model", m.removePrefix(stripModelPrefix))
                }
                j.toString()
            } catch (e: Exception) { body }
        } else body

        val url = buildString {
            append(AisEngine.baseUrl).append(path)
            if (query.isNotEmpty()) append('?').append(query)
        }

        val rb = if (method == "GET" || method == "HEAD" || (method == "DELETE" && realBody.isEmpty())) null
        else {
            val ct = headers["content-type"] ?: "application/json; charset=utf-8"
            realBody.toRequestBody(ct.toMediaType())
        }

        val reqBuilder = Request.Builder().url(url).method(method, rb)
        val keepAuth = (path == "/api/pairing/accounts")
        for ((k, v) in headers) {
            val lk = k.lowercase()
            if (lk == "origin" ||
                lk == "referer" ||
                lk.startsWith("sec-fetch-") ||
                lk == "host" ||
                lk == "content-length" ||
                lk == "x-api-key" ||
                lk == "x-goog-api-key" ||
                lk == "x-admin-key" ||
                (lk == "authorization" && !keepAuth)
            ) {
                continue
            }
            reqBuilder.header(k, v)
        }
        reqBuilder.header("Host", AisEngine.baseUrl.removePrefix("http://").removePrefix("https://"))

        val startTime = System.currentTimeMillis()
        val model = try { JSONObject(realBody).optString("model", "") } catch (e: Exception) { "" }

        try {
            client.newCall(reqBuilder.build()).execute().use { resp ->
                val ct = resp.header("Content-Type") ?: "application/json; charset=utf-8"
                val isSse = ct.contains("event-stream", ignoreCase = true)

                if (isSse) {
                    val head = "HTTP/1.1 ${resp.code} ${resp.message}\r\n" +
                            "Content-Type: $ct\r\n" +
                            "Cache-Control: no-cache, no-transform\r\n" +
                            "X-Accel-Buffering: no\r\n" +
                            "Transfer-Encoding: chunked\r\n" +
                            "Access-Control-Allow-Origin: *\r\n" +
                            "Connection: keep-alive\r\n\r\n"
                    out.write(head.toByteArray(Charsets.US_ASCII))
                    out.flush()

                    val buf = ByteArray(8192)
                    resp.body?.byteStream()?.use { input ->
                        while (true) {
                            val n = try { input.read(buf) } catch (e: Exception) { -1 }
                            if (n <= 0) break
                            val hex = Integer.toHexString(n)
                            out.write("$hex\r\n".toByteArray(Charsets.US_ASCII))
                            out.write(buf, 0, n)
                            out.write("\r\n".toByteArray(Charsets.US_ASCII))
                            out.flush()
                        }
                    }
                    out.write("0\r\n\r\n".toByteArray(Charsets.US_ASCII))
                    out.flush()
                } else {
                    val bytes = resp.body?.bytes() ?: ByteArray(0)
                    val head = if (resp.code == 204) {
                        "HTTP/1.1 204 No Content\r\n" +
                                "Access-Control-Allow-Origin: *\r\n" +
                                "Connection: close\r\n\r\n"
                    } else {
                        "HTTP/1.1 ${resp.code} ${resp.message}\r\n" +
                                "Content-Type: $ct\r\n" +
                                "Content-Length: ${bytes.size}\r\n" +
                                "Access-Control-Allow-Origin: *\r\n" +
                                "Connection: close\r\n\r\n"
                    }
                    out.write(head.toByteArray(Charsets.US_ASCII))
                    if (bytes.isNotEmpty()) {
                        out.write(bytes)
                    }
                    out.flush()
                }
                GatewayMetrics.record(method, path, model, "ais", resp.code, 0, System.currentTimeMillis() - startTime)
            }
        } catch (e: Exception) {
            Log.e(TAG, "转发 AIS 失败", e)
            GatewayMetrics.record(method, path, model, "error", 502, 0, System.currentTimeMillis() - startTime, e.message)
            try { writeError(out, 502, errorBody("AIS 引擎转发失败: ${e.message}")) } catch (ignored: Exception) {}
        }
    }

    /** 把请求转发给内部 Node 引擎，响应逐块回吐（SSE 不缓冲） */
    fun proxyToNode(
        engine: NodeEngineApi,
        token: String,
        method: String,
        path: String,
        query: String,
        headers: Map<String, String>,
        body: String,
        out: OutputStream,
        stripModelPrefix: String? = null
    ) {
        val port = engine.port
        if (port <= 0) {
            writeError(out, 503, errorBody("AG 引擎端口未就绪"))
            return
        }

        val realBody = if (stripModelPrefix != null && body.isNotEmpty()) {
            try {
                val j = JSONObject(body)
                val m = j.optString("model", "")
                if (m.startsWith(stripModelPrefix)) {
                    j.put("model", m.removePrefix(stripModelPrefix))
                }
                j.toString()
            } catch (e: Exception) { body }
        } else body

        val url = buildString {
            append("http://127.0.0.1:").append(port).append(path)
            if (query.isNotEmpty()) append('?').append(query)
        }

        val rb = if (method == "GET" || method == "HEAD") null
        else realBody.toRequestBody("application/json; charset=utf-8".toMediaType())

        val reqBuilder = Request.Builder().url(url).method(method, rb)
        listOf("authorization", "x-api-key", "anthropic-version", "content-type", "accept").forEach { k ->
            headers[k]?.let { reqBuilder.header(k, it) }
        }
        reqBuilder.header("X-Engine-Token", token)

        engine.requestStart()
        try {
            client.newCall(reqBuilder.build()).execute().use { resp ->
                val ct = resp.header("Content-Type") ?: "application/json; charset=utf-8"
                val isSse = ct.contains("event-stream", ignoreCase = true)

                if (isSse) {
                    val head = "HTTP/1.1 200 OK\r\n" +
                            "Content-Type: $ct\r\n" +
                            "Cache-Control: no-cache, no-transform\r\n" +
                            "X-Accel-Buffering: no\r\n" +
                            "Transfer-Encoding: chunked\r\n" +
                            "Access-Control-Allow-Origin: *\r\n" +
                            "Connection: keep-alive\r\n\r\n"
                    out.write(head.toByteArray(Charsets.US_ASCII))
                    out.flush()

                    val buf = ByteArray(8192)
                    resp.body?.byteStream()?.use { input ->
                        while (true) {
                            val n = try { input.read(buf) } catch (e: Exception) { -1 }
                            if (n <= 0) break
                            val hex = Integer.toHexString(n)
                            out.write("$hex\r\n".toByteArray(Charsets.US_ASCII))
                            out.write(buf, 0, n)
                            out.write("\r\n".toByteArray(Charsets.US_ASCII))
                            out.flush()
                        }
                    }
                    out.write("0\r\n\r\n".toByteArray(Charsets.US_ASCII))
                    out.flush()
                } else {
                    val bytes = resp.body?.bytes() ?: ByteArray(0)
                    val head = "HTTP/1.1 ${resp.code} ${resp.message}\r\n" +
                            "Content-Type: $ct\r\n" +
                            "Content-Length: ${bytes.size}\r\n" +
                            "Access-Control-Allow-Origin: *\r\n" +
                            "Connection: close\r\n\r\n"
                    out.write(head.toByteArray(Charsets.US_ASCII))
                    out.write(bytes)
                    out.flush()
                }
            }
        } catch (e: Exception) {
            Log.e(TAG, "转发 Node 失败", e)
            try { writeError(out, 502, errorBody("AG 引擎转发失败: ${e.message}")) } catch (ignored: Exception) {}
        } finally {
            engine.requestEnd()
        }
    }

    private fun writeError(out: OutputStream, code: Int, json: String) {
        val bytes = json.toByteArray(Charsets.UTF_8)
        val head = "HTTP/1.1 $code Error\r\n" +
                "Content-Type: application/json; charset=utf-8\r\n" +
                "Content-Length: ${bytes.size}\r\n" +
                "Access-Control-Allow-Origin: *\r\n" +
                "Connection: close\r\n\r\n"
        out.write(head.toByteArray(Charsets.US_ASCII))
        out.write(bytes)
        out.flush()
    }

    /** 合并两边模型表；重名模型额外列出 ag: / ais: 前缀版本 */
    fun mergedModels(ctx: Context): JSONObject {
        val seen = HashSet<String>()
        val data = JSONArray()

        fun addAll(list: JSONArray, ns: String?) {
            for (i in 0 until list.length()) {
                val o = list.optJSONObject(i) ?: continue
                val id = o.optString("id")
                if (id.isEmpty()) continue
                val outId = if (ns != null) "$ns$id" else id
                if (!seen.add(outId)) continue
                val copy = JSONObject(o.toString())
                copy.put("id", outId)
                data.put(copy)
            }
        }

        val ais = getCachedAisModels(ctx)
        val ag = if (EngineFactory.SUPPORTS_NODE) getCachedNodeModels(ctx) else JSONArray()

        addAll(ais, null)
        addAll(ag, null)

        // 重名项额外提供带命名空间的版本，方便用户显式指定引擎
        val aisIds = (0 until ais.length()).mapNotNull { ais.optJSONObject(it)?.optString("id") }.toSet()
        val agIds = (0 until ag.length()).mapNotNull { ag.optJSONObject(it)?.optString("id") }.toSet()
        (aisIds intersect agIds).forEach { id ->
            data.put(JSONObject().apply {
                put("id", "ag:$id"); put("object", "model")
                put("name", "$id (AG 引擎)")
            })
            data.put(JSONObject().apply {
                put("id", "ais:$id"); put("object", "model")
                put("name", "$id (AIS 引擎)")
            })
        }

        return JSONObject().apply {
            put("object", "list")
            put("data", data)
        }
    }
}
