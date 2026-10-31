package com.wag2api.ag

import org.json.JSONArray
import org.json.JSONObject
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import java.util.TimeZone
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.ScheduledExecutorService
import java.util.concurrent.ScheduledFuture
import java.util.concurrent.ScheduledThreadPoolExecutor
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean

/**
 * 移植自 src/quota-refresher.mjs：后台额度自动刷新 + 周额度智能预热。
 *
 * 安卓版改动：用一个单线程定时器（每轮结束后再排下一轮，不叠加）；
 * App 空闲（最近 IDLE_AFTER_MS 内没有代理请求、也没有 notifyActivity()）时间隔拉长到 IDLE_INTERVAL_MS。
 */
object QuotaRefresher {

    const val REFRESH_INTERVAL_MS = 15L * 60 * 1000 // 15 分钟
    const val PREWARM_DEDUPE_MS = 6L * 24 * 3600 * 1000 // 6 天内最多一次
    const val ACCOUNT_GAP_MS = 2500L // 账号之间间隔 2~3 秒

    /** 空闲判定与空闲间隔（安卓新增）。 */
    const val IDLE_AFTER_MS = 30L * 60 * 1000
    const val IDLE_INTERVAL_MS = 60L * 60 * 1000

    // 预热防重复：email -> { family -> timestamp }
    private val lastPrewarmStore = ConcurrentHashMap<String, ConcurrentHashMap<String, Long>>()

    @JvmStatic
    fun getLastPrewarm(email: String?, family: String): Long {
        val norm = (email ?: "").trim().lowercase(Locale.ROOT)
        return lastPrewarmStore[norm]?.get(family) ?: 0L
    }

    @JvmStatic
    @JvmOverloads
    fun setLastPrewarm(email: String?, family: String, timestamp: Long? = null) {
        val norm = (email ?: "").trim().lowercase(Locale.ROOT)
        lastPrewarmStore.getOrPut(norm) { ConcurrentHashMap() }[family] = timestamp ?: System.currentTimeMillis()
    }

    @JvmStatic
    fun clearLastPrewarms() = lastPrewarmStore.clear()

    /** 模型列表里第一个 claude+sonnet 的 id。models 可以是 JSONArray / JSONObject{data:[]} / List / null（= MODEL_LIST）。 */
    @JvmStatic
    @JvmOverloads
    fun findClaudeSonnetModel(models: Any? = null): String? {
        val list = toList(models) ?: toList(ModelsCatalog.MODEL_LIST) ?: emptyList()
        for (m in list) {
            val id = when (m) {
                is String -> m
                is JSONObject -> m.optString("id", "")
                is Map<*, *> -> (m["id"] ?: "").toString()
                else -> ""
            }
            val low = id.lowercase(Locale.ROOT)
            if (low.contains("claude") && low.contains("sonnet")) return id.ifEmpty { null }
        }
        return null
    }

    private fun toList(models: Any?): List<Any?>? = when (models) {
        null -> null
        is JSONArray -> (0 until models.length()).map { models.opt(it) }
        is List<*> -> models
        is Array<*> -> models.toList()
        is JSONObject -> models.optJSONArray("data")?.let { toList(it) }
        else -> null
    }

    /** 判定某账号某家族的周额度是否满足智能预热条件。 */
    @JvmStatic
    @JvmOverloads
    fun shouldPrewarmFamily(
        email: String?,
        family: String?,
        quotaData: JSONObject?,
        lastPrewarmAt: Long = 0,
        prewarmWeeklyEnabled: Boolean = false,
        now: Long = System.currentTimeMillis(),
    ): Boolean {
        if (!prewarmWeeklyEnabled) return false
        if (email.isNullOrEmpty() || family.isNullOrEmpty()) return false
        if (family != "gemini" && family != "claude") return false
        if (lastPrewarmAt != 0L && now - lastPrewarmAt < PREWARM_DEDUPE_MS) return false
        if (quotaData == null) return false

        var bucket: JSONObject? = quotaData.optJSONObject("${family}_7d")
        if (bucket == null) {
            val arr = quotaData.optJSONArray("buckets")
            if (arr != null) for (i in 0 until arr.length()) {
                val b = arr.optJSONObject(i) ?: continue
                if (b.optString("window") == "7d" && b.optString("group") == family) { bucket = b; break }
            }
        }
        if (bucket == null) return false

        val rf = bucket.opt("remaining_fraction")
        val fr = bucket.opt("fraction")
        val pc = bucket.opt("percentage")
        val fraction: Double = when {
            rf is Number -> rf.toDouble()
            fr is Number -> fr.toDouble()
            pc is Number -> pc.toDouble() / 100
            else -> return false
        }
        if (fraction < 0.99) return false

        val resetRaw = bucket.opt("reset_time").let { if (it == null || it == JSONObject.NULL) bucket.opt("reset") else it }
        if (resetRaw == null || resetRaw == JSONObject.NULL || resetRaw.toString().isEmpty() || resetRaw == false) return true
        val resetMs = QuotaFetcher.parseIsoMs(resetRaw.toString()) ?: return true
        return resetMs <= now
    }

