package com.wag2api.ag

import com.wag2api.ag.T.aEvents
import com.wag2api.ag.T.assertJson
import com.wag2api.ag.T.j
import com.wag2api.ag.T.sse
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** 移植自 tests/test-usage.mjs（usage 口径 + 流式/非流式记账部分；StatsTracker 部分 Kotlin 版已按合同第 6 条重写，不在此覆盖） */
class UsageStreamTest {
    private val meta1 = "{'promptTokenCount':1000,'cachedContentTokenCount':600,'toolUsePromptTokenCount':40}"
    private val meta2 = "{'promptTokenCount':1000,'cachedContentTokenCount':600,'toolUsePromptTokenCount':40,'candidatesTokenCount':50,'thoughtsTokenCount':300}"
    private val meta3 = "{'promptTokenCount':1000,'cachedContentTokenCount':600,'toolUsePromptTokenCount':40,'candidatesTokenCount':120,'thoughtsTokenCount':300,'totalTokenCount':1460}"
    private val stream = arrayOf(
        sse("{'candidates':[{'content':{'parts':[{'text':'thinking…','thought':true}]}}],'usageMetadata':$meta1}"),
        sse("{'candidates':[{'content':{'parts':[{'text':'Hello'}]}}],'usageMetadata':$meta2}"),
        sse("{'candidates':[{'content':{'parts':[{'text':' world'}]},'finishReason':'STOP'}],'usageMetadata':$meta3}")
    )
    private val exp = j("{'input_tokens':440,'cached_tokens':600,'output_tokens':420,'thoughts_tokens':300,'total_tokens':1460}")

    @Test
    fun normalizeGeminiUsage() {
        assertJson(exp, Usage.normalizeGeminiUsage(j("{'promptTokenCount':1000,'cachedContentTokenCount':600,'toolUsePromptTokenCount':40,'candidatesTokenCount':120,'thoughtsTokenCount':300}")))
        assertJson(j("{'input_tokens':0,'cached_tokens':0,'output_tokens':0,'thoughts_tokens':0,'total_tokens':0}"), Usage.normalizeGeminiUsage(null))
        assertEquals("cached > prompt 时 input 不为负", 0L, (Usage.normalizeGeminiUsage(j("{'promptTokenCount':10,'cachedContentTokenCount':50}")).opt("input_tokens") as Number).toLong())
    }

    @Test
    fun cacheHitRate() {
        assertNull(Usage.cacheHitRate(0, 0))
        assertEquals(0.8, Usage.cacheHitRate(50, 200)!!, 1e-9)
    }

    @Test
    fun streamUsageFinalValueAndOnFinishOnce() {
        val c = T.FakeClient()
        val calls = mutableListOf<JSONObject>()
        SseStreamer.handleStreamConversion(T.upstream(*stream), c, "gemini-x", { calls.add(it) }, System.currentTimeMillis())
        assertEquals("onFinish 恰好一次", 1, calls.size)
        val u = calls[0]
        for (k in exp.keys()) assertEquals(k, (exp.get(k) as Number).toLong(), (u.get(k) as Number).toLong())
        assertEquals("ok", u.opt("outcome"))
        assertTrue((u.opt("ttft_ms") as Number).toLong() >= 0)
        val ev = aEvents(c.toString())
        assertJson(
            j("{'input_tokens':440,'output_tokens':420,'cache_read_input_tokens':600,'cache_creation_input_tokens':0}"),
            ev.first { it.first == "message_delta" }.second.opt("usage")
        )
        val start = ev.first { it.first == "message_start" }.second.getJSONObject("message").getJSONObject("usage")
        assertEquals(440, start.getInt("input_tokens"))
        assertEquals(600, start.getInt("cache_read_input_tokens"))
        assertEquals("message_stop", ev.last().first)
        assertEquals("text/event-stream; charset=utf-8", c.headers["Content-Type"])
    }

    @Test
    fun clientAbortStopsReadingAndRecordsReceivedUsage() {
        // 前两帧送达，写第 3 次（第二帧的 text delta 之后）时客户端断开
        val up = T.TrackedUpstream(*stream)
        val calls = mutableListOf<JSONObject>()
        val c = T.FakeClient(failAfterWrites = 3)
        SseStreamer.handleStreamConversion(up, c, "gemini-x", { calls.add(it) })
        assertEquals(1, calls.size)
        assertEquals("client_abort", calls[0].opt("outcome"))
        assertTrue("断开后必须关闭上游", up.closed)
        assertFalse(c.toString().contains("message_stop"))
    }

    @Test
    fun emptyUpstreamStillEmitsFullSequence() {
        val c = T.FakeClient()
        val calls = mutableListOf<JSONObject>()
        SseStreamer.handleStreamConversion(T.upstream(), c, "m", { calls.add(it) })
        assertEquals(listOf("message_start", "message_delta", "message_stop"), aEvents(c.toString()).map { it.first })
        assertEquals("output 不再伪造为 1", 0L, (calls[0].opt("output_tokens") as Number).toLong())
    }

    @Test
    fun nonStreamUsageMatchesStreamAndGwUsageNotSerialized() {
        val msg = ContentConverter.convertGoogleToAnthropic(
            j("{'response':{'candidates':[{'content':{'parts':[{'text':'hi'}]}}],'usageMetadata':{'promptTokenCount':1000,'cachedContentTokenCount':600,'toolUsePromptTokenCount':40,'candidatesTokenCount':120,'thoughtsTokenCount':300}}}"),
            "m"
        )
        assertJson(j("{'input_tokens':440,'output_tokens':420,'cache_read_input_tokens':600,'cache_creation_input_tokens':0}"), msg.opt("usage"))
        assertJson(exp, Usage.gwUsage(msg))
        assertFalse("_gw_usage 不应序列化给客户端", msg.toString().contains("_gw_usage"))
    }

    @Test
    fun parseLineSemantics() {
        assertNull(SseStreamer.parseLine(""))
        assertNull(SseStreamer.parseLine("data: [DONE]"))
        assertNull(SseStreamer.parseLine("data: not json"))
        assertNull(SseStreamer.parseLine(": keep-alive"))
        assertEquals("x", SseStreamer.parseLine("data: {\"response\":{\"a\":\"x\"}}")!!.opt("a"))
        assertEquals("没有 response 包一层时返回 chunk 本身", "y", SseStreamer.parseLine("  data:{\"a\":\"y\"}  ")!!.opt("a"))
    }

    @Test
    fun lastLineWithoutNewlineIsDropped() {
        // 与 Node 版一致：EOF 时没有换行结尾的残行丢弃
        val c = T.FakeClient()
        SseStreamer.handleStreamConversion(
            T.upstream(sse("{'candidates':[{'content':{'parts':[{'text':'A'}]}}]}"), "data: {\"response\":{\"candidates\":[{\"content\":{\"parts\":[{\"text\":\"B\"}]}}]}}"),
            c, "m"
        )
        assertTrue(c.toString().contains("\"A\""))
        assertFalse(c.toString().contains("\"B\""))
    }
}
