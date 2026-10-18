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
 *  1. 路径 —— /ag/ 与 /api/ 归 Node，/panel/ 与 /m/ 归 WB
 *  2. 模型名 —— ag: / wb: 前缀强制指定，其次查两边模型表做精确匹配
 *  3. 默认引擎 —— 重名或未知模型交给用户设置
 *
 * 关键取舍：**绝不按模型名前缀猜**。两边都有 claude- 和 gemini- 家族，
 * 按前缀分一定会分错，重名一律交给用户用 ag: / wb: 显式指定。
 */
object EngineRouter {

    private const val TAG = "EngineRouter"
    private const val PREF = "wag2api_router"
    private const val KEY_DEFAULT = "default_engine"
    private const val KEY_NODE_MODELS = "node_models_cache"

    /** 默认引擎：wb（默认）或 ag */
    fun getDefaultEngine(ctx: Context): String =
        ctx.getSharedPreferences(PREF, Context.MODE_PRIVATE)
            .getString(KEY_DEFAULT, "wb") ?: "wb"

    fun setDefaultEngine(ctx: Context, engine: String) {
        ctx.getSharedPreferences(PREF, Context.MODE_PRIVATE)
            .edit().putString(KEY_DEFAULT, engine).apply()
    }

    /** AG 模型表落盘缓存：Node 未就绪时前门也能正确分流 */
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

    private val client = OkHttpClient.Builder()
        .connectTimeout(15, TimeUnit.SECONDS)
        .readTimeout(0, TimeUnit.SECONDS)   // 流式不能超时
        .writeTimeout(60, TimeUnit.SECONDS)
        .retryOnConnectionFailure(false)
        .build()

    /** 路由结果 */
    sealed class Route {
        data class ToNode(val path: String) : Route()
        data class ToWorkBuddy(val stripPrefix: String? = null) : Route()
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
        if (p.startsWith("/api/")) return Route.ToNode(p)   // Node 控制台内部用绝对路径 fetch

        // ── 第 2 层：模型名（仅两条推理路径）────────────
        if (p == "/v1/messages" || p == "/v1/chat/completions") {
            val model = try {
                JSONObject(body).optString("model", "")
            } catch (e: Exception) { "" }

            val forced = when {
                model.startsWith("ag:") -> "ag"
                model.startsWith("wb:") -> "wb"
                else -> null
            }

            val target = forced ?: run {
                val inAg = modelInList(model, getCachedNodeModels(ctx))
                val inWb = modelInList(model, WbModels.list())
                when {
                    inAg && !inWb -> "ag"
                    inWb && !inAg -> "wb"
                    else -> getDefaultEngine(ctx)   // 第 3 层：重名或未知 → 默认引擎
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
                        Route.ToNode(p)   // 前缀在转发时由代理层去掉
                    else -> Route.Reject(503, errorBody("AG 引擎启动中，请稍后重试"))
                }
            } else {
                Route.ToWorkBuddy(stripPrefix = if (model.startsWith("wb:")) "wb:" else null)
            }
        }

        // ── 其他路径归 WB ──────────────────────────────
        return Route.ToWorkBuddy()
    }

    private fun modelInList(model: String, list: JSONArray): Boolean {
        if (model.isEmpty()) return false
        for (i in 0 until list.length()) {
            val o = list.optJSONObject(i) ?: continue
            if (o.optString("id") == model) return true
        }
        return false
    }

    /** 折叠重复斜杠、去末尾斜杠，规则与 Node 侧保持一致 */
    private fun normalize(path: String): String {
        var p = path.replace(Regex("/{2,}"), "/")
        if (p.length > 1 && p.endsWith("/")) p = p.dropLast(1)
        return p
    }

    private fun errorBody(msg: String): String = JSONObject().apply {
        put("type", "error")
        put("error", JSONObject().apply {
            put("type", "engine_unavailable")
            put("message", msg)
        })
    }.toString()

    /**
     * 从 Node 引擎拉取模型表并落盘缓存。
     * 必须在启动窗口内也保证可用，否则没加前缀的 AG 模型会被默认路由到 WB，
     * 用户会以为「切模型失灵」。
     */
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

    /**
     * 把请求转发给内部 Node 引擎，响应逐块回吐（SSE 不缓冲）。
     * @param stripModelPrefix 需要从 body.model 去掉的前缀
     */
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
        // 透传鉴权与内容协商头，其余丢弃
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
                            out.flush()   // 逐块 flush，SSE 不缓冲
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

    /** 合并两边模型表；重名模型额外列出 ag: / wb: 前缀版本 */
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

        val wb = WbModels.list()
        val ag = getCachedNodeModels(ctx)

        addAll(wb, null)
        addAll(ag, null)

        // 重名项额外提供带命名空间的版本，方便用户显式指定引擎
        val wbIds = (0 until wb.length()).mapNotNull { wb.optJSONObject(it)?.optString("id") }.toSet()
        val agIds = (0 until ag.length()).mapNotNull { ag.optJSONObject(it)?.optString("id") }.toSet()
        (wbIds intersect agIds).forEach { id ->
            data.put(JSONObject().apply {
                put("id", "ag:$id"); put("object", "model")
                put("name", "$id (AG 引擎)")
            })
            data.put(JSONObject().apply {
                put("id", "wb:$id"); put("object", "model")
                put("name", "$id (WorkBuddy 引擎)")
            })
        }

        return JSONObject().apply {
            put("object", "list")
            put("data", data)
        }
    }
}
