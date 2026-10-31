package com.wag2api.ag

import com.wag2api.ag.T.assertJson
import com.wag2api.ag.T.j
import com.wag2api.ag.T.ja
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** 移植自 tests/test-converter.mjs：Schema 清洗、身份脱敏、签名回填、functionResponse、思考档位 */
class ConverterTest {

    private fun rawSchema(): JSONObject = j(
        "{'type':'object','\$schema':'http://json-schema.org/draft-07/schema#'," +
            "'properties':{'command':{'type':'string','description':'Bash command'},'mode':{'const':'fast'}," +
            "'nested':{'type':'object','properties':{'flag':{'type':'boolean'}}}},'required':['command']}"
    )

    @Test
    fun schemaWhitelistAndUppercaseTypes() {
        val cleaned = SchemaSanitizer.sanitizeSchema(rawSchema())
        assertEquals("OBJECT", cleaned.opt("type"))
        assertFalse("\$schema 必须被剔除", cleaned.has("\$schema"))
        assertJson(ja("['fast']"), cleaned.getJSONObject("properties").getJSONObject("mode").opt("enum"), "const 必须转换为 enum")
        assertEquals("OBJECT", cleaned.getJSONObject("properties").getJSONObject("nested").opt("type"))
    }

    @Test
    fun scrubIdentity() {
        val s = Scrub.scrubIdentity("You are Claude Code developed by Anthropic. Team: Hermes Agent.")
        assertFalse(s.contains("Claude Code"))
        assertFalse(s.contains("Hermes Agent"))
    }

    @Test
    fun thoughtSignatureInjectedAndSingleOutput() {
        SignatureCache.signatureCache.set("call_test_123", "SIG_GOOGLE_CIPHER_ABC")
        val req = JSONObject()
            .put("model", "gemini-3.8-flash-high")
            .put("system", "You are an engineer.")
            .put(
                "messages", ja(
                    "[{'role':'user','content':'Run ls'}," +
                        "{'role':'assistant','content':[{'type':'tool_use','id':'call_test_123','name':'bash','input':{'command':'ls'}}]}]"
                ).put(
                    JSONObject().put("role", "user").put(
                        "content", org.json.JSONArray().put(
                            JSONObject().put("type", "tool_result").put("tool_use_id", "call_test_123").put("content", "file1.txt\nfile2.txt")
                        )
                    )
                )
            )
            .put("tools", org.json.JSONArray().put(JSONObject().put("name", "bash").put("description", "Run bash").put("input_schema", rawSchema())))

        val g = ContentConverter.convertAnthropicToGoogle(req)
        val contents = g.getJSONArray("contents")
        assertEquals(3, contents.length())
        val toolUse = contents.getJSONObject(1).getJSONArray("parts").getJSONObject(0)
        assertEquals("思考签名必须被自动缝合在 assistant tool_use", "SIG_GOOGLE_CIPHER_ABC", toolUse.opt("thoughtSignature"))

        val fr = contents.getJSONObject(2).getJSONArray("parts").getJSONObject(0).optJSONObject("functionResponse")
        assertNotNull("必须存在 functionResponse", fr)
        assertEquals("file1.txt\nfile2.txt", fr!!.getJSONObject("response").opt("output"))
        assertFalse("冗余的 content 必须已被剔除", fr.getJSONObject("response").has("content"))
    }

    private fun thinkingLevel(req: JSONObject): Any? =
        Cloudcode.buildCloudCodePayload(req).getJSONObject("request").getJSONObject("generationConfig")
            .getJSONObject("thinkingConfig").opt("thinkingLevel")

    @Test
    fun thinkingTiers() {
        val hi = "[{'role':'user','content':'hi'}]"
        // Flash 默认无后缀 -> low + budget 0
        val flash = Cloudcode.buildCloudCodePayload(j("{'model':'gemini-3.8-flash','messages':$hi}"))
        val tc = flash.getJSONObject("request").getJSONObject("generationConfig").getJSONObject("thinkingConfig")
        assertEquals("low", tc.opt("thinkingLevel"))
        assertEquals(0, (tc.opt("thinkingBudget") as Number).toInt())
        // Flash + budget_tokens=24000 -> high
        assertEquals("high", thinkingLevel(j("{'model':'gemini-3.8-flash','thinking':{'type':'enabled','budget_tokens':24000},'messages':$hi}")))
        // OpenAI reasoning_effort 三档
        for ((effort, level) in listOf("low" to "low", "medium" to "medium", "high" to "high")) {
            val conv = OpenaiAgConverter.openaiRequestToAnthropic(j("{'model':'gemini-3.8-flash-tiered','messages':$hi,'reasoning_effort':'$effort'}"))
            assertEquals("reasoning_effort=$effort", level, thinkingLevel(conv))
        }
        // Pro 默认 -> high
        assertEquals("high", thinkingLevel(j("{'model':'gemini-3.1-pro','messages':$hi}")))
        assertTrue(true)
    }
}
