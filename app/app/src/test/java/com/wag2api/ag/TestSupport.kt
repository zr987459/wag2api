package com.wag2api.ag

import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import java.io.ByteArrayInputStream
import java.io.IOException
import java.io.InputStream

/** 单测公用：紧凑 JSON 写法（单引号当双引号）、JSON 深比较、假的上游流和客户端 */
internal object T {
    /** j("{'a':1}")：单引号替换成双引号再解析（用例里的字符串都不含单引号） */
    fun j(s: String): JSONObject = JSONObject(s.replace('\'', '"'))
    fun ja(s: String): JSONArray = JSONArray(s.replace('\'', '"'))

    /** = assert.deepStrictEqual（对象键无序，数字按值比较） */
    fun assertJson(expected: Any?, actual: Any?, msg: String = "") {
        val ok = when {
            expected is JSONObject && actual is JSONObject -> expected.similar(actual)
            expected is JSONArray && actual is JSONArray -> expected.similar(actual)
            expected is Number && actual is Number -> expected.toDouble() == actual.toDouble()
            else -> expected == actual
        }
        if (!ok) fail("$msg\nexpected: $expected\n  actual: $actual")
    }

    /** Gemini SSE 一帧：data: {"response": obj}\n\n */
    fun sse(obj: JSONObject): String = "data: " + JSONObject().put("response", obj) + "\n\n"
    fun sse(obj: String): String = sse(j(obj))

    fun upstream(vararg frames: String): InputStream = ByteArrayInputStream(frames.joinToString("").toByteArray(Charsets.UTF_8))

    /** 先吐完 frames，再抛 IOException（= 上游中途 reset） */
    fun failingUpstream(vararg frames: String): InputStream = object : InputStream() {
        private val data = ByteArrayInputStream(frames.joinToString("").toByteArray(Charsets.UTF_8))
        override fun read(): Int {
            val b = data.read()
            if (b < 0) throw IOException("upstream reset")
            return b
        }
        override fun read(b: ByteArray, off: Int, len: Int): Int {
            val n = data.read(b, off, len)
            if (n <= 0) throw IOException("upstream reset")
            return n
        }
    }

    /** 记录 close 的上游；frames 读完后返回 EOF */
    class TrackedUpstream(vararg frames: String) : InputStream() {
        private val data = ByteArrayInputStream(frames.joinToString("").toByteArray(Charsets.UTF_8))
        @Volatile var closed = false
        override fun read(): Int = data.read()
        override fun read(b: ByteArray, off: Int, len: Int): Int = data.read(b, off, len)
        override fun close() { closed = true }
    }

    /** 收集写出内容的客户端；failAfterWrites >= 0 时第 N+1 次 write 起抛 IOException（= 客户端断开） */
    class FakeClient(private val failAfterWrites: Int = -1) : SseStreamer.StreamClient {
        val out = StringBuilder()
        var writes = 0
        var ended = false
        val headers = LinkedHashMap<String, String>()
        override fun setHeader(name: String, value: String) { headers[name] = value }
        override fun flushHeaders() {}
        override fun write(chunk: String) {
            if (failAfterWrites in 0..writes) throw IOException("client gone")
            writes++
            out.append(chunk)
        }
        override fun end() { ended = true }
        override fun toString(): String = out.toString()
    }

    /** Anthropic SSE 输出 → [(event, data)] */
    fun aEvents(out: String): List<Pair<String?, JSONObject>> = out.split("\n\n").filter { it.isNotBlank() }.map { b ->
        val ev = Regex("(?m)^event: (.*)$").find(b)?.groupValues?.get(1)
        val data = Regex("(?m)^data: (.*)$").find(b)!!.groupValues[1]
        ev to JSONObject(data)
    }

    /** OpenAI SSE 输出 → 去掉 [DONE] 的 chunk 列表 */
    fun oChunks(out: String): List<JSONObject> = out.split("\n\n")
        .filter { it.startsWith("data: ") && !it.contains("[DONE]") }
        .map { JSONObject(it.substring(6)) }

    fun keys(o: JSONObject): List<String> = o.keys().asSequence().toList().sorted()

    fun assertContains(hay: String, needle: String, msg: String = "") =
        assertTrue("$msg（缺少 $needle）", hay.contains(needle))
}
