package com.wag2api.app.ais

import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Before
import org.junit.Test
import java.io.File
import java.io.IOException
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit

/** [beta] MainThread.call：后台线程切到“主线程”执行并等待；主线程上直接执行；异常与超时转成 IOException */
class MainThreadTest {
    private val fakeMain = Executors.newSingleThreadExecutor { r -> Thread(r, "fake-main") }
    private lateinit var origIsMain: () -> Boolean
    private lateinit var origPost: (Runnable) -> Unit

    @Before fun setUp() {
        origIsMain = MainThread.isMain
        origPost = MainThread.post
        MainThread.isMain = { Thread.currentThread().name == "fake-main" }
        MainThread.post = { r -> fakeMain.execute(r) }
    }

    @After fun tearDown() {
        MainThread.isMain = origIsMain
        MainThread.post = origPost
        fakeMain.shutdownNow()
        fakeMain.awaitTermination(2, TimeUnit.SECONDS)
    }

    @Test fun runsOnMainAndReturnsValue() {
        val name = MainThread.call { Thread.currentThread().name }
        assertEquals("fake-main", name)
    }

    @Test fun inlineWhenAlreadyOnMainNoDeadlock() {
        val v = fakeMain.submit<String> { MainThread.call(500) { MainThread.call(500) { "nested-" + Thread.currentThread().name } } }.get(3, TimeUnit.SECONDS)
        assertEquals("nested-fake-main", v)
    }

    @Test fun propagatesExceptionAsIOException() {
        try {
            MainThread.call<Unit> { throw IllegalStateException("Must be called on the UI thread.") }
            fail("应抛异常")
        } catch (e: IOException) {
            assertTrue(e.message!!.contains("UI thread"))
        }
    }

    @Test fun timesOutWhenMainBusy() {
        fakeMain.execute { Thread.sleep(1_000) }
        val t0 = System.currentTimeMillis()
        try {
            MainThread.call(200) { 1 }
            fail("应超时")
        } catch (e: IOException) {
            assertTrue(System.currentTimeMillis() - t0 < 900)
        }
    }

    /**
     * 源码守卫：ais/ 下 ProfileStore.getInstance() / cookieManager() 只能出现在主线程上下文里
     * （createWebView、cookieManager 定义、withCookies、onMain { } 块、MainThread.call { } 包裹）。
     */
    @Test fun webviewOnlyApisAreWrapped() {
        val dir = listOf("src/main/java/com/wag2api/app/ais", "app/src/main/java/com/wag2api/app/ais").map(::File).firstOrNull { it.isDirectory }
            ?: return // 工作目录不同时跳过
        val bad = ArrayList<String>()
        for (f in dir.listFiles { x -> x.name.endsWith(".kt") && x.name != "MainThread.kt" }!!) {
            val lines = f.readLines()
            var fn = ""
            for ((i, line) in lines.withIndex()) {
                Regex("""\bfun\s+(?:<[^>]+>\s*)?(\w+)\s*\(""").find(line)?.let { fn = it.groupValues[1] }
                val code = line.substringBefore("//")
                if (!code.contains("ProfileStore.getInstance()") && !code.contains("cookieManager()")) continue
                if (code.trimStart().startsWith("*")) continue
                val ctx = (maxOf(0, i - 3)..i).joinToString("\n") { lines[it] }
                val ok = fn in setOf("createWebView", "cookieManager", "withCookies") || code.contains("MainThread.call") || ctx.contains("onMain {")
                if (!ok) bad.add("${f.name}:${i + 1} ($fn) ${line.trim()}")
            }
        }
        assertTrue("后台线程直接调用了只能在主线程用的 WebView API：\n" + bad.joinToString("\n"), bad.isEmpty())
    }
}
