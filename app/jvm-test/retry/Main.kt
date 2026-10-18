import com.wag2api.app.*
import android.content.Context
import okhttp3.mockwebserver.*
import org.json.JSONObject
import java.io.File
import java.util.concurrent.*
import java.util.concurrent.atomic.AtomicInteger

val FIX = System.getProperty("variant") == "fix"
var pass = 0; var fail = 0
fun check(name: String, cond: Boolean, info: String = "") { if (cond) { pass++; println("  PASS $name") } else { fail++; println("  FAIL $name $info") } }

lateinit var server: MockWebServer
val log = CopyOnWriteArrayList<String>()   // "path|uid|auth"
var handler: (RecordedRequest) -> MockResponse = { MockResponse().setResponseCode(500) }

fun sse(vararg chunks: String) = MockResponse().setHeader("Content-Type", "text/event-stream")
    .setBody(chunks.joinToString("") { "data: {\"choices\":[{\"delta\":{\"content\":\"$it\"}}]}\n\n" } + "data: [DONE]\n\n")

fun setup(n: Int, refresh: Boolean = false): Context {
    val dir = File.createTempFile("vault", "").apply { delete(); mkdirs() }
    val ctx = Context(dir)
    AccountVault.init(ctx); AccountScheduler.init(ctx); TencentGateway.attach(ctx)
    AccountScheduler.clearAllCooldowns()
    for (i in 1..n) AccountVault.saveAccount("u$i", "n$i", "global", "AT$i", if (refresh) "RT$i" else "")
    log.clear()
    return ctx
}

fun run(timeoutMs: Long = 20000): Triple<List<String>, Throwable?, Boolean> {
    val out = CopyOnWriteArrayList<String>()
    var err: Throwable? = null
    val t = Thread {
        try { TencentGateway.streamChat(JSONObject().put("model", "x").put("messages", org.json.JSONArray())) { out.add(it); true } }
        catch (e: Throwable) { err = e }
    }
    t.isDaemon = true; t.start(); t.join(timeoutMs)
    val hung = t.isAlive
    return Triple(out.filter { it.contains("content") }, err, hung)
}

fun main() {
    server = MockWebServer()
    server.dispatcher = object : Dispatcher() {
        override fun dispatch(r: RecordedRequest): MockResponse {
            log.add("${r.path}|${r.getHeader("X-User-Id")}|${r.getHeader("Authorization")}|${r.getHeader("X-Refresh-Token")}")
            return handler(r)
        }
    }
    server.start(18555)
    println("variant=${if (FIX) "fix" else "orig"}")

    println("T1 429 on u1 -> rotate to u2, no /console hit on the limited account")
    val c1 = setup(2); AccountScheduler.setSelectedUid(c1, "u1")
    handler = { r -> if (r.getHeader("X-User-Id") == "u1") MockResponse().setResponseCode(429).setBody("{\"code\":14003,\"msg\":\"busy\"}") else sse("hi") }
    // force u1 first

    run().let { (out, err, _) ->
        check("one content line", out.size == 1, "out=${out.size} err=$err")
        val u1Console = log.count { it.startsWith("/console") && it.contains("|u1|") }
        check("u1 was tried first", log.firstOrNull()?.contains("|u1|") == true, "log=$log")
        check("no /console retry on 429", u1Console == 0, "log=$log")
    }
    AccountScheduler.setSelectedUid(c1, "")

    println("T2 stream breaks mid-way after first token -> no replay (no duplicate output)")
    setup(1)
    handler = { r -> if (r.path!!.startsWith("/v2")) sse("A", "B", "C").setSocketPolicy(SocketPolicy.DISCONNECT_DURING_RESPONSE_BODY).throttleBody(40, 50, TimeUnit.MILLISECONDS) else sse("A", "B", "C") }
    run().let { (out, err, _) ->
        val a = out.count { it.contains("\"A\"") }
        check("token A emitted at most once", a <= 1, "A x$a, total=${out.size}, log=${log.map{it.substringBefore('|')}}")
        check("error surfaced to caller", err != null, "")
    }

    println("T3 every account 429 forever -> terminates in bounded time")
    setup(2)
    handler = { MockResponse().setResponseCode(429).setBody("{\"code\":14003}") }
    val t0 = System.currentTimeMillis()
    run(25000).let { (_, err, hung) ->
        check("not hung after 25s", !hung, "still running, upstream hits=${log.size}")
        if (!hung) println("    took ${System.currentTimeMillis() - t0} ms, upstream hits=${log.size}, err=${err?.javaClass?.simpleName}")
        check("throws an error", hung || err != null)
    }

    println("T4 401 -> refresh via /v2/plugin/auth/token/refresh -> retry same account with new token")
    setup(1, refresh = true)
    handler = { r ->
        when {
            r.path == "/v2/plugin/auth/token/refresh" -> MockResponse().setBody("{\"code\":0,\"data\":{\"accessToken\":\"NEW\",\"refreshToken\":\"RT-NEW\",\"expiresIn\":5184000}}")
            r.getHeader("Authorization") == "Bearer NEW" -> sse("ok")
            else -> MockResponse().setResponseCode(401).setBody("{\"code\":401}")
        }
    }
    run().let { (out, err, _) ->
        check("succeeds after refresh", out.size == 1, "err=$err log=$log")
        check("refresh sent X-Refresh-Token", log.any { it.startsWith("/v2/plugin/auth/token/refresh") && it.endsWith("|RT1") }, "log=$log")
    }

    if (FIX) {
        println("T5 concurrent acquire spreads load")
        val ctx = setup(2)
        val got = (1..4).map { AccountScheduler.acquire(ctx, "global")!!.optString("uid") }
        check("2/2 split", got.count { it == "u1" } == 2 && got.count { it == "u2" } == 2, "$got")
        got.forEach { AccountScheduler.release(it) }

        println("T6 setDisabled / updateTokens on file-backed accounts")
        setup(2, refresh = true)
        AccountVault.setDisabled("u1", true)
        check("disabled sticks", AccountVault.getAccountByUid("u1")!!.optBoolean("disabled"))
        check("pick skips disabled", AccountScheduler.pick(ctx, "global")?.optString("uid") == "u2")
        AccountVault.updateTokens("u2", "AT-new", null)
        check("refreshToken preserved", AccountVault.getAccountByUid("u2")!!.optString("refreshToken") == "RT2")
    }

    println("RESULT pass=$pass fail=$fail")
    server.shutdown()
    System.exit(0)
}