    /** 对指定账号在指定家族执行极小测试请求完成预热。 */
    @JvmStatic
    @JvmOverloads
    fun prewarmAccountFamily(
        email: String,
        family: String,
        accountPool: AccountPool?,
        models: Any? = null,
        fetchImpl: AccountTester.FetchImpl? = null,
        now: Long = System.currentTimeMillis(),
    ): JSONObject {
        val modelToUse: String = when (family) {
            "gemini" -> "gemini-3.8-flash"
            "claude" -> findClaudeSonnetModel(models)
                ?: return JSONObject().put("ok", false).put("skipped", true).put("reason", "no_claude_sonnet_model")
            else -> return JSONObject().put("ok", false).put("skipped", true).put("reason", "unsupported_family")
        }
        setLastPrewarm(email, family, now)
        return try {
            val res = AccountTester.testAccount(
                email = email,
                model = modelToUse,
                accountPool = accountPool,
                fetchImpl = fetchImpl ?: AccountTester.defaultFetch,
                timeoutMs = 15000,
            )
            JSONObject().put("ok", res.optBoolean("ok", false)).put("model", modelToUse).put("result", res)
        } catch (err: Throwable) {
            JSONObject().put("ok", false).put("model", modelToUse).put("error", err.message ?: err.toString())
        }
    }

    private fun iso(ms: Long): String {
        val f = SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss.SSS'Z'", Locale.ROOT)
        f.timeZone = TimeZone.getTimeZone("UTC")
        return f.format(Date(ms))
    }

    private fun status(intervalMs: Long, lastRun: Long, nextRun: Long): JSONObject = JSONObject()
        .put("interval_min", intervalMs / 60000)
        .put("last_run_at", iso(lastRun))
        .put("next_run_at", iso(nextRun))

    /** 拉取函数（可注入，便于测试）。 */
    fun interface QuotaFetcherFn {
        fun fetch(mgr: TokenManager): JSONObject?
    }

    /**
     * 单轮刷新所有账号额度并按需预热（同步阻塞）。
     * intervalMs 用于写入 quota_refresh 状态里的 interval_min / next_run_at（安卓空闲时会变长）。
     */
    @JvmStatic
    @JvmOverloads
    fun refreshAllQuotasOnce(
        accountPool: AccountPool?,
        quotaCache: MutableMap<String, JSONObject>? = null,
        quotaFetcher: QuotaFetcherFn = QuotaFetcherFn { QuotaFetcher.fetchRealQuota(it) },
        fetchImpl: AccountTester.FetchImpl? = null,
        models: Any? = null,
        sleep: (Long) -> Unit = { Thread.sleep(it) },
        now: Long = System.currentTimeMillis(),
        intervalMs: Long = REFRESH_INTERVAL_MS,
    ): JSONObject {
        if (accountPool == null || accountPool.managers.isEmpty()) {
            accountPool?.setQuotaRefreshStatus(status(intervalMs, now, now + intervalMs))
            return JSONObject().put("count", 0).put("refreshed", JSONArray())
        }
        accountPool.setQuotaRefreshStatus(status(intervalMs, now, now + intervalMs))

        val emails = accountPool.managers.keys.toList()
        val refreshed = JSONArray()
        for (i in emails.indices) {
            val email = emails[i]
            val mgr = accountPool.getManager(email)
            if (mgr != null) {
                try {
                    val quotaData = quotaFetcher.fetch(mgr)
                    val qEmail = quotaData?.optString("email", "") ?: ""
                    if (quotaData != null && quotaData.optBoolean("ok", false) && qEmail.isNotEmpty()) {
                        val familyQuotas = QuotaFetcher.computeAccountQuotas(quotaData)
                        quotaCache?.put(qEmail, familyQuotas)
                        accountPool.updateQuota(qEmail, quotaData)
                        refreshed.put(qEmail)

                        if (accountPool.prewarmWeekly) {
                            for (family in arrayOf("gemini", "claude")) {
                                val should = shouldPrewarmFamily(
                                    email = qEmail, family = family, quotaData = quotaData,
                                    lastPrewarmAt = getLastPrewarm(qEmail, family),
                                    prewarmWeeklyEnabled = true, now = now,
                                )
                                if (should) {
                                    prewarmAccountFamily(qEmail, family, accountPool, models, fetchImpl, now)
                                }
                            }
                        }
                    }
                } catch (e: InterruptedException) {
                    Thread.currentThread().interrupt()
                    break
                } catch (e: Throwable) {
                    android.util.Log.w("QuotaRefresher", "[QuotaRefresher] 刷新账号 $email 额度异常: ${e.message}")
                }
            }
            if (i < emails.size - 1) {
                try { sleep(ACCOUNT_GAP_MS) } catch (_: InterruptedException) { Thread.currentThread().interrupt(); break }
            }
        }
        return JSONObject().put("count", refreshed.length()).put("refreshed", refreshed)
    }

