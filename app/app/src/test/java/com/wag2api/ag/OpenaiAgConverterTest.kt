package com.wag2api.ag

import com.wag2api.ag.T.assertContains
import com.wag2api.ag.T.assertJson
import com.wag2api.ag.T.j
import com.wag2api.ag.T.ja
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** 移植自 tests/test-openai-ag.mjs：OpenAI ⇄ AG 请求/响应/流式转换 */
class OpenaiAgConverterTest {

    @Test
    fun requestToAnthropic() {
        val schema = j("{'type':'json_schema','json_schema':{'name':'test','schema':{'type':'object'}}}")
        val oai = j(
            "{'model':'gemini-3.8-flash-high','messages':[" +
                "{'role':'system','content':'You are a helpful assistant.'}," +
                "{'role':'developer','content':'Always speak politely.'}," +
                "{'role':'user','content':'Hello'}," +
                "{'role':'assistant','content':'Hi there!','reasoning_content':'Let me think about how to greet.'}," +
                "{'role':'user','content':'What is 1+1?'}]," +
                "'max_tokens':4096,'temperature':0.7,'reasoning_effort':'high'," +
                "'tools':[{'type':'function','function':{'name':'get_weather','description':'Get weather in city'," +
                "'parameters':{'type':'object','properties':{'city':{'type':'string'}},'required':['city']}}}]}"
        ).put("response_format", schema)

        val ant = OpenaiAgConverter.openaiRequestToAnthropic(oai)
        assertEquals("gemini-3.8-flash-high", ant.opt("model"))
        assertEquals("You are a helpful assistant.\n\nAlways speak politely.", ant.opt("system"))
        assertEquals(3, ant.getJSONArray("messages").length())
        assertEquals("enabled", ant.getJSONObject("thinking").opt("type"))
        assertEquals(24576, (ant.getJSONObject("thinking").opt("budget_tokens") as Number).toInt())
        assertJson(schema, ant.opt("response_format"), "response_format 必须透传")

        val asst = ant.getJSONArray("messages").getJSONObject(1)
        assertEquals("assistant", asst.opt("role"))
        val blocks = asst.getJSONArray("content")
        for (i in 0 until blocks.length()) assertFalse("历史 reasoning_content 不应生成 thinking 块", blocks.getJSONObject(i).opt("type") == "thinking")
        val text = (0 until blocks.length()).map { blocks.getJSONObject(it) }.first { it.opt("type") == "text" }
        assertEquals("Hi there!", text.opt("text"))

        val tools = ant.getJSONArray("tools")
        assertEquals(1, tools.length())
        assertEquals("get_weather", tools.getJSONObject(0).opt("name"))
        assertJson(ja("['city']"), tools.getJSONObject(0).getJSONObject("input_schema").opt("required"), "required 必须保留")
    }

    @Test
    fun nonStreamGoogleToOpenAI() {
        val g = j(
            "{'response':{'candidates':[{'content':{'parts':[" +
                "{'text':'Analyzing math question...','thought':true,'thoughtSignature':'NON_STREAM_SIG_888'}," +
                "{'text':'1 + 1 equals 2.'}," +
                "{'functionCall':{'id':'call_calc_nonstream','name':'calculate','args':{'expr':'1+1'}}}],'role':'model'},'finishReason':'STOP'}]," +
                "'usageMetadata':{'promptTokenCount':15,'candidatesTokenCount':8,'totalTokenCount':23,'thoughtsTokenCount':4}}}"
        )
        val r = OpenaiAgConverter.convertGoogleToOpenAI(g, "gemini-3.8-flash-high")
        assertEquals("chat.completion", r.opt("object"))
        assertEquals("gemini-3.8-flash-high", r.opt("model"))
        val ch = r.getJSONArray("choices").getJSONObject(0)
        assertEquals("tool_calls", ch.opt("finish_reason"))
        assertEquals("1 + 1 equals 2.", ch.getJSONObject("message").opt("content"))
        assertEquals("Analyzing math question...", ch.getJSONObject("message").opt("reasoning_content"))
        assertEquals(4, (r.getJSONObject("usage").getJSONObject("completion_tokens_details").opt("reasoning_tokens") as Number).toInt())
        assertEquals("非流式工具调用必须继承前序 thoughtSignature", "NON_STREAM_SIG_888", SignatureCache.signatureCache.get("call_calc_nonstream"))
    }

    @Test
    fun streamWithMaxTokensMapsToLength() {
        val up = T.upstream(
            T.sse("{'candidates':[{'content':{'parts':[{'text':'Think step 1...','thought':true}]}}]}"),
            T.sse("{'candidates':[{'content':{'parts':[{'text':'The answer is 42.'}]}}]}"),
            T.sse("{'candidates':[{'finishReason':'MAX_TOKENS'}],'usageMetadata':{'promptTokenCount':10,'candidatesTokenCount':12,'thoughtsTokenCount':6}}")
        )
        val client = T.FakeClient()
        var fin: JSONObject? = null
        OpenaiAgConverter.handleOpenAIStreamConversion(up, client, "gemini-3.8-flash-high", { fin = it }, System.currentTimeMillis())
        val out = client.toString()
        assertContains(out, "chat.completion.chunk")
        assertContains(out, "reasoning_content")
        assertContains(out, "Think step 1...")
        assertContains(out, "The answer is 42.")
        assertContains(out, "\"finish_reason\":\"length\"", "MAX_TOKENS 必须映射为 length")
        assertContains(out, "data: [DONE]")
        assertEquals("ok", fin?.opt("outcome"))
        assertEquals(6, (fin!!.opt("thoughts_tokens") as Number).toInt())
    }

    @Test
    fun streamToolCallInheritsRealSignature() {
        val up = T.upstream(
            T.sse("{'candidates':[{'content':{'parts':[{'text':'Looking up weather...','thought':true,'thoughtSignature':'REAL_THOUGHT_SIGNATURE_999'}]}}]}"),
            T.sse("{'candidates':[{'content':{'parts':[{'functionCall':{'id':'call_weather_1','name':'get_weather','args':{'city':'Tokyo'}}}]}}]}"),
            T.sse("{'candidates':[{'finishReason':'STOP'}]}")
        )
        var fin: JSONObject? = null
        OpenaiAgConverter.handleOpenAIStreamConversion(up, T.FakeClient(), "test-model", { fin = it })
        assertEquals("ok", fin?.opt("outcome"))
        assertEquals("functionCall 必须继承前序 thought 的真实签名", "REAL_THOUGHT_SIGNATURE_999", SignatureCache.signatureCache.get("call_weather_1"))
    }

    @Test
    fun clientAbortRecordsClientAbortAndCancelsUpstream() {
        val up = T.TrackedUpstream(
            T.sse("{'candidates':[{'content':{'parts':[{'text':'chunk 1'}]}}]}"),
            T.sse("{'candidates':[{'content':{'parts':[{'text':'chunk 2'}]}}]}"),
            T.sse("{'candidates':[{'finishReason':'STOP'}]}")
        )
        val client = T.FakeClient(failAfterWrites = 0) // 第一次写就发现客户端已断开
        var fin: JSONObject? = null
        OpenaiAgConverter.handleOpenAIStreamConversion(up, client, "test-model", { fin = it })
        assertNotNull(fin)
        assertEquals("客户端断开必须记为 client_abort", "client_abort", fin!!.opt("outcome"))
        assertTrue("客户端断开必须关闭上游", up.closed)
        assertFalse("客户端断开不应再写 [DONE]", client.toString().contains("[DONE]"))
    }
}
