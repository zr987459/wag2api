package com.wag2api.app.ais

import android.annotation.SuppressLint
import android.content.Context
import android.graphics.Bitmap
import android.os.Handler
import android.os.Looper
import android.view.View
import android.webkit.CookieManager
import android.webkit.JavascriptInterface
import android.webkit.RenderProcessGoneDetail
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.webkit.ProfileStore
import androidx.webkit.UserAgentMetadata
import androidx.webkit.WebSettingsCompat
import androidx.webkit.WebViewCompat
import androidx.webkit.WebViewFeature
import org.json.JSONArray
import org.json.JSONObject
import org.json.JSONTokener
import java.io.ByteArrayInputStream
import java.io.File
import java.io.IOException
import java.security.SecureRandom
import java.util.concurrent.CompletableFuture
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.CountDownLatch
import java.util.concurrent.LinkedBlockingQueue
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger

/**
 * 一个 AIS 账号 = 一个隐藏 WebView，停在 aistudio.google.com 的新对话页上。
 *
 * 思路（参考 XYenon/magpie-google-ai-studio 与上游 AIStudio2API 的 Camoufox 后端，代码自写）：
 *  1. 每个账号一个独立的 WebView Profile（androidx.webkit MULTI_PROFILE；不支持时退回全局 CookieManager，同一时间只活一个账号），
 *     导入的 storage-state 写进该 Profile 的 CookieManager（含 HttpOnly）和 localStorage。
 *  2. 页面就绪后，临时替换 window.default_MakerSuite 里调用 .snapshot({ 的高层函数，拿到页面自己的 WAA service；
 *     再在输入框里填一条消息点 Run，用 shouldInterceptRequest 拦下这次 GenerateContent（不真正发出），记下页面的动态请求头。
 *  3. 每次请求：Kotlin 组好 MakerSuite 正文 → 页面里把最后一轮文本写进输入框，用 service 为 binding prompt 的 SHA-256 生成 fresh proof
 *     → 正文写入 proof → 在页面里用带 Cookie 的原生 XHR 发出（TLS / HTTP2 / Cookie 都是浏览器自己的），响应分块经 bridge 回传。
 *
 * 所有 WebView 调用都在主线程；对外方法都是阻塞的，在请求线程里调。
 * 日志只记阶段和请求头名字，绝不记 Cookie、请求头的值或 SAPISIDHASH。
 */