    // ------------------------------------------------------------------ 定时循环（单线程）

    private var executor: ScheduledExecutorService? = null
    private var pending: ScheduledFuture<*>? = null
    private val isRefreshing = AtomicBoolean(false)
    @Volatile private var lastActivityAt = System.currentTimeMillis()
    @Volatile private var baseIntervalMs = REFRESH_INTERVAL_MS

    /** 控制台打开 / 有请求时调用，标记“非空闲”；若当前在长间隔等待中，提前到正常间隔。 */
    @JvmStatic
    fun notifyActivity() {
        val wasIdle = isIdle()
        lastActivityAt = System.currentTimeMillis()
        if (wasIdle) reschedule()
    }

    private fun lastRequestAt(): Long = try { Stats.statsTracker.lastRequestAt } catch (_: Throwable) { 0L }

    @JvmStatic
    fun isIdle(now: Long = System.currentTimeMillis()): Boolean =
        now - Math.max(lastActivityAt, lastRequestAt()) > IDLE_AFTER_MS

    /** 当前应使用的间隔：活跃时 intervalMs，空闲时 max(intervalMs, IDLE_INTERVAL_MS)。 */
    @JvmStatic
    fun currentIntervalMs(): Long = if (isIdle()) Math.max(baseIntervalMs, IDLE_INTERVAL_MS) else baseIntervalMs

    private var loopPool: AccountPool? = null
    private var loopCache: MutableMap<String, JSONObject>? = null
    private var loopModels: Any? = null
    private var nextRunAt = 0L

    @JvmStatic
    @JvmOverloads
    @Synchronized
    fun startQuotaRefreshLoop(
        accountPool: AccountPool,
        quotaCache: MutableMap<String, JSONObject>?,
        intervalMs: Long = REFRESH_INTERVAL_MS,
        initialDelayMs: Long = 5000,
        models: Any? = null,
    ) {
        if (executor != null) return
        loopPool = accountPool
        loopCache = quotaCache
        loopModels = models
        baseIntervalMs = intervalMs
        executor = ScheduledThreadPoolExecutor(1) { r ->
            Thread(r, "ag-quota-refresh").apply { isDaemon = true; priority = Thread.MIN_PRIORITY }
        }.apply { removeOnCancelPolicy = true }
        scheduleNext(initialDelayMs)
    }

    @Synchronized
    private fun scheduleNext(delayMs: Long) {
        val ex = executor ?: return
        pending?.cancel(false)
        nextRunAt = System.currentTimeMillis() + delayMs
        pending = ex.schedule({ runOnce() }, delayMs, TimeUnit.MILLISECONDS)
    }

    /** 从空闲恢复：若下一轮比正常间隔还远，提前。 */
    @Synchronized
    private fun reschedule() {
        if (executor == null || isRefreshing.get()) return
        val desired = System.currentTimeMillis() + baseIntervalMs
        if (nextRunAt > desired) scheduleNext(baseIntervalMs)
    }

    private fun runOnce() {
        if (!isRefreshing.compareAndSet(false, true)) return
        try {
            val pool = loopPool ?: return
            refreshAllQuotasOnce(accountPool = pool, quotaCache = loopCache, models = loopModels, intervalMs = currentIntervalMs())
        } catch (e: Throwable) {
            android.util.Log.w("QuotaRefresher", "[QuotaRefresher] 定时刷新执行异常: ${e.message}")
        } finally {
            isRefreshing.set(false)
            if (!Thread.currentThread().isInterrupted) scheduleNext(currentIntervalMs())
        }
    }

    @JvmStatic
    @Synchronized
    fun stopQuotaRefreshLoop() {
        pending?.cancel(true)
        pending = null
        executor?.shutdownNow()
        executor = null
        loopPool = null
        loopCache = null
    }
}
