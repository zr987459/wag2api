package com.wag2api.ag

import com.wag2api.ag.T.aEvents
import com.wag2api.ag.T.assertJson
import com.wag2api.ag.T.j
import com.wag2api.ag.T.ja
import com.wag2api.ag.T.oChunks
import com.wag2api.ag.T.sse
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** 移植自 tests/test-protocol-compat.mjs：OpenAI Chat Completions / Anthropic Messages 协议兼容回归 */
class ProtocolCompatTest {
    private val tools = "[{'name':'get_weather','description':'w','input_schema':{'type':'object','properties':{'city':{'type':'string'}}}}]"
    private val msgs = "[{'role':'user','content':'hi'}]"

    private fun request(model: String, extra: String = ""): JSONObject =
        j("{'model':'$model','messages':$msgs" + (if (extra.isEmpty()) "" else ",$extra") + "}")

    private fun genCfg(req: JSONObject): JSONObject = Cloudcode.buildCloudCodePayload(req).getJSONObject("request").getJSONObject("generationConfig")

    // ------------------------------------------------------------------ Anthropic 流式

    @Test
    fun multipleToolUseBlocksEachStopped() {
        val c = T.FakeClient()
        SseStreamer.handleStreamConversion(
            T.upstream(
                sse("{'candidates':[{'content':{'parts':[{'text':'ok'}]}}]}"),
                sse("{'candidates':[{'content':{'parts':[{'functionCall':{'name':'a','args':{'x':1}}},{'functionCall':{'name':'b','args':{}}}]}}]}"),
                sse("{'candidates':[{'content':{'parts':[{'text':'after'}]},'finishReason':'STOP'}]}")
            ), c, "m"
        )
        val ev = aEvents(c.toString())
        assertEquals(listOf(0, 1, 2, 3), ev.filter { it.first == "content_block_start" }.map { it.second.getInt("index") })
        assertEquals(listOf(0, 1, 2, 3), ev.filter { it.first == "content_block_stop" }.map { it.second.getInt("index") })
        var open: Int? = null
        for ((e, d) in ev) {
            if (e == "content_block_start") { assertNull("上一个块未关闭就开始新块", open); open = d.getInt("index") }
            if (e == "content_block_stop") { assertEquals(open, d.getInt("index")); open = null }
        }
        assertEquals("tool_use", ev.first { it.first == "message_delta" }.second.getJSONObject("delta").opt("stop_reason"))
    }

    @Test
    fun maxTokensStopReason() {
        val c = T.FakeClient()
        SseStreamer.handleStreamConversion(T.upstream(sse("{'candidates':[{'content':{'parts':[{'text':'trunc'}]},'finishReason':'MAX_TOKENS'}]}")), c, "m")
        assertEquals("max_tokens", aEvents(c.toString()).first { it.first == "message_delta" }.second.getJSONObject("delta").opt("stop_reason"))
        val m = ContentConverter.convertGoogleToAnthropic(j("{'response':{'candidates':[{'content':{'parts':[{'text':'x'}]},'finishReason':'MAX_TOKENS'}]}}"), "m")
        assertEquals("max_tokens", m.opt("stop_reason"))
        val t = ContentConverter.convertGoogleToAnthropic(j("{'response':{'candidates':[{'content':{'parts':[{'functionCall':{'name':'a','args':{}}}]},'finishReason':'MAX_TOKENS'}]}}"), "m")
        assertEquals("工具调用优先", "tool_use", t.opt("stop_reason"))
    }

    @Test
    fun upstreamErrorEmitsAnthropicErrorEvent() {
        val c = T.FakeClient()
        var fin: JSONObject? = null
        SseStreamer.handleStreamConversion(T.failingUpstream(sse("{'candidates':[{'content':{'parts':[{'text':'a'}]}}]}")), c, "m", { fin = it })
        val err = aEvents(c.toString()).firstOrNull { it.first == "error" }
        assertNotNull("必须有 event: error", err)
        assertEquals("error", err!!.second.opt("type"))
        assertEquals("api_error", err.second.getJSONObject("error").opt("type"))
        assertEquals("stream_error", fin?.opt("outcome"))
    }