@SuppressLint("SetJavaScriptEnabled")
class AisWebWorker(
    private val ctx: Context,
    val accountId: String,
    private val dir: File,
    private val log: (String) -> Unit,
) {
    enum class Phase { NEW, BOOTING, READY, FAILED, AUTH_REQUIRED, CLOSED }

    @Volatile var phase: Phase = Phase.NEW
        private set
    @Volatile var error: String? = null
        private set
    @Volatile var lastUsed: Long = System.currentTimeMillis()
    @Volatile var pageUrl: String = ""
        private set
    @Volatile var email: String? = null
        private set
    @Volatile var models: List<MakerSuiteWire.ModelInfo> = emptyList()
    @Volatile var headerNames: List<String> = emptyList()
        private set
    val inflight = AtomicInteger(0)

    private val main = Handler(Looper.getMainLooper())
    private var web: WebView? = null
    private val bridgeName = "_" + randomHex(5)
    private val pending = ConcurrentHashMap<String, CompletableFuture<JSONObject>>()
    private val streams = ConcurrentHashMap<String, LinkedBlockingQueue<JSONObject>>()
    @Volatile private var pageFinished: CountDownLatch? = null
    @Volatile private var capture: CompletableFuture<Map<String, String>>? = null
    /** 发 GenerateContent 时带的页面公共头（名字小写 → 值），不含 authorization */
    @Volatile private var protocolHeaders: List<Pair<String, String>> = emptyList()
    private val proofLock = Any()
    private val bootLock = Any()

    private val profileName = "ais_" + accountId.replace(Regex("[^A-Za-z0-9_]"), "_")

    // ------------------------------------------------------------------ 生命周期

    /** 阻塞直到就绪；失败抛 IOException（AUTH_REQUIRED 时消息带“需要重新导入”） */
    fun ensureReady(timeoutMs: Long = 150_000) {
        synchronized(bootLock) {
            when (phase) {
                Phase.READY -> return
                Phase.AUTH_REQUIRED -> throw IOException("账号 $accountId 需要重新导入 Cookie：${error ?: ""}")
                Phase.CLOSED -> throw IOException("账号 $accountId 的 WebView 已关闭")
                else -> {}
            }
            phase = Phase.BOOTING
            error = null
            val deadline = System.currentTimeMillis() + timeoutMs
            try {
                boot(deadline)
                phase = Phase.READY
                log("[$accountId] 就绪，请求头 ${headerNames.joinToString(",")}，模型 ${models.size} 个")
            } catch (t: Throwable) {
                if (phase != Phase.AUTH_REQUIRED) phase = Phase.FAILED
                error = t.message ?: t.toString()
                log("[$accountId] 初始化失败：$error")
                destroyWebView()
                throw if (t is IOException) t else IOException(error, t)
            }
        }
    }

    fun close() {
        if (phase == Phase.CLOSED) return
        phase = Phase.CLOSED
        saveCookiesBack()
        destroyWebView()
        failAll("WebView 已关闭")
    }

    /** 失败或空闲回收后可以再次初始化 */
    fun reset() {
        synchronized(bootLock) {
            destroyWebView()
            failAll("WebView 已重置")
            phase = Phase.NEW
            error = null
        }
    }

    private fun failAll(msg: String) {
        for ((_, f) in pending) f.completeExceptionally(IOException(msg))
        pending.clear()
        for ((_, q) in streams) q.offer(JSONObject().put("t", "err").put("e", msg))
        streams.clear()
    }

    private fun destroyWebView() {
        val w = web ?: return
        web = null
        onMain {
            try {
                w.stopLoading()
                w.loadUrl("about:blank")
                w.removeAllViews()
                w.destroy()
            } catch (_: Throwable) {}
        }
    }

    // ------------------------------------------------------------------ 初始化

    private fun boot(deadline: Long) {
        val state = StorageState.fromJson(JSONObject(File(dir, "storage-state.json").readText(Charsets.UTF_8)))
        val meta = readMeta()
        val authUser = meta.optInt("auth_user", 0)

        log("[$accountId] 创建 WebView（独立 Profile：${multiProfile()}）")
        onMain { createWebView() }
        installCookies(state, meta)

        // localStorage：先在 aistudio 源上开一个空白页写入，再进真正的页面
        if (state.origins.isNotEmpty()) {
            loadAndWait({ it.loadDataWithBaseURL(StorageState.AISTUDIO_ORIGIN + "/", "<html><body></body></html>", "text/html", "utf-8", null) }, 20_000)
            for (o in state.origins) {
                if (!o.origin.startsWith(StorageState.AISTUDIO_ORIGIN)) continue
                val js = StringBuilder("(function(){")
                for ((k, v) in o.localStorage) js.append("try{localStorage.setItem(").append(JSONObject.quote(k)).append(',').append(JSONObject.quote(v)).append(");}catch(e){}")
                js.append("return true;})()")
                evalSync(js.toString(), 10_000)
            }
        }

        val path = if (authUser > 0) "/u/$authUser/prompts/new_chat" else "/prompts/new_chat"
        log("[$accountId] 打开 AI Studio")
        loadAndWait({ it.loadUrl(StorageState.AISTUDIO_ORIGIN + path) }, remaining(deadline, 60_000))

        // 等输入框出现（或被跳到登录页）
        val ready = poll(remaining(deadline, 90_000), 500) {
            val r = evalSync(JS_READY, 5_000)
            if (r == "login" || r == "ready") r else null
        }
        pageUrl = evalSync("location.href", 5_000)?.toString()?.substringBefore('?') ?: ""
        if (ready == "login" || ready == null && pageUrl.contains("accounts.google.com")) {
            phase = Phase.AUTH_REQUIRED
            throw IOException("页面跳转到 Google 登录，Cookie 已失效或不完整")
        }
        if (ready == null) throw IOException("AI Studio 输入框未就绪（$pageUrl）")

        email = (evalSync(JS_EMAIL, 5_000) as? String)?.takeIf { it.contains('@') }
        evalSync(JS_DISMISS, 5_000)

        // 定位官网 snapshot 函数并挂上 service 捕获
        log("[$accountId] 定位 WAA")
        val key = poll(remaining(deadline, 30_000), 500) { (evalSync(JS_HOOK, 5_000) as? String)?.takeIf { it.isNotEmpty() } }
            ?: throw IOException("官网 snapshot 函数定位超时（页面结构可能变了）")

        // 填一条消息点 Run，拦下 GenerateContent 拿请求头，同时让页面把 WAA service 交给 hook
        var headers = captureOnce(deadline, useJsHook = false)
        if (headers["x-goog-api-key"].isNullOrEmpty()) {
            log("[$accountId] shouldInterceptRequest 没拿到 x-goog-api-key（拿到 ${headers.keys.joinToString(",")}），改用页面内 XHR 钩子再试一次")
            headers = captureOnce(deadline, useJsHook = true)
        }
        val hasService = evalSync(JS_HAS_SERVICE, 5_000) == true
        if (!hasService) throw IOException("官网 WAA service 未暴露（snapshot key=$key）")

        val keep = ArrayList<Pair<String, String>>()
        for (name in HEADER_ORDER) {
            val v = headers[name]
            if (!v.isNullOrEmpty()) keep.add(name to v)
        }
        for (need in listOf("x-goog-api-key", "x-user-agent")) {
            if (keep.none { it.first == need }) throw IOException("官网 GenerateContent 缺少公共头 $need（拿到 ${headers.keys.joinToString(",")}）")
        }
        if (keep.none { it.first == "x-goog-authuser" }) keep.add("x-goog-authuser" to authUser.toString())
        protocolHeaders = keep
        headerNames = keep.map { it.first }

        // 模型表（失败不影响就绪）
        try {
            models = MakerSuiteWire.parseModels(rpcUnary("ListModels", "[]", 30_000))
        } catch (e: Exception) {
            log("[$accountId] ListModels 失败：${e.message}")
        }
        if (!email.isNullOrEmpty()) saveMeta { it.put("email", email) }
    }

    private fun captureOnce(deadline: Long, useJsHook: Boolean): Map<String, String> {
        val fut = CompletableFuture<Map<String, String>>()
        capture = fut
        try {
            if (useJsHook) evalSync(js(JS_XHR_HOOK), 5_000)
            val filled = evalSync("(" + JS_FILL + ")(" + JSONObject.quote(BOOTSTRAP_PROMPT) + ")", 5_000)
            if (filled != true) throw IOException("填写初始化提示词失败")
            poll(remaining(deadline, 15_000), 300) { if (evalSync(JS_RUN_ENABLED, 5_000) == true) true else null }
                ?: throw IOException("官网 Run 按钮没有启用")
            evalSync(JS_CLICK_RUN, 5_000)
            val h = try {
                fut.get(remaining(deadline, 60_000), TimeUnit.MILLISECONDS)
            } catch (e: Exception) {
                throw IOException("没有等到官网 GenerateContent 请求（拦截超时）")
            }
            return h
        } finally {
            capture = null
            if (useJsHook) try { evalSync(js(JS_XHR_UNHOOK), 5_000) } catch (_: Exception) {}
            try { evalSync(JS_STOP, 5_000) } catch (_: Exception) {}
            try { evalSync("(" + JS_FILL + ")('')", 5_000) } catch (_: Exception) {}
        }
    }

    private fun createWebView() {
        if (multiProfile()) ProfileStore.getInstance().getOrCreateProfile(profileName)
        val w = WebView(ctx.applicationContext)
        if (multiProfile()) WebViewCompat.setProfile(w, profileName)
        val s = w.settings
        s.javaScriptEnabled = true
        s.domStorageEnabled = true
        @Suppress("DEPRECATION")
        s.databaseEnabled = true
        s.mediaPlaybackRequiresUserGesture = true
        s.loadsImagesAutomatically = false // 省内存和流量；页面逻辑不依赖图片
        s.userAgentString = cleanUserAgent(WebSettings.getDefaultUserAgent(ctx))
        if (WebViewFeature.isFeatureSupported(WebViewFeature.USER_AGENT_METADATA)) {
            try {
                val meta = WebSettingsCompat.getUserAgentMetadata(s)
                val brands = meta.brandVersionList.map { b ->
                    if (b.brand.contains("WebView", ignoreCase = true))
                        UserAgentMetadata.BrandVersion.Builder(b).setBrand("Google Chrome").build()
                    else b
                }
                WebSettingsCompat.setUserAgentMetadata(s, UserAgentMetadata.Builder(meta).setBrandVersionList(brands).build())
            } catch (t: Throwable) {
                log("[$accountId] 改写 UA Client Hints 失败：${t.message}")
            }
        }
        if (WebViewFeature.isFeatureSupported(WebViewFeature.REQUESTED_WITH_HEADER_ALLOW_LIST)) {
            WebSettingsCompat.setRequestedWithHeaderOriginAllowList(s, emptySet())
        }
        cookieManager().setAcceptCookie(true)
        cookieManager().setAcceptThirdPartyCookies(w, true)

        w.webViewClient = object : WebViewClient() {
            override fun onPageStarted(view: WebView?, url: String?, favicon: Bitmap?) {
                pageUrl = url?.substringBefore('?') ?: ""
            }

            override fun onPageFinished(view: WebView?, url: String?) {
                pageUrl = url?.substringBefore('?') ?: ""
                pageFinished?.countDown()
            }

            override fun shouldInterceptRequest(view: WebView?, request: WebResourceRequest?): WebResourceResponse? {
                val f = capture ?: return null
                val r = request ?: return null
                if (!r.method.equals("POST", true)) return null
                val url = r.url?.toString() ?: return null
                if (!url.contains("/MakerSuiteService/GenerateContent")) return null
                val h = LinkedHashMap<String, String>()
                for ((k, v) in r.requestHeaders ?: emptyMap()) h[k.lowercase()] = v
                f.complete(h)
                // 拦下，不让这条初始化消息真正发出
                return WebResourceResponse(
                    MakerSuiteWire.CONTENT_TYPE, "utf-8", 503, "Service Unavailable",
                    mapOf("Access-Control-Allow-Origin" to StorageState.AISTUDIO_ORIGIN, "Access-Control-Allow-Credentials" to "true"),
                    ByteArrayInputStream("[]".toByteArray()),
                )
            }

            override fun onRenderProcessGone(view: WebView?, detail: RenderProcessGoneDetail?): Boolean {
                // 必须返回 true，否则整个 App 跟着崩
                log("[$accountId] WebView 渲染进程退出（crash=${detail?.didCrash()}），下次请求重建")
                if (web === view) web = null
                try { view?.destroy() } catch (_: Throwable) {}
                phase = Phase.FAILED
                error = "WebView 渲染进程退出"
                failAll("WebView 渲染进程退出")
                return true
            }
        }
        w.webChromeClient = WebChromeClient()

        if (WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER)) {
            WebViewCompat.addWebMessageListener(w, bridgeName, setOf(StorageState.AISTUDIO_ORIGIN)) { _, message, _, _, _ ->
                message.data?.let { onBridge(it) }
            }
        } else {
            w.addJavascriptInterface(object {
                @JavascriptInterface
                fun postMessage(s: String) = onBridge(s)
            }, bridgeName)
        }

        // 不挂到窗口上：手动给一个桌面尺寸的布局，页面的可见性判断和输入框才能正常工作
        val wSpec = View.MeasureSpec.makeMeasureSpec(1280, View.MeasureSpec.EXACTLY)
        val hSpec = View.MeasureSpec.makeMeasureSpec(2000, View.MeasureSpec.EXACTLY)
        w.measure(wSpec, hSpec)
        w.layout(0, 0, 1280, 2000)
        w.onResume()
        w.resumeTimers()
        web = w
    }

    private fun cookieManager(): CookieManager =
        if (multiProfile()) ProfileStore.getInstance().getOrCreateProfile(profileName).cookieManager else CookieManager.getInstance()

    private fun installCookies(state: StorageState, meta: JSONObject) {
        val cm = cookieManager()
        // 独立 Profile 里已经有登录 Cookie 且导入后装过：沿用 WebView 自己维护（已轮换）的 Cookie
        val existing = Sapisid.parseCookieHeader(cm.getCookie(StorageState.AISTUDIO_ORIGIN + "/"))
        if (multiProfile() && meta.optBoolean("cookies_installed", false) && !existing["SAPISID"].isNullOrEmpty()) {
            log("[$accountId] 沿用 WebView Profile 里的 Cookie")
            return
        }
        val done = CountDownLatch(1)
        onMain {
            cm.removeAllCookies {
                for (c in state.cookies) cm.setCookie(c.url(), c.setCookieHeader())
                cm.flush()
                done.countDown()
            }
        }
        if (!done.await(15, TimeUnit.SECONDS)) throw IOException("写入 Cookie 超时")
        val after = Sapisid.parseCookieHeader(cm.getCookie(StorageState.AISTUDIO_ORIGIN + "/"))
        val missing = StorageState.REQUIRED_COOKIES.filter { after[it].isNullOrEmpty() }
        if (missing.isNotEmpty()) {
            phase = Phase.AUTH_REQUIRED
            throw IOException("Cookie 写入后缺少 ${missing.joinToString(",")}")
        }
        saveMeta { it.put("cookies_installed", true) }
        log("[$accountId] 写入 ${state.cookies.size} 个 Cookie")
    }

    /** 把 WebView 里轮换过的 Cookie 值写回 storage-state.json（只更新同名 Cookie 的值） */
    fun saveCookiesBack() {
        try {
            val f = File(dir, "storage-state.json")
            if (!f.isFile) return
            val live = Sapisid.parseCookieHeader(cookieManager().getCookie(StorageState.AISTUDIO_ORIGIN + "/"))
            if (live.isEmpty()) return
            val doc = JSONObject(f.readText(Charsets.UTF_8))
            val cs = doc.optJSONArray("cookies") ?: return
            var changed = 0
            for (i in 0 until cs.length()) {
                val c = cs.optJSONObject(i) ?: continue
                val v = live[c.optString("name")] ?: continue
                if (StorageState.isGoogleDomain(c.optString("domain")) && c.optString("value") != v) { c.put("value", v); changed++ }
            }
            if (changed > 0) {
                val tmp = File(dir, "storage-state.json.tmp")
                tmp.writeText(doc.toString(), Charsets.UTF_8)
                tmp.renameTo(f)
            }
        } catch (_: Throwable) {}
    }

    // ------------------------------------------------------------------ 请求

    /** 为 binding prompt 生成 fresh proof（页面输入框先写入 pagePrompt）；同一账号串行 */
    fun proof(binding: String, pagePrompt: String): String {
        val digest = MakerSuiteWire.sha256Hex(binding)
        val prompt = pagePrompt.replace("\r\n", "\n").replace('\r', '\n')
        synchronized(proofLock) {
            val deadline = System.currentTimeMillis() + 5_000
            while (true) {
                val r = callAsync(JS_PROOF, 30_000, JSONObject.quote(prompt), JSONObject.quote(digest))
                val v = r.opt("v")
                if (v is String) {
                    if (!v.startsWith("!")) throw IOException("WAA proof 前缀无效")
                    return v
                }
                if (System.currentTimeMillis() > deadline) throw IOException("页面输入框状态没同步，无法生成 proof")
                Thread.sleep(100)
            }
        }
    }

    /** 当前对 aistudio 可见的 Cookie 生成的 Authorization（不落日志） */
    fun authorization(): String = Sapisid.authorization(Sapisid.parseCookieHeader(cookieManager().getCookie(StorageState.AISTUDIO_ORIGIN + "/")))

    /** 页面内发出的一次 RPC；next() 依次给出 {t:h,status} / {t:d,s} / {t:end} / {t:err,e} */
    inner class Stream(val id: String, private val q: LinkedBlockingQueue<JSONObject>) {
        fun next(timeoutMs: Long): JSONObject? = q.poll(timeoutMs, TimeUnit.MILLISECONDS)
        fun cancel() {
            streams.remove(id)
            try { evalAsyncFire("(function(){var r=window[Symbol.for('wg.reqs')];var x=r&&r[" + JSONObject.quote(id) + "];if(x){try{x.abort()}catch(e){};delete r[" + JSONObject.quote(id) + "];}})()") } catch (_: Exception) {}
        }
    }

    fun send(method: String, body: String): Stream {
        val id = randomHex(8)
        val q = LinkedBlockingQueue<JSONObject>()
        streams[id] = q
        val hs = JSONArray()
        for ((k, v) in protocolHeaders) hs.put(JSONArray().put(k).put(v))
        hs.put(JSONArray().put("authorization").put(authorization()))
        hs.put(JSONArray().put("content-type").put(MakerSuiteWire.CONTENT_TYPE))
        val r = callAsync(JS_SEND, 15_000, JSONObject.quote(id), JSONObject.quote(MakerSuiteWire.RPC_BASE + method), hs.toString(), JSONObject.quote(body))
        if (r.opt("v") != true) { streams.remove(id); throw IOException("页面发送请求失败") }
        return Stream(id, q)
    }

    /** 非流式 RPC（ListModels 等），返回正文；非 200 抛 RpcError */
    fun rpcUnary(method: String, body: String, timeoutMs: Long): String {
        val s = send(method, body)
        val sb = StringBuilder()
        var status = 0
        val deadline = System.currentTimeMillis() + timeoutMs
        try {
            while (true) {
                val ev = s.next(Math.max(1, deadline - System.currentTimeMillis())) ?: throw IOException("$method 超时")
                when (ev.optString("t")) {
                    "h" -> status = ev.optInt("status")
                    "d" -> sb.append(ev.optString("s"))
                    "end" -> { status = ev.optInt("status", status); break }
                    "err" -> throw IOException("$method 网络错误：" + ev.optString("e"))
                }
            }
        } finally {
            streams.remove(s.id)
        }
        if (status != 200) throw MakerSuiteWire.decodeError(status, sb.toString())
        return sb.toString()
    }

    // ------------------------------------------------------------------ bridge / JS 调用

    private fun onBridge(s: String) {
        val o = try { JSONObject(s) } catch (e: Exception) { return }
        val id = o.optString("id")
        when (o.optString("t")) {
            "r" -> pending.remove(id)?.complete(o)
            "cap" -> {
                val f = capture ?: return
                val h = LinkedHashMap<String, String>()
                val arr = o.optJSONArray("h") ?: JSONArray()
                for (i in 0 until arr.length()) {
                    val p = arr.optJSONArray(i) ?: continue
                    h[p.optString(0).lowercase()] = p.optString(1)
                }
                f.complete(h)
            }
            else -> streams[id]?.offer(o)
        }
    }

    private fun js(template: String) = template.replace("__B__", bridgeName)

    /** evaluateJavascript 同步版：返回 JSON 解码后的值（String/Boolean/Number/JSONObject/null） */
    private fun evalSync(script: String, timeoutMs: Long): Any? {
        val f = CompletableFuture<String?>()
        onMain {
            val w = web
            if (w == null) f.completeExceptionally(IOException("WebView 不存在")) else w.evaluateJavascript(script) { f.complete(it) }
        }
        val raw = try { f.get(timeoutMs, TimeUnit.MILLISECONDS) } catch (e: Exception) { throw IOException("页面脚本超时或失败", e) }
        if (raw == null || raw == "null") return null
        return try { JSONTokener(raw).nextValue().let { if (it == JSONObject.NULL) null else it } } catch (e: Exception) { raw }
    }

    private fun evalAsyncFire(script: String) = onMain { web?.evaluateJavascript(script, null) }

    /** 调用页面里的 async 函数，结果经 bridge 回来：{ok, v} / {ok:false, e} */
    private fun callAsync(fn: String, timeoutMs: Long, vararg args: String): JSONObject {
        val id = randomHex(6)
        val f = CompletableFuture<JSONObject>()
        pending[id] = f
        val script = "(function(){var B=window['$bridgeName'];var id='$id';Promise.resolve().then(function(){return (" + js(fn) + ")(" + args.joinToString(",") + ");})" +
            ".then(function(v){B.postMessage(JSON.stringify({t:'r',id:id,ok:true,v:(v===undefined?null:v)}));}," +
            "function(e){B.postMessage(JSON.stringify({t:'r',id:id,ok:false,e:String(e&&e.message||e)}));});})();"
        evalAsyncFire(script)
        val r = try { f.get(timeoutMs, TimeUnit.MILLISECONDS) } catch (e: Exception) {
            pending.remove(id)
            throw IOException("页面调用超时", e)
        }
        if (!r.optBoolean("ok")) throw IOException("页面脚本出错：" + r.optString("e").take(200))
        return r
    }

    private fun loadAndWait(load: (WebView) -> Unit, timeoutMs: Long) {
        val latch = CountDownLatch(1)
        pageFinished = latch
        onMain { web?.let(load) }
        latch.await(timeoutMs, TimeUnit.MILLISECONDS)
        pageFinished = null
    }

    private fun onMain(block: () -> Unit) {
        if (Looper.myLooper() == Looper.getMainLooper()) { block(); return }
        val done = CountDownLatch(1)
        var err: Throwable? = null
        main.post { try { block() } catch (t: Throwable) { err = t } finally { done.countDown() } }
        if (!done.await(20, TimeUnit.SECONDS)) throw IOException("主线程繁忙")
        err?.let { throw IOException(it.message ?: it.toString(), it) }
    }

    private fun <T> poll(timeoutMs: Long, intervalMs: Long, probe: () -> T?): T? {
        val end = System.currentTimeMillis() + timeoutMs
        while (System.currentTimeMillis() < end) {
            val v = try { probe() } catch (e: IOException) { null }
            if (v != null) return v
            Thread.sleep(intervalMs)
        }
        return null
    }

    private fun remaining(deadline: Long, cap: Long) = Math.max(1000L, Math.min(cap, deadline - System.currentTimeMillis()))

    // ------------------------------------------------------------------ account.json

    private fun readMeta(): JSONObject = try { JSONObject(File(dir, "account.json").readText(Charsets.UTF_8)) } catch (e: Exception) { JSONObject() }

    @Synchronized
    private fun saveMeta(edit: (JSONObject) -> Unit) {
        try {
            val m = readMeta()
            edit(m)
            File(dir, "account.json").writeText(m.toString(), Charsets.UTF_8)
        } catch (_: Throwable) {}
    }

    companion object {
        private val rnd = SecureRandom()
        fun randomHex(bytes: Int): String { val b = ByteArray(bytes); rnd.nextBytes(b); return b.joinToString("") { "%02x".format(it) } }

        fun multiProfile(): Boolean = try { WebViewFeature.isFeatureSupported(WebViewFeature.MULTI_PROFILE) } catch (t: Throwable) { false }

        /** 去掉 WebView 标记：“; wv” 与 “Version/4.0” */
        fun cleanUserAgent(ua: String): String = ua.replace("; wv)", ")").replace(" Version/4.0", "").replace(Regex("\\s{2,}"), " ").trim()

        const val BOOTSTRAP_PROMPT = "Hi"

        /** 发 GenerateContent 时带的页面公共头，按官网顺序 */
        val HEADER_ORDER = listOf(
            "x-aistudio-g1-tier", "x-aistudio-visit-id", "x-goog-ext-519733851-bin", "x-goog-api-key", "x-goog-authuser", "x-user-agent",
        )

        private const val TEXTAREA = "document.querySelector('ms-prompt-box textarea')||document.querySelector('ms-chunk-input textarea')||document.querySelector('textarea')"

        const val JS_READY = "(function(){if(location.hostname==='accounts.google.com')return 'login';var t=$TEXTAREA;return t?'ready':'wait';})()"

        const val JS_EMAIL = "(function(){var n=document.querySelectorAll('[aria-label]');for(var i=0;i<n.length;i++){var m=(n[i].getAttribute('aria-label')||'').match(/[\\w.+-]+@[\\w-]+\\.[\\w.-]+/);if(m)return m[0];}return null;})()"

        const val JS_DISMISS = "(function(){var s=['ms-g1-welcome-dialog button[aria-label=\"Close dialog\"]','button[aria-label=\"Close guided tour\"]','#glue-cookie-notification-bar-1 .glue-cookie-notification-bar__reject','mat-dialog-container button[aria-label=\"Close\"]'];var c=0;for(var i=0;i<s.length;i++){var b=document.querySelector(s[i]);if(b&&!b.disabled){try{b.click();c++;}catch(e){}}}return c;})()"

        /** 找到 default_MakerSuite 里调用 .snapshot({ 的函数，替换成：第一次被调用时记下 service 参数并恢复原函数 */
        const val JS_HOOK = "(function(){var S=Symbol.for('wg.page');if(window[S])return window[S].key;var ms=window.default_MakerSuite;if(!ms)return null;" +
            "var ks=Object.keys(ms);for(var i=0;i<ks.length;i++){var k=ks[i],f;try{f=ms[k];if(typeof f!=='function')continue;var src=Function.prototype.toString.call(f);" +
            "if(src.indexOf('.snapshot({')<0||src.indexOf('content')<0||src.indexOf('yield')<0)continue;}catch(e){continue;}" +
            "var page={key:k,service:null};(function(k,f,page){page.snapshot=function(d){return f.call(ms,page.service,d);};" +
            "ms[k]=function(){var s=arguments[0];if(s&&(typeof s==='object'||typeof s==='function')){page.service=s;ms[k]=f;}return f.apply(this,arguments);};})(k,f,page);" +
            "Object.defineProperty(window,S,{value:page,configurable:true});return k;}return null;})()"

        const val JS_HAS_SERVICE = "(function(){var p=window[Symbol.for('wg.page')];return !!(p&&p.service);})()"

        /** 写输入框（原生 setter + input/change 事件，Angular 才认）；返回页面值是否一致 */
        const val JS_FILL = "function(p){var t=$TEXTAREA;if(!t)return false;var set=Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set;" +
            "set.call(t,p);t.dispatchEvent(new InputEvent('input',{bubbles:true,inputType:p?'insertText':'deleteContent',data:p||null}));t.dispatchEvent(new Event('change',{bubbles:true}));return t.value===p;}"

        const val JS_RUN_ENABLED = "(function(){var b=document.querySelector('ms-run-button button');return !!(b&&!b.disabled&&!b.closest('[aria-disabled=\"true\"]'));})()"
        const val JS_CLICK_RUN = "(function(){var b=document.querySelector('ms-run-button button');if(!b)return false;b.click();return true;})()"
        const val JS_STOP = "(function(){var b=document.querySelector('ms-run-button button');if(b&&b.querySelector('.spin')&&!b.disabled){b.click();return true;}return false;})()"

        /** 写入页面提示词后用官网 service 为 digest 生成 proof，之后清空输入框；值不同步时返回 null */
        const val JS_PROOF = "async function(prompt,digest){var P=window[Symbol.for('wg.page')];if(!P||!P.service)throw new Error('WAA service 未就绪');" +
            "var t=$TEXTAREA;if(!t)throw new Error('输入框不存在');var set=Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set;" +
            "set.call(t,prompt);t.dispatchEvent(new InputEvent('input',{bubbles:true,inputType:'insertText',data:prompt}));t.dispatchEvent(new Event('change',{bubbles:true}));" +
            "try{return t.value===prompt?await P.snapshot(digest):null;}finally{set.call(t,'');t.dispatchEvent(new InputEvent('input',{bubbles:true,inputType:'deleteContent'}));}}"

        /** 页面内用带 Cookie 的原生 XHR 发请求，状态、正文增量、结束经 bridge 回传 */
        const val JS_SEND = "function(id,url,headers,body){var B=window['__B__'];var R=window[Symbol.for('wg.reqs')];" +
            "if(!R){R={};Object.defineProperty(window,Symbol.for('wg.reqs'),{value:R});}var x=new XMLHttpRequest();R[id]=x;var sent=0,hd=false,done=false;" +
            "function emit(o){o.id=id;B.postMessage(JSON.stringify(o));}" +
            "function flush(){if(!hd&&x.readyState>=2){hd=true;emit({t:'h',status:x.status});}var s=x.responseText||'';if(s.length>sent){emit({t:'d',s:s.slice(sent)});sent=s.length;}}" +
            "x.open('POST',url);x.withCredentials=true;for(var i=0;i<headers.length;i++)x.setRequestHeader(headers[i][0],headers[i][1]);" +
            "x.onreadystatechange=function(){if(x.readyState>=2&&x.readyState<4)flush();};x.onprogress=flush;" +
            "x.onload=function(){if(done)return;done=true;flush();emit({t:'end',status:x.status});delete R[id];};" +
            "x.onerror=function(){if(done)return;done=true;emit({t:'err',e:'network error (status '+x.status+')'});delete R[id];};" +
            "x.onabort=function(){if(done)return;done=true;emit({t:'err',e:'aborted'});delete R[id];};" +
            "x.send(body);return true;}"

        /** 备用：页面内 XHR/fetch 钩子，只记录 GenerateContent 的请求头名和值并中止；用完立刻还原 */
        const val JS_XHR_HOOK = "(function(){var X=XMLHttpRequest.prototype;if(window[Symbol.for('wg.hook')])return true;var o={open:X.open,send:X.send,set:X.setRequestHeader,fetch:window.fetch};" +
            "Object.defineProperty(window,Symbol.for('wg.hook'),{value:o,configurable:true});var B=window['__B__'];" +
            "X.open=function(m,u){this.__u=String(u);this.__h=[];return o.open.apply(this,arguments);};" +
            "X.setRequestHeader=function(n,v){if(this.__h)this.__h.push([n,v]);return o.set.apply(this,arguments);};" +
            "X.send=function(b){if(this.__u&&this.__u.indexOf('/MakerSuiteService/GenerateContent')>=0){B.postMessage(JSON.stringify({t:'cap',h:this.__h}));var s=this;setTimeout(function(){try{s.abort()}catch(e){}},0);return;}return o.send.apply(this,arguments);};" +
            "window.fetch=function(i,init){var u=typeof i==='string'?i:(i&&i.url)||'';if(u.indexOf('/MakerSuiteService/GenerateContent')>=0){var hs=[],h=(init&&init.headers)||(i&&i.headers);" +
            "if(h){if(typeof h.forEach==='function')h.forEach(function(v,k){hs.push([k,v]);});else if(Array.isArray(h))hs=h.slice();else for(var k in h)hs.push([k,h[k]]);}" +
            "B.postMessage(JSON.stringify({t:'cap',h:hs}));return Promise.reject(new DOMException('aborted','AbortError'));}return o.fetch.apply(this,arguments);};return true;})()"

        const val JS_XHR_UNHOOK = "(function(){var o=window[Symbol.for('wg.hook')];if(!o)return false;var X=XMLHttpRequest.prototype;X.open=o.open;X.send=o.send;X.setRequestHeader=o.set;window.fetch=o.fetch;delete window[Symbol.for('wg.hook')];return true;})()"
    }
}
