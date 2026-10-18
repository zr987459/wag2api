package com.wag2api.app

import android.content.Context
import org.json.JSONArray
import org.json.JSONObject
import java.util.concurrent.ConcurrentHashMap

/**
 * 账号调度器：多账号轮询 + 429 冷却。
 *
 * 并发语义（本版修正）：
 *  - pick() 整体加锁，并在**选中当下**就在内存里记 lastPicked / inflight，
 *    同一时刻并发进来的 N 个请求会被摊到不同账号上（旧版要等流结束才 touch，
 *    且 last_used 被 auths/ 文件覆盖读不回来，并发请求必然全部打到同一个号）。
 *  - 轮询依据只看内存，不再每个请求重写 SharedPreferences；
 *    last_used 落盘节流到每个账号 60s 最多一次，仅供面板展示。
 *  - 调用方拿到账号后必须在 finally 里 release(uid)。
 */
object AccountScheduler {

    private const val PREF = "wag2api_scheduler"
    private const val KEY_SELECTED = "selected_uid"

    /** 429 默认冷却：8s 起步，连续命中指数放大，封顶 5 分钟 */
    private const val BASE_COOLDOWN_MS = 8_000L
    private const val MAX_COOLDOWN_MS = 5 * 60_000L
    /** last_used 落盘节流 */
    private const val PERSIST_INTERVAL_MS = 60_000L

    private val lock = Any()
    private val cooldownUntil = ConcurrentHashMap<String, Long>()
    private val strikes = ConcurrentHashMap<String, Int>()
    private val lastPicked = ConcurrentHashMap<String, Long>()
    private val inflight = ConcurrentHashMap<String, Int>()
    private val lastPersisted = ConcurrentHashMap<String, Long>()

    @Volatile private var selectedCache: String? = null

    fun init(ctx: Context) {
        selectedCache = ctx.getSharedPreferences(PREF, Context.MODE_PRIVATE)
            .getString(KEY_SELECTED, "") ?: ""
    }

    fun getSelectedUid(ctx: Context): String =
        selectedCache ?: (ctx.getSharedPreferences(PREF, Context.MODE_PRIVATE)
            .getString(KEY_SELECTED, "") ?: "").also { selectedCache = it }

    fun setSelectedUid(ctx: Context, uid: String) {
        selectedCache = uid
        ctx.getSharedPreferences(PREF, Context.MODE_PRIVATE)
            .edit().putString(KEY_SELECTED, uid).apply()
    }

    /** 命中限流：冷却时长随连续次数翻倍（8s → 16s → 32s …，封顶 5min） */
    fun markCooling(uid: String, ms: Long? = null) {
        val n = (strikes[uid] ?: 0) + 1
        strikes[uid] = n
        val dur = ms ?: minOf(BASE_COOLDOWN_MS shl minOf(n - 1, 6), MAX_COOLDOWN_MS)
        cooldownUntil[uid] = System.currentTimeMillis() + dur
    }

    /** 请求成功：清零连续限流计数 */
    fun markSuccess(uid: String) {
        strikes.remove(uid)
    }

    fun isCooling(uid: String): Boolean {
        val until = cooldownUntil[uid] ?: return false
        if (System.currentTimeMillis() >= until) {
            cooldownUntil.remove(uid, until)
            return false
        }
        return true
    }

    fun cooldownRemainMs(uid: String): Long {
        val until = cooldownUntil[uid] ?: return 0
        return (until - System.currentTimeMillis()).coerceAtLeast(0)
    }

    fun cooldownRemainSec(uid: String): Int = ((cooldownRemainMs(uid) + 999) / 1000).toInt()

    /**
     * 取一个可用账号并占用它（inflight+1）。调用方用完必须 release(uid)。
     * 优先级：手动选中（未冷却）→ 未冷却里 inflight 最少、其次最久未被选中 → 全冷却取最快结束的。
     * 返回 null 表示没有任何可用（未禁用、未排除）账号。
     */
    fun acquire(ctx: Context, realm: String, exclude: Set<String> = emptySet()): JSONObject? {
        val all = AccountVault.getAccounts()   // 磁盘 IO 放在锁外
        synchronized(lock) {
            val candidates = collect(all, realm, exclude)
            if (candidates.isEmpty()) return null

            val selected = getSelectedUid(ctx)
            val chosen = candidates.firstOrNull {
                selected.isNotEmpty() && it.optString("uid") == selected && !isCooling(selected)
            } ?: candidates.filter { !isCooling(it.optString("uid")) }
                .minWithOrNull(compareBy<JSONObject>(
                    { inflight[it.optString("uid")] ?: 0 },
                    { lastPicked[it.optString("uid")] ?: it.optLong("last_used", 0L) }
                ))
            ?: candidates.minByOrNull { cooldownRemainMs(it.optString("uid")) }
            ?: return null

            val uid = chosen.optString("uid")
            lastPicked[uid] = System.currentTimeMillis()
            inflight.merge(uid, 1, Int::plus)
            return chosen
        }
    }

    /** 兼容旧调用：不占用 inflight，仅用于展示 / 判空 */
    fun pick(ctx: Context, realm: String, exclude: Set<String> = emptySet()): JSONObject? =
        acquire(ctx, realm, exclude)?.also { release(it.optString("uid")) }

    fun release(uid: String) {
        inflight.computeIfPresent(uid) { _, n -> if (n <= 1) null else n - 1 }
    }

    private fun collect(all: JSONArray, realm: String, exclude: Set<String>): List<JSONObject> {
        fun scan(matchRealm: Boolean): List<JSONObject> {
            val out = ArrayList<JSONObject>()
            for (i in 0 until all.length()) {
                val a = all.optJSONObject(i) ?: continue
                if (a.optBoolean("disabled", false)) continue
                if (matchRealm && a.optString("realm") != realm) continue
                val uid = a.optString("uid")
                if (uid.isEmpty() || uid in exclude) continue
                out.add(a)
            }
            return out
        }
        // realm 字段缺失的老数据兼容：该 realm 一个都没有时退回全部未禁用账号
        return scan(true).ifEmpty { scan(false) }
    }

    /** 记一次使用：内存即时生效，落盘节流（只为面板显示 last_used） */
    fun touch(uid: String) {
        val now = System.currentTimeMillis()
        lastPicked[uid] = now
        val prev = lastPersisted[uid] ?: 0L
        if (now - prev >= PERSIST_INTERVAL_MS) {
            lastPersisted[uid] = now      // 并发下最坏多写一次，可接受
            AccountVault.updateAccount(uid) { it.put("last_used", now) }
        }
    }

    fun poolStatus(): JSONArray {
        val out = JSONArray()
        val all = AccountVault.getAccounts()
        for (i in 0 until all.length()) {
            val a = all.optJSONObject(i) ?: continue
            val uid = a.optString("uid")
            out.put(JSONObject().apply {
                put("uid", uid)
                put("nickname", a.optString("nickname"))
                put("realm", a.optString("realm"))
                put("disabled", a.optBoolean("disabled", false))
                put("cooling", isCooling(uid))
                put("cooldown_sec", cooldownRemainSec(uid))
                put("inflight", inflight[uid] ?: 0)
                put("last_used", lastPicked[uid] ?: a.optLong("last_used", 0L))
                put("request_count", a.optJSONObject("token_usage")?.optInt("request_count", 0) ?: 0)
            })
        }
        return out
    }

    /** 仅供面板「清除冷却」按钮使用；网关内部不要调用（会影响其他并发请求） */
    fun clearAllCooldowns() {
        cooldownUntil.clear()
        strikes.clear()
    }
}