    // ------------------------------------------------------------------ Anthropic 请求

    @Test
    fun toolResultArrayAndDocumentBlocks() {
        val g = ContentConverter.convertAnthropicToGoogle(
            j(
                "{'model':'claude-sonnet-4-6','messages':[" +
                    "{'role':'user','content':[{'type':'text','text':'read'},{'type':'document','source':{'type':'base64','media_type':'application/pdf','data':'JVBERi0x'}}]}," +
                    "{'role':'assistant','content':[{'type':'tool_use','id':'tu_arr_1','name':'shot','input':{}}]}," +
                    "{'role':'user','content':[{'type':'tool_result','tool_use_id':'tu_arr_1','content':[{'type':'text','text':'line1'}," +
                    "{'type':'image','source':{'type':'base64','media_type':'image/png','data':'iVBOR'}},{'type':'text','text':'line2'}]}]}]}"
            )
        )
        val contents = g.getJSONArray("contents")
        assertJson(j("{'inlineData':{'mimeType':'application/pdf','data':'JVBERi0x'}}"), contents.getJSONObject(0).getJSONArray("parts").get(1))
        val last = contents.getJSONObject(2).getJSONArray("parts")
        assertEquals("line1\nline2", last.getJSONObject(0).getJSONObject("functionResponse").getJSONObject("response").opt("output"))
        assertJson(j("{'inlineData':{'mimeType':'image/png','data':'iVBOR'}}"), last.get(1))

        val s = ContentConverter.convertAnthropicToGoogle(
            j(
                "{'model':'claude-sonnet-4-6','messages':[{'role':'assistant','content':[{'type':'tool_use','id':'tu_s','name':'f','input':{}}]}," +
                    "{'role':'user','content':[{'type':'tool_result','tool_use_id':'tu_s','content':'plain'}]}]}"
            )
        )
        // Node 版断言 contents[2]：转换时会在最前面补一条 user 消息
        val sc = s.getJSONArray("contents")
        assertEquals(3, sc.length())
        assertEquals("plain", sc.getJSONObject(sc.length() - 1).getJSONArray("parts").getJSONObject(0).getJSONObject("functionResponse").getJSONObject("response").opt("output"))
    }

    @Test
    fun toolChoiceToFunctionCallingConfig() {
        fun p(tc: String?): Any? {
            val r = request("gemini-3.8-flash-high", "'tools':$tools" + (if (tc != null) ",'tool_choice':$tc" else ""))
            return Cloudcode.buildCloudCodePayload(r).getJSONObject("request").getJSONObject("toolConfig").opt("functionCallingConfig")
        }
        assertJson(j("{'mode':'AUTO'}"), p(null))
        assertJson(j("{'mode':'AUTO'}"), p("{'type':'auto'}"))
        assertJson(j("{'mode':'NONE'}"), p("{'type':'none'}"))
        assertJson(j("{'mode':'ANY'}"), p("{'type':'any'}"))
        assertJson(j("{'allowedFunctionNames':['get_weather'],'mode':'ANY'}"), p("{'type':'tool','name':'get_weather'}"))
        val c = Cloudcode.buildCloudCodePayload(request("claude-sonnet-4-6", "'tools':$tools")).getJSONObject("request")
            .getJSONObject("toolConfig").opt("functionCallingConfig")
        assertJson(j("{'mode':'VALIDATED'}"), c, "Claude 未指定 tool_choice 时保持 VALIDATED")
    }

