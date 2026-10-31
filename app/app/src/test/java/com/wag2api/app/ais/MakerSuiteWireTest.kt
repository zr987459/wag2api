package com.wag2api.app.ais

import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class MakerSuiteWireTest {

    private fun fixture(name: String): String =
        javaClass.getResourceAsStream("/ais/$name")!!.readBytes().toString(Charsets.UTF_8)

    /** ContentConverter.convertAnthropicToGoogle 的输出形状 */
    private fun googleRequest(): JSONObject = JSONObject(
        """
        {"contents":[
          {"role":"user","parts":[{"text":"天气怎么样？"},{"inlineData":{"mimeType":"image/png","data":"AAAA"}}]},
          {"role":"model","parts":[{"thought":true,"text":"想一下","thoughtSignature":"Ep4D"},{"functionCall":{"name":"get_weather","args":{"city":"Paris","days":3}}}]},
          {"role":"user","parts":[{"functionResponse":{"name":"get_weather","response":{"output":"晴"}}}]},
          {"role":"user","parts":[{"text":"那明天呢"}]}
        ],
        "systemInstruction":{"role":"user","parts":[{"text":"你是天气助手"}]},
        "tools":[{"functionDeclarations":[{"name":"get_weather","description":"查天气","parameters":{"type":"OBJECT","properties":{"city":{"type":"STRING","description":"城市"},"days":{"type":"INTEGER"}},"required":["city"]}}]}]}
        """.trimIndent()
    )

    @Test
    fun buildsGenerateContentBody() {
        val anth = JSONObject().put("model", "gemini-3.8-flash").put("max_tokens", 1024).put("temperature", 0.2)
            .put("stop_sequences", JSONArray().put("END")).put("reasoning_effort", "low")
        val models = MakerSuiteWire.parseModels(fixture("list-models.txt"))
        val info = models.first { it.id == "gemini-3.8-flash" }
        val wire = MakerSuiteWire.buildGenerateContent("gemini-3.8-flash", googleRequest(), anth, info, "Asia/Shanghai")

        assertEquals("models/gemini-3.8-flash", wire.getString(0))
        val contents = wire.getJSONArray(1)
        assertEquals(4, contents.length())
        // 第 1 轮：文本 + inline data
        val u0 = contents.getJSONArray(0)
        assertEquals("user", u0.getString(1))
        assertEquals("天气怎么样？", u0.getJSONArray(0).getJSONArray(0).getString(1))
        assertEquals("image/png", u0.getJSONArray(0).getJSONArray(1).getJSONArray(2).getString(0))
        // 模型轮：思考摘要不回传；函数调用在下标 10，签名（AG 兜底签名以外的才保留）在下标 14
        val m1 = contents.getJSONArray(1)
        assertEquals("model", m1.getString(1))
        assertEquals(1, m1.getJSONArray(0).length())
        val call = m1.getJSONArray(0).getJSONArray(0)
        assertEquals("get_weather", call.getJSONArray(10).getString(0))
        assertEquals(JSONObject().put("city", "Paris").put("days", 3).toString(), MakerSuiteWire.decodeStruct(call.getJSONArray(10).get(1)).toString())
        assertEquals(MakerSuiteWire.SKIP_SIGNATURE, call.getString(14))
        // 函数结果在下标 11，role 为 user
        val r = contents.getJSONArray(2).getJSONArray(0).getJSONArray(0).getJSONArray(11)
        assertEquals("get_weather", r.getString(0))
        assertEquals("晴", MakerSuiteWire.decodeStruct(r.get(1)).getString("output"))

        // 安全设置 4 项 OFF
        assertEquals("[[null,null,7,5],[null,null,8,5],[null,null,9,5],[null,null,10,5]]", wire.getJSONArray(2).toString())
        // 生成配置
        val cfg = wire.getJSONArray(3)
        assertEquals("[\"END\"]", cfg.getJSONArray(1).toString())
        assertEquals(1024L, cfg.getLong(3))
        assertEquals(0.2, cfg.getDouble(4), 1e-9)
        assertEquals(0.95, cfg.getDouble(5), 1e-9) // 目录默认 topP
        assertEquals(64L, cfg.getLong(6))
        assertEquals(1, cfg.getInt(13))
        assertEquals("[1,null,null,1]", cfg.getJSONArray(16).toString()) // reasoning_effort=low → level 1
        // proof 位先空着
        assertTrue(wire.isNull(MakerSuiteWire.PROOF_INDEX))
        // system
        assertEquals("[[[null,\"你是天气助手\"]],\"user\"]", wire.getJSONArray(5).toString())
        // 工具：[null,[[name,desc,schema]]]，schema type 码 OBJECT=6，属性按名字排序
        val decl = wire.getJSONArray(6).getJSONArray(0).getJSONArray(1).getJSONArray(0)
        assertEquals("get_weather", decl.getString(0))
        val schema = decl.getJSONArray(2)
        assertEquals(6, schema.getInt(0))
        assertEquals("city", schema.getJSONArray(6).getJSONArray(0).getString(0))
        assertEquals(1, schema.getJSONArray(6).getJSONArray(0).getJSONArray(1).getInt(0))
        assertEquals(3, schema.getJSONArray(6).getJSONArray(1).getJSONArray(1).getInt(0))
        assertEquals("[\"city\"]", schema.getJSONArray(7).toString())
        assertEquals(1, wire.getInt(10))
        assertEquals("[[null,null,\"Asia/Shanghai\"]]", wire.getJSONArray(13).toString())

        // binding prompt：所有 Part（文本、inline base64、其他为空串）以空格连接；页面提示词只取最后一轮文本
        assertEquals("天气怎么样？ AAAA   那明天呢", MakerSuiteWire.bindingPrompt(contents))
        assertEquals("那明天呢", MakerSuiteWire.pagePrompt(contents))
        assertEquals("b94d27b9934d3e08a52e52d7da7dabfac484efe37a5380ee9088f7ace2efcde9", MakerSuiteWire.sha256Hex("hello world"))

        val body = MakerSuiteWire.withProof(wire, "!proof")
        assertEquals("!proof", JSONArray(body).getString(4))
    }

    @Test
    fun plainChatHasNoToolSlots() {
        val g = JSONObject().put("contents", JSONArray().put(JSONObject().put("role", "user").put("parts", JSONArray().put(JSONObject().put("text", "hi")))))
        val wire = MakerSuiteWire.buildGenerateContent("gemini-2.5-pro", g, JSONObject().put("model", "gemini-2.5-pro"), null, null)
        assertEquals(11, wire.length())
        assertTrue(wire.isNull(5))
        assertTrue(wire.isNull(6))
        val cfg = wire.getJSONArray(3)
        assertEquals(65536L, cfg.getLong(3)) // 目录未知时的默认上限
        assertEquals("[1]", cfg.getJSONArray(16).toString()) // 2.5 系按名字推断支持思考
    }

    @Test
    fun structRoundTrip() {
        val o = JSONObject("""{"b":true,"a":[1,"x",null,{"n":2.5}],"s":"t","z":{}}""")
        val enc = MakerSuiteWire.encodeStruct(o)
        // key 排序
        assertEquals("a", enc.getJSONArray(0).getJSONArray(0).getString(0))
        val dec = MakerSuiteWire.decodeStruct(JSONArray(enc.toString()))
        assertEquals(true, dec.getBoolean("b"))
        assertEquals("x", dec.getJSONArray("a").getString(1))
        assertTrue(dec.getJSONArray("a").isNull(2))
        assertEquals(2.5, dec.getJSONArray("a").getJSONObject(3).getDouble("n"), 0.0)
        assertEquals(0, dec.getJSONObject("z").length())
    }

    @Test
    fun normalizesSparseArrays() {
        assertEquals("[null,1]", MakerSuiteWire.normalizeSparse("[,1]"))
        assertEquals("[1,null,null,2,null]", MakerSuiteWire.normalizeSparse("[1,,,2,]"))
        assertEquals("[\"a,,b\",null,[null,null]]", MakerSuiteWire.normalizeSparse("[\"a,,b\",,[,]]"))
        assertEquals("[\"a\\\",,\"]", MakerSuiteWire.normalizeSparse("[\"a\\\",,\"]"))
    }

    @Test
    fun parsesModelCatalog() {
        val models = MakerSuiteWire.parseModels(fixture("list-models.txt"))
        assertEquals(listOf("gemini-3.8-flash", "gemini-2.5-pro"), models.map { it.id }) // embedding 模型被过滤
        val m = models[0]
        assertEquals("Gemini 3.8 Flash", m.displayName)
        assertEquals(1048576L, m.inputLimit)
        assertEquals(65536L, m.outputLimit)
        assertTrue(m.thinking && m.thinkingLevel && m.functions)
        assertFalse(m.thinkingBudget)
        assertEquals(3L, m.defaultThinkingLevel)
        assertEquals("gemini-3.8-flash", m.toOpenAI().getString("id"))
    }

    @Test
    fun decodesRpcErrors() {
        val e = MakerSuiteWire.decodeError(429, fixture("generate-error.txt"))
        assertEquals(8, e.code)
        assertEquals(429, e.clientStatus())
        assertTrue(e.message.contains("exhausted"))
        assertEquals(403, MakerSuiteWire.decodeError(403, "[7,\"The caller does not have permission\"]").clientStatus())
        assertEquals(502, MakerSuiteWire.decodeError(500, "<html>oops</html>").clientStatus())
    }
}
