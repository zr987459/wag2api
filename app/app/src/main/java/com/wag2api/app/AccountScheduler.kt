package com.wag2api.app

import android.content.Context
import org.json.JSONArray
import org.json.JSONObject
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.atomic.AtomicInteger

/**
 * 账号调度器：多账号轮询 + 429 冷却 + 并发租约。
 *
 * 设计要点：
 *  - 429 / 14003（模型繁忙）命中后给该账号打短冷却，换下一个账号立刻重试。
 *  - 冷却按 uid 记录，到期自动恢复，不做永久淘汰（腾讯的限流是波动的）。
 *  - acquire() 在锁内「选 + 占」一步完成：选中即刻写 lastUsed 并 inFlight+1，
 *    并发请求不会扎堆到同一个账号；调用方必须在 finally 里 release(uid)。
 *  - lastUsed / inFlight 只放内存，不再每个请求重写 SharedPreferences。
 */
object AccountScheduler {

    private const val PREF = "wag2api_scheduler"
    private const val KEY_SELECTED = "selected_uid"

    /** 429 默认冷却时长：模型繁忙通常是瞬时的，8 秒足够躲过一波 */
    private const val DEFAULT_COOLDOWN_MS = 8_000L

    /** uid -> 冷却到期时间戳 */
    private val cooldownUntil = ConcurrentHashMap<String, Long>()
    /** uid -> 最近一次被分配的时间（内存，进程重启归零即可） */
    private val lastUsed = ConcurrentHashMap<String, Long>()
    /** uid -> 正在进行中的请求数 */
    private val inFlight = ConcurrentHashMap<String, AtomicInteger>()

    private val lock = Any()

    fun init(ctx: Context) {
        // 预留：未来可从磁盘恢复冷却状态，目前内存即可
    }

    /** 用户手动选中的账号 uid（空表示自动） */
    fun getSelectedUid(ctx: Context): String =
        ctx.getSharedPreferences(PREF, Context.MODE_PRIVATE)
            .getString(KEY_SELECTED, "") ?: ""

    fun setSelectedUid(ctx: Context, uid: String) {
        ctx.getSharedPreferences(PREF, Context.MODE_PRIVATE)
            .edit().putString(KEY_SELECTED, uid).apply()
    }

    fun markCooling(uid: String, ms: Long = DEFAULT_COOLDOWN_MS) {
        cooldownUntil[uid] = System.currentTimeMillis() + ms
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
        val until = cooldownUntil[uid] ?: return 0L
        return (until - System.currentTimeMillis()).coerceAtLeast(0L)
    }

    fun cooldownRemainSec(uid: String): Int = ((cooldownRemainMs(uid) + 999) / 1000).toInt()

    private fun inFlightOf(uid: String): Int = inFlight[uid]?.get() ?: 0

    /**
     * 选一个账号并占用它（lastUsed=now, inFlight+1）。
     * 优先级：手动选中 → 非冷却账号（inFlight 少者优先，其次最久未用）→ 全冷却时取最快解冻的。
     * 返回 null 表示 exclude 之外已无可用账号。
     */
    fun acquire(ctx: Context, realm: String, exclude: Set<String> = emptySet()): JSONObject? {
        val all = AccountVault.getAccounts()   // 锁外读盘，避免把文件 IO 串进调度锁
        val selected = getSelectedUid(ctx)
        synchronized(lock) {
            val candidates = ArrayList<JSONObject>()
            for (i in 0 until all.length()) {
                val a = all.optJSONObject(i) ?: continue
                if (a.optBoolean("disabled", false)) continue
                val uid = a.optString("uid")
                if (uid.isEmpty() || uid in exclude) continue
                val r = a.optString("realm")
                // realm 缺失的老数据视为通配；绝不把 cn 的 token 发去 global（反之亦然）
                if (r.isNotEmpty() && r != realm) continue
                candidates.add(a)
            }
            if (candidates.isEmpty()) return null

            val chosen =
                candidates.firstOrNull { selected.isNotEmpty() && it.optString("uid") == selected && !isCooling(selected) }
                    ?: candidates.filter { !isCooling(it.optString("uid")) }
                        .minWithOrNull(compareBy<JSONObject>({ inFlightOf(it.optString("uid")) },
                            { lastUsed[it.optString("uid")] ?: 0L }))
                    ?: candidates.minByOrNull { cooldownRemainMs(it.optString("uid")) }
                    ?: return null

            val uid = chosen.optString("uid")
            lastUsed[uid] = System.currentTimeMillis()
            inFlight.getOrPut(uid) { AtomicInteger(0) }.incrementAndGet()
            return chosen
        }
    }

    /** 与 acquire 配对，必须在 finally 中调用 */
    fun release(uid: String) {
        inFlight[uid]?.let { c -> if (c.decrementAndGet() < 0) c.set(0) }
    }

    /** 账号池状态，供前端展示 */
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
                put("in_flight", inFlightOf(uid))
                put("last_used", lastUsed[uid] ?: 0L)
                put("request_count", a.optJSONObject("token_usage")?.optInt("request_count", 0) ?: 0)
            })
        }
        return out
    }

    fun clearAllCooldowns() {
        cooldownUntil.clear()
    }
}