    @Test
    fun topPTopKStopSequences() {
        val g = genCfg(request("gemini-3.8-flash-high", "'top_p':0.9,'top_k':40,'stop_sequences':['END','','a','b','c','d','e']"))
        assertEquals(0.9, (g.opt("topP") as Number).toDouble(), 1e-9)
        assertEquals(40, (g.opt("topK") as Number).toInt())
        assertJson(ja("['END','a','b','c','d']"), g.opt("stopSequences"))
        val plain = genCfg(request("gemini-3.8-flash-high"))
        assertEquals(listOf("maxOutputTokens", "temperature", "thinkingConfig"), T.keys(plain))
        val claude = genCfg(request("claude-sonnet-4-6", "'stop_sequences':['END']"))
        assertFalse("Claude-on-AG 不下发 stopSequences", claude.has("stopSequences"))
    }

    @Test
    fun countTokensEstimate() {
        assertEquals(2L, TokenEstimate.estimateTextTokens("abcdefgh"))
        assertEquals(2L, TokenEstimate.estimateTextTokens("你好你好"))
        val body = JSONObject()
            .put("system", JSONArray().put(JSONObject().put("type", "text").put("text", "x".repeat(400))))
            .put("messages", JSONArray().put(JSONObject().put("role", "user").put("content", "y".repeat(40))))
            .put("tools", ja(tools))
        val n = TokenEstimate.estimateAnthropicInputTokens(body)
        assertTrue(n.toString(), n in 111..159)
        assertEquals(1L, TokenEstimate.estimateAnthropicInputTokens(JSONObject()))
    }

    // ------------------------------------------------------------------ OpenAI 请求

    @Test
    fun responseFormatToResponseSchema() {
        val rf = "{'type':'json_schema','json_schema':{'name':'r','schema':{'type':'object','properties':{'a':{'type':'integer'}},'required':['a']}}}"
        val g = genCfg(OpenaiAgConverter.openaiRequestToAnthropic(request("gemini-3.8-flash-high", "'response_format':$rf")))
        assertEquals("application/json", g.opt("responseMimeType"))
        assertJson(j("{'properties':{'a':{'type':'INTEGER'}},'required':['a'],'type':'OBJECT'}"), g.opt("responseSchema"))
        val jo = genCfg(OpenaiAgConverter.openaiRequestToAnthropic(request("gemini-3.8-flash-high", "'response_format':{'type':'json_object'}")))
        assertEquals("application/json", jo.opt("responseMimeType"))
        assertFalse(jo.has("responseSchema"))
        val t = genCfg(OpenaiAgConverter.openaiRequestToAnthropic(request("gemini-3.8-flash-high", "'response_format':{'type':'text'}")))
        assertFalse(t.has("responseMimeType"))
        val c = genCfg(OpenaiAgConverter.openaiRequestToAnthropic(request("claude-sonnet-4-6", "'response_format':$rf")))
        assertFalse(c.has("responseMimeType"))
    }

    @Test
    fun stopAndToolChoiceVariants() {
        val fnTools = "[{'type':'function','function':{'name':'f','parameters':{'type':'object','properties':{'q':{'type':'string'}}}}}]"
        val ant = OpenaiAgConverter.openaiRequestToAnthropic(
            request("gemini-3.8-flash-high", "'stop':'STOP!','tools':$fnTools,'tool_choice':{'type':'function','function':{'name':'f'}}")
        )
        val r = Cloudcode.buildCloudCodePayload(ant).getJSONObject("request")
        assertJson(ja("['STOP!']"), r.getJSONObject("generationConfig").opt("stopSequences"))
        assertJson(j("{'allowedFunctionNames':['f'],'mode':'ANY'}"), r.getJSONObject("toolConfig").opt("functionCallingConfig"))
        val flat = OpenaiAgConverter.openaiRequestToAnthropic(
            request("m", "'tools':[{'type':'function','function':{'name':'f'}}],'tool_choice':{'type':'function','name':'f'}")
        )
        assertJson(j("{'type':'tool','name':'f'}"), flat.opt("tool_choice"))
        val req = Cloudcode.buildCloudCodePayload(
            OpenaiAgConverter.openaiRequestToAnthropic(request("gemini-3.8-flash-high", "'tools':[{'type':'function','function':{'name':'f'}}],'tool_choice':'required'"))
        ).getJSONObject("request")
        assertJson(j("{'mode':'ANY'}"), req.getJSONObject("toolConfig").opt("functionCallingConfig"))
    }

