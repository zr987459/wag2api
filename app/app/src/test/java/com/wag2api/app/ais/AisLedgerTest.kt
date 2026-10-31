package com.wag2api.app.ais

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File
import java.nio.file.Files

/** [beta] 账号卡片字段写回/持久化、请求账本汇总字段（对齐控制台 app.js 读取的名字） */
class AisLedgerTest {

    private fun tmpDir(): File = Files.createTempDirectory("ais-ledger").toFile()

    @Test
    fun refreshWritesModelsTierAndTimeAndSurvivesReload() {
        val dir = tmpDir()
        AisAccountInfo.update(dir) { it.put("label", "a").put("enabled", true) }
        var ch: AisAccountInfo.Change? = null
        AisAccountInfo.update(dir) { ch = AisAccountInfo.applyRefresh(it, listOf("gemini-2.5-flash", "gemini-2.5-pro"), 1_700_000_000_000L, "x@example.com") }
        assertEquals(0, ch!!.previousModels)
        assertEquals(2, ch!!.models)
        assertEquals(null, ch!!.previousTier)
        assertEquals("FREE", ch!!.tier)

        // 模拟重启：重新从磁盘读
        val m = AisAccountInfo.read(dir)
        assertEquals("a", m.optString("label"))
        val card = AisAccountInfo.putCardFields(JSONObject(), m, emptyList(), "zh-CN", "Asia/Shanghai")
        assertEquals(2, card.getInt("model_count"))
        assertEquals(2, card.getJSONArray("models").length())
        assertEquals("FREE", card.getString("benefit_tier"))
        assertEquals("2023-11-14T22:13:20.000Z", card.getString("refreshed_at"))
        assertEquals(1_700_000_000_000L, card.getLong("refreshed_at_ms"))
        assertEquals("zh-CN", card.getString("locale"))
        assertEquals("Asia/Shanghai", card.getString("timezone"))

        // 第二次刷新：previous 取上一次的值，已记录的权益保留
        AisAccountInfo.update(dir) { it.put("benefit_tier", "PRO") }
        AisAccountInfo.update(dir) { ch = AisAccountInfo.applyRefresh(it, listOf("a", "b", "c"), 1_700_000_100_000L) }
        assertEquals(2, ch!!.previousModels)
        assertEquals("PRO", ch!!.tier)
        assertEquals(3, AisAccountInfo.read(dir).getInt("model_count"))
    }

    @Test
    fun liveModelsWinOverStored() {
        val m = JSONObject()
        AisAccountInfo.applyRefresh(m, listOf("old"), 1L)
        val card = AisAccountInfo.putCardFields(JSONObject(), m, listOf("n1", "n2"), "en", "UTC")
        assertEquals(2, card.getInt("model_count"))
    }

    @Test
    fun ledgerReportMatchesConsoleFieldsAndPersists() {
        val f = File(tmpDir(), "usage.jsonl")
        val l = AisUsageLedger(f)
        val t0 = 1_700_000_000_000L
        l.add("acc1", "gemini-2.5-flash", 200, false, "openai", "/v1/chat/completions", t0, t0 + 1000, 10, 5, 20, 7, null, null)
        l.add("acc1", "gemini-2.5-flash", 200, true, "openai", "/v1/chat/completions", t0 + 60_000, t0 + 63_000, 1, 0, 2, 0, 400, null)
        l.add("acc2", "gemini-2.5-pro", 429, false, "anthropic", "/v1/messages", t0 + 120_000, t0 + 120_500, 0, 0, 0, 0, null, "quota")

        val rep = AisUsageLedger(f).report(t0 - 1, t0 + 3_600_000, 3600, "Asia/Shanghai") // 重新加载，验证持久化
        val tot = rep.getJSONObject("totals")
        assertEquals(3, tot.getInt("requests"))
        assertEquals(2, tot.getInt("succeeded"))
        assertEquals(1, tot.getInt("rate_limited"))
        assertEquals(11, tot.getLong("input_tokens"))
        assertEquals(5, tot.getLong("cached_tokens"))
        assertEquals(22, tot.getLong("reply_tokens"))
        assertEquals(7, tot.getLong("reasoning_tokens"))
        assertEquals(45, tot.getLong("total_tokens"))
        assertTrue(tot.getJSONObject("duration").getDouble("avg_ms") > 0)
        assertEquals(400.0, tot.getJSONObject("first_event").getDouble("avg_ms"), 0.01)

        val buckets = rep.getJSONArray("buckets")
        assertTrue(buckets.length() >= 1)
        var sum = 0
        for (i in 0 until buckets.length()) { sum += buckets.getJSONObject(i).getInt("requests"); assertTrue(buckets.getJSONObject(i).has("at")) }
        assertEquals(3, sum)

        val groups = rep.getJSONObject("groups")
        assertEquals(2, groups.getJSONArray("model").length())
        assertEquals(2, groups.getJSONArray("account").length())
        assertEquals("acc1", groups.getJSONArray("account").getJSONObject(0).getString("key"))
        assertEquals(2, rep.getJSONArray("pairs").length())

        val recs = AisUsageLedger(f).records(t0 - 1, t0 + 3_600_000, 100)
        assertEquals(3, recs.length())
        val newest = recs.getJSONObject(0)
        assertEquals("acc2", newest.getString("account"))
        assertEquals("rate_limited", newest.getString("state"))
        assertEquals(500, newest.getLong("duration_ms"))
        assertEquals("/v1/messages", newest.getString("path"))
    }

    @Test
    fun dailyBucketsAlignToLocalMidnight() {
        val l = AisUsageLedger(null)
        // 2023-11-15T01:00Z（当地 09:00），日桶应从当地 0 点 = 前一天 16:00Z 开始
        val t = 1_700_010_000_000L - (1_700_010_000_000L % 3_600_000L)
        l.add("a", "m", 200, false, "openai", "/v1/chat/completions", t, t + 10, 1, 0, 1, 0, null, null)
        val rep = l.report(t - 86_400_000L, t + 1, 86400, "Asia/Shanghai")
        val b = rep.getJSONArray("buckets")
        for (i in 0 until b.length()) {
            val at = b.getJSONObject(i).getString("at")
            assertTrue(at, at.endsWith("T16:00:00.000Z")) // 当地 0 点
        }
    }

    @Test
    fun ledgerCapsMemoryAndCompactsFile() {
        val f = File(tmpDir(), "usage.jsonl")
        val l = AisUsageLedger(f, cap = 10)
        for (i in 0 until 40) l.add("a", "m", 200, false, "openai", "/x", i.toLong() * 1000, i.toLong() * 1000 + 1, 0, 0, 0, 0, null, null)
        assertEquals(10, l.size)
        assertTrue(f.readLines().count { it.isNotBlank() } <= 15)
        assertEquals(10, AisUsageLedger(f, cap = 10).size)
    }
}
