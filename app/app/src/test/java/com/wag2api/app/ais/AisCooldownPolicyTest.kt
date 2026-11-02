package com.wag2api.app.ais

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * AIS 429 递增冷却、冷却类型判断与全冷却 plan_limit 兜底纯逻辑单测（纯 JVM，不依赖 Android）。
 */
class AisCooldownPolicyTest {

    @Test
    fun cooldownMinutesIncrements() {
        // 递增阶梯：1、5、15、30、60 分钟（第 5 次及以后 60 分钟）
        assertEquals(1L, AisCooldownPolicy.cooldownMinutes(0))
        assertEquals(1L, AisCooldownPolicy.cooldownMinutes(1))
        assertEquals(5L, AisCooldownPolicy.cooldownMinutes(2))
        assertEquals(15L, AisCooldownPolicy.cooldownMinutes(3))
        assertEquals(30L, AisCooldownPolicy.cooldownMinutes(4))
        assertEquals(60L, AisCooldownPolicy.cooldownMinutes(5))
        assertEquals(60L, AisCooldownPolicy.cooldownMinutes(6))
        assertEquals(60L, AisCooldownPolicy.cooldownMinutes(100))
    }

    @Test
    fun cooldownTypeClassification() {
        // plan_limit：含 "usage limit" / "reached your" / quota 类
        assertEquals("plan_limit", AisCooldownPolicy.cooldownType("Resource has been exhausted (e.g. check quota)."))
        assertEquals("plan_limit", AisCooldownPolicy.cooldownType("You have exceeded your Quota for today"))
        assertEquals("plan_limit", AisCooldownPolicy.cooldownType("You have reached your daily limit"))
        assertEquals("plan_limit", AisCooldownPolicy.cooldownType("Account usage limit exceeded"))
        assertEquals("plan_limit", AisCooldownPolicy.cooldownType("usage limit"))

        // rate_limit：其他 429
        assertEquals("rate_limit", AisCooldownPolicy.cooldownType("Rate limit exceeded. Too many requests per minute."))
        assertEquals("rate_limit", AisCooldownPolicy.cooldownType("Too Many Requests"))
        assertEquals("rate_limit", AisCooldownPolicy.cooldownType(""))
        assertEquals("rate_limit", AisCooldownPolicy.cooldownType(null))
    }

    @Test
    fun normalCandidatesPrioritizeReadyAndRoundRobin() {
        val now = 100_000L
        val accs = listOf(
            AisCooldownPolicy.AccountState(id = "acc1", isReady = false),
            AisCooldownPolicy.AccountState(id = "acc2", isReady = true),
            AisCooldownPolicy.AccountState(id = "acc3", isReady = true),
            AisCooldownPolicy.AccountState(id = "acc4", cooldownUntil = now + 10_000L), // 冷却中
            AisCooldownPolicy.AccountState(id = "acc5", isAuthRequired = true), // 需认证
            AisCooldownPolicy.AccountState(id = "acc6", enabled = false), // 已禁用
        )

        // 正常可用仅 acc2, acc3, acc1（ready 在前），round-robin 轮询
        val c0 = AisCooldownPolicy.selectCandidates(accs, now, 0)
        assertEquals(listOf("acc2", "acc3", "acc1"), c0)

        // 当所有可用账号都 ready 时轮询偏移生效
        val readyOnly = listOf(
            AisCooldownPolicy.AccountState(id = "a", isReady = true),
            AisCooldownPolicy.AccountState(id = "b", isReady = true),
            AisCooldownPolicy.AccountState(id = "c", isReady = true),
        )
        assertEquals(listOf("a", "b", "c"), AisCooldownPolicy.selectCandidates(readyOnly, now, 0))
        assertEquals(listOf("b", "c", "a"), AisCooldownPolicy.selectCandidates(readyOnly, now, 1))
        assertEquals(listOf("c", "a", "b"), AisCooldownPolicy.selectCandidates(readyOnly, now, 2))
    }

    @Test
    fun allCooldownFallbackPlanLimitOnlySortedByRemaining() {
        val now = 1_000_000L
        val accs = listOf(
            // 冷却中 plan_limit，剩余 50 秒
            AisCooldownPolicy.AccountState(id = "p50", cooldownUntil = now + 50_000L, cooldownType = "plan_limit"),
            // 冷却中 plan_limit，剩余 10 秒
            AisCooldownPolicy.AccountState(id = "p10", cooldownUntil = now + 10_000L, cooldownType = "plan_limit"),
            // 冷却中 plan_limit，剩余 30 秒
            AisCooldownPolicy.AccountState(id = "p30", cooldownUntil = now + 30_000L, cooldownType = "plan_limit"),
            // 冷却中 rate_limit（不兜底）
            AisCooldownPolicy.AccountState(id = "r5", cooldownUntil = now + 5_000L, cooldownType = "rate_limit"),
            // plan_limit 但 AUTH_REQUIRED（不兜底）
            AisCooldownPolicy.AccountState(id = "p_auth", cooldownUntil = now + 1_000L, cooldownType = "plan_limit", isAuthRequired = true),
            // 已禁用（不参与）
            AisCooldownPolicy.AccountState(id = "disabled", enabled = false, cooldownUntil = now + 1_000L, cooldownType = "plan_limit"),
        )

        val fallback = AisCooldownPolicy.selectCandidates(accs, now)
        // 仍按冷却剩余时间从短到长返回这些 plan_limit 账号用于尝试；rate_limit / auth_required 不兜底
        assertEquals(listOf("p10", "p30", "p50"), fallback)
    }

    @Test
    fun allCooldownWithOnlyRateLimitReturnsEmpty() {
        val now = 1_000_000L
        val accs = listOf(
            AisCooldownPolicy.AccountState(id = "r1", cooldownUntil = now + 10_000L, cooldownType = "rate_limit"),
            AisCooldownPolicy.AccountState(id = "r2", cooldownUntil = now + 20_000L, cooldownType = "rate_limit"),
        )
        val res = AisCooldownPolicy.selectCandidates(accs, now)
        assertTrue(res.isEmpty())
    }

    @Test
    fun emptyOrDisabledAccountsReturnEmpty() {
        val now = 1_000_000L
        assertTrue(AisCooldownPolicy.selectCandidates(emptyList(), now).isEmpty())
        assertTrue(AisCooldownPolicy.selectCandidates(listOf(AisCooldownPolicy.AccountState(id = "x", enabled = false)), now).isEmpty())
    }

    @Test
    fun earliestRecoveryTimeCalculation() {
        val now = 500_000L
        val accs = listOf(
            AisCooldownPolicy.AccountState(id = "a", cooldownUntil = now + 30_000L),
            AisCooldownPolicy.AccountState(id = "b", cooldownUntil = now + 10_000L),
            AisCooldownPolicy.AccountState(id = "c", cooldownUntil = now + 60_000L),
            AisCooldownPolicy.AccountState(id = "d", enabled = false, cooldownUntil = now + 1_000L),
        )
        val earliest = AisCooldownPolicy.earliestRecoveryTime(accs, now)
        assertEquals(now + 10_000L, earliest)

        val noCooldown = listOf(
            AisCooldownPolicy.AccountState(id = "a", cooldownUntil = 0L),
            AisCooldownPolicy.AccountState(id = "b", cooldownUntil = now - 1000L),
        )
        assertNull(AisCooldownPolicy.earliestRecoveryTime(noCooldown, now))
    }
}