    @Test
    fun reasoningEffortNoneAndMinimal() {
        assertFalse(OpenaiAgConverter.openaiRequestToAnthropic(request("m", "'reasoning_effort':'none'")).has("thinking"))
        val mi = OpenaiAgConverter.openaiRequestToAnthropic(request("gemini-3.8-flash", "'reasoning_effort':'minimal'"))
        assertEquals(1024, (mi.getJSONObject("thinking").opt("budget_tokens") as Number).toInt())
        assertEquals("low", genCfg(mi).getJSONObject("thinkingConfig").opt("thinkingLevel"))
        assertEquals(8192, (OpenaiAgConverter.openaiRequestToAnthropic(request("m", "'reasoning_effort':'medium'")).getJSONObject("thinking").opt("budget_tokens") as Number).toInt())
    }

    @Test
    fun toolMessageSegmentsDataUriAndFileBlock() {
        val ant = OpenaiAgConverter.openaiRequestToAnthropic(
            j(
                "{'model':'gemini-3.8-flash-high','messages':[" +
                    "{'role':'user','content':[{'type':'text','text':'see'}," +
                    "{'type':'image_url','image_url':{'url':'data:image/png;name=a.png;base64,iVBOR'}}," +
                    "{'type':'file','file':{'filename':'a.pdf','file_data':'data:application/pdf;base64,JVBERi0x'}}]}," +
                    "{'role':'assistant','content':null,'tool_calls':[{'id':'call_seg','type':'function','function':{'name':'f','arguments':'{}'}}]}," +
                    "{'role':'tool','tool_call_id':'call_seg','content':[{'type':'text','text':'r1'},{'type':'text','text':'r2'}]}]}"
            )
        )
        val m = ant.getJSONArray("messages")
        assertJson(j("{'type':'image','source':{'type':'base64','media_type':'image/png','data':'iVBOR'}}"), m.getJSONObject(0).getJSONArray("content").get(1))
        assertEquals("document", m.getJSONObject(0).getJSONArray("content").getJSONObject(2).opt("type"))
        assertEquals("r1\nr2", m.getJSONObject(2).getJSONArray("content").getJSONObject(0).opt("content"))
        val g = ContentConverter.convertAnthropicToGoogle(ant)
        assertJson(j("{'inlineData':{'mimeType':'application/pdf','data':'JVBERi0x'}}"), g.getJSONArray("contents").getJSONObject(0).getJSONArray("parts").get(2))
    }

    // ------------------------------------------------------------------ OpenAI 响应

    private val usageMeta = "{'promptTokenCount':100,'cachedContentTokenCount':40,'candidatesTokenCount':10,'thoughtsTokenCount':5}"

    @Test
    fun usageNoDoubleCountReasoning() {
        val r = OpenaiAgConverter.convertGoogleToOpenAI(j("{'response':{'candidates':[{'content':{'parts':[{'text':'x'}]},'finishReason':'STOP'}],'usageMetadata':$usageMeta}}"), "m")
        assertJson(
            j("{'prompt_tokens':100,'completion_tokens':15,'total_tokens':115,'prompt_tokens_details':{'cached_tokens':40},'completion_tokens_details':{'reasoning_tokens':5}}"),
            r.opt("usage")
        )
    }

    @Test
    fun safetyRecitationToContentFilter() {
        val r = OpenaiAgConverter.convertGoogleToOpenAI(j("{'response':{'candidates':[{'content':{'parts':[{'text':'x'}]},'finishReason':'SAFETY'}]}}"), "m")
        assertEquals("content_filter", r.getJSONArray("choices").getJSONObject(0).opt("finish_reason"))
        val c = T.FakeClient()
        OpenaiAgConverter.handleOpenAIStreamConversion(T.upstream(sse("{'candidates':[{'content':{'parts':[{'text':'x'}]},'finishReason':'RECITATION'}]}")), c, "m")
        assertTrue(oChunks(c.toString()).any { (it.getJSONArray("choices").optJSONObject(0))?.opt("finish_reason") == "content_filter" })
    }

