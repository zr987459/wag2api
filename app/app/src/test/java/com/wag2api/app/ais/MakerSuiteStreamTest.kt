package com.wag2api.app.ais

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test

/**
 * 流式解析：样例按上游 docs/protocol.md 第 5 节的帧结构构造（思考摘要、正文、含引号与括号的正文、函数调用 + 签名、
 * 完成帧 finish+usage+turnToken，并带 Google 省略空槽的写法），不需要真实账号。
 */
class MakerSuiteStreamTest {

    private fun fixture(name: String): String =
        javaClass.getResourceAsStream("/ais/$name")!!.readBytes().toString(Charsets.UTF_8)

    private fun decodeInChunks(text: String, size: Int, systemTokens: Int = 0): Pair<List<JSONObject>, MakerSuiteStream> {
        val d = MakerSuiteStream(systemTokens)
        val out = ArrayList<JSONObject>()
        var i = 0
        while (i < text.length) {
            out.addAll(d.feed(text.substring(i, Math.min(text.length, i + size))))
            i += size
        }
        assertTrue(d.end(200))
        return out to d
    }

    @Test
    fun decodesFramesRegardlessOfChunking() {
        val text = fixture("generate-stream.txt")
        val reference = decodeInChunks(text, text.length).first.map { it.toString() }
        assertEquals(5, reference.size)
        for (size in intArrayOf(1, 3, 7, 64, 1000)) {
            assertEquals("chunk=$size", reference, decodeInChunks(text, size).first.map { it.toString() })
        }
    }

    @Test
    fun mapsPartsFinishAndUsage() {
        val (chunks, d) = decodeInChunks(fixture("generate-stream.txt"), 5)
        fun part(i: Int) = chunks[i].getJSONArray("candidates").getJSONObject(0).getJSONObject("content").getJSONArray("parts").getJSONObject(0)
        assertTrue(part(0).getBoolean("thought"))
        assertEquals("Let me think", part(0).getString("text"))
        assertEquals("Hello, ", part(1).getString("text"))
        assertFalse(part(1).has("thought"))
        assertEquals("世界 \"quoted\" ][", part(2).getString("text"))
        val fc = part(3).getJSONObject("functionCall")
        assertEquals("get_weather", fc.getString("name"))
        assertEquals("Paris", fc.getJSONObject("args").getString("city"))
        assertEquals(3, fc.getJSONObject("args").getInt("days"))
        assertEquals("call_1", fc.getString("id"))
        assertEquals("sig123", part(3).getString("thoughtSignature"))

        val last = chunks[4]
        assertEquals("STOP", last.getJSONArray("candidates").getJSONObject(0).getString("finishReason"))
        val u = last.getJSONObject("usageMetadata")
        assertEquals(27, u.getInt("promptTokenCount"))
        assertEquals(6, u.getInt("candidatesTokenCount"))
        assertEquals(40, u.getInt("totalTokenCount"))
        assertEquals(7, u.getInt("thoughtsTokenCount"))
        assertEquals(5, u.getInt("cachedContentTokenCount"))
        assertEquals("STOP", d.finishReason)
        assertEquals(5, d.frames)

        // 带 system 时减掉 1 个 token
        val u2 = decodeInChunks(fixture("generate-stream.txt"), 9, systemTokens = 1).first[4].getJSONObject("usageMetadata")
        assertEquals(26, u2.getInt("promptTokenCount"))
        assertEquals(39, u2.getInt("totalTokenCount"))

        // 每块都能写成 SseStreamer 能读的 data: 行
        assertTrue(MakerSuiteStream.sseLine(chunks[1]).startsWith("data: {") && MakerSuiteStream.sseLine(chunks[1]).endsWith("\n\n"))
    }

    @Test
    fun aggregatesForNonStreaming() {
        val (chunks, _) = decodeInChunks(fixture("generate-stream.txt"), 11)
        val g = MakerSuiteStream.aggregate(chunks)
        val parts = g.getJSONArray("candidates").getJSONObject(0).getJSONObject("content").getJSONArray("parts")
        // 思考 1 段 + 正文合并 1 段 + 函数调用 1 段
        assertEquals(3, parts.length())
        assertEquals("Hello, 世界 \"quoted\" ][", parts.getJSONObject(1).getString("text"))
        assertTrue(parts.getJSONObject(2).has("functionCall"))
        assertEquals("STOP", g.getJSONArray("candidates").getJSONObject(0).getString("finishReason"))
        assertEquals(40, g.getJSONObject("usageMetadata").getInt("totalTokenCount"))
    }

    @Test
    fun errorBodyThrows() {
        val d = MakerSuiteStream()
        assertTrue(d.feed(fixture("generate-error.txt")).isEmpty())
        try {
            d.end(429)
            fail("应当抛出 RpcError")
        } catch (e: MakerSuiteWire.RpcError) {
            assertEquals(8, e.code)
            assertEquals(429, e.clientStatus())
        }
    }

    @Test
    fun midStreamErrorThrowsAfterFrames() {
        val d = MakerSuiteStream()
        val got = d.feed("[[[[[[[[,\"partial\"]],\"model\"]]]]],[13,\"Internal error encountered.\"]]")
        assertEquals(1, got.size)
        try {
            d.end(200)
            fail("应当抛出 RpcError")
        } catch (e: MakerSuiteWire.RpcError) {
            assertEquals(13, e.code)
        }
    }

    @Test
    fun numericThoughtFlag() {
        val d = MakerSuiteStream()
        val got = d.feed("[[[[[[[[null,\"**Plan**\",null,null,null,null,null,null,null,null,null,null,1]],\"model\"]]]]]]")
        assertTrue(got[0].getJSONArray("candidates").getJSONObject(0).getJSONObject("content").getJSONArray("parts").getJSONObject(0).getBoolean("thought"))
    }

    @Test
    fun maxTokensFinish() {
        val d = MakerSuiteStream()
        val got = d.feed("[[[[[[[[,\"cut\"]],\"model\"],2]],,[3,1,4]]]]")
        assertEquals("MAX_TOKENS", got[0].getJSONArray("candidates").getJSONObject(0).getString("finishReason"))
        assertEquals(1, got[0].getJSONObject("usageMetadata").getInt("candidatesTokenCount"))
        assertTrue(d.end())
    }
}