    @Test
    fun streamOptionsIncludeUsage() {
        val frame = sse("{'candidates':[{'content':{'parts':[{'text':'hi'}]},'finishReason':'STOP'}],'usageMetadata':$usageMeta}")
        val a = T.FakeClient()
        OpenaiAgConverter.handleOpenAIStreamConversion(T.upstream(frame), a, "m", null, System.currentTimeMillis(), null, true)
        val u = oChunks(a.toString()).first { it.optJSONArray("choices")?.length() == 0 }
        assertEquals(15, u.getJSONObject("usage").getInt("completion_tokens"))
        assertTrue(a.toString().trim().endsWith("data: [DONE]"))

        val b = T.FakeClient()
        OpenaiAgConverter.handleOpenAIStreamConversion(T.upstream(frame), b, "m", null, System.currentTimeMillis(), null, false)
        val cb = oChunks(b.toString())
        assertTrue("不应出现 choices:[] 帧", cb.all { it.getJSONArray("choices").length() == 1 })
        val fin = cb.first { it.getJSONArray("choices").getJSONObject(0).opt("finish_reason") == "stop" }
        assertEquals(115, fin.getJSONObject("usage").getInt("total_tokens"))
        assertEquals("首帧为 role", "assistant", cb[0].getJSONArray("choices").getJSONObject(0).getJSONObject("delta").opt("role"))
        assertTrue(b.toString().trim().endsWith("data: [DONE]"))
    }

    // ------------------------------------------------------------------ Schema 清洗

    @Test
    fun schemaAnyOfTypeArrayRefAllOf() {
        val s = SchemaSanitizer.sanitizeSchema(
            j(
                "{'type':'object','\$defs':{'Loc':{'type':'object','properties':{'city':{'type':'string'}},'required':['city']}," +
                    "'Node':{'type':'object','properties':{'next':{'\$ref':'#/\$defs/Node'}}}}," +
                    "'properties':{'name':{'anyOf':[{'type':'string'},{'type':'null'}],'description':'opt'}," +
                    "'age':{'type':['integer','null']},'loc':{'\$ref':'#/\$defs/Loc'}," +
                    "'both':{'allOf':[{'type':'object','properties':{'a':{'type':'string'}}},{'properties':{'b':{'type':'number'}},'required':['b']}]}," +
                    "'tree':{'\$ref':'#/\$defs/Node'},'bad':{'\$ref':'#/\$defs/Missing'}}}"
            )
        )
        val p = s.getJSONObject("properties")
        assertJson(j("{'type':'STRING','description':'opt'}"), p.get("name"))
        assertJson(j("{'type':'INTEGER'}"), p.get("age"))
        assertJson(j("{'type':'OBJECT','properties':{'city':{'type':'STRING'}},'required':['city']}"), p.get("loc"))
        assertEquals("OBJECT", p.getJSONObject("both").opt("type"))
        // Node 版断言属性顺序为 [a, b]（JSONObject 不保序，这里比较集合）
        assertEquals(listOf("a", "b"), T.keys(p.getJSONObject("both").getJSONObject("properties")))
        assertJson(ja("['b']"), p.getJSONObject("both").opt("required"))
        assertEquals("循环引用降级为 object，不爆栈", "OBJECT", p.getJSONObject("tree").getJSONObject("properties").getJSONObject("next").opt("type"))
        assertEquals("STRING", p.getJSONObject("bad").opt("type"))
        val plain = j("{'type':'object','properties':{'q':{'type':'string','description':'d','format':'uri'},'n':{'type':'array','items':{'type':'number'}}},'required':['q']}")
        assertJson(
            j("{'type':'OBJECT','properties':{'n':{'type':'ARRAY','items':{'type':'NUMBER'}},'q':{'type':'STRING','description':'d'}},'required':['q']}"),
            SchemaSanitizer.sanitizeSchema(plain)
        )
    }
}
