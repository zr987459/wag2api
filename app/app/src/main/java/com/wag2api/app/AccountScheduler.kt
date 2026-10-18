package com.wag2api.app

import android.content.Context
import org.json.JSONArray
import org.json.JSONObject
import java.util.concurrent.ConcurrentHashMap

/**
 * 账号调度器：多账号轮询 + 429 冷却 + 并发租约。
 *
 * 设计要点：
 *  - 429 / 14003（模型繁忙）属于**上游限流**：命中后给该账号打短冷却，换下一个账号立刻重试。
 *  - 冷却按 uid 记录，到期自动恢复，不做永久淘汰（腾讯的限流是波动的）。
 *  - **acquire() 是原子的**：选号的同时登记 inflight 和 lastPicked，
 *    并发请求不会再全部挤到同一个「last_used 最小」的账号上。
 *  - last_used / inflight 只放内存；落盘节流到每账号 60s 一次，避免每个请求重写整份账号 JSON。
 */
object AccountScheduler {

    private const val PREF = "wag2api_scheduler"
    private const val KEY_SELECTED = "selected_uid"

    /** 429 默认冷却时长：模型繁忙通常是瞬时的，8 秒足够躲过一波 */
    private const val DEFAULT_COOLDOWN_MS = 8_000L

    /** last_used 落盘节流 */
    private const val PERSIST_INTERVAL_MS = 60_000L

    /** uid -> 冷却到期时间戳 */
    private val cooldownUntil = ConcurrentHashMap<String, Long>()

    // 以下三张表只在 synchronized(this) 内读写
    private val inflight = HashMap<String, Int>()
    private val lastPicked = HashMap<String, Long>()
    private val lastPersisted = HashMap<String, Long>()

    @Volatile private var selectedCache: String? = null

    fun init(ctx: Context) {
        selectedCache = ctx.getSharedPreferences(PREF, Context.MODE_PRIVATE)
            .getString(KEY_SELECTED, "") ?: ""
    }

    /** 用户手动选中的账号 uid（空表示自动） */
    fun getSelectedUid(ctx: Context): String =
        selectedCache ?: (ctx.getSharedPreferences(PREF, Context.MODE_PRIVATE)
            .getString(KEY_SELECTED, "") ?: "").also { selectedCache = it }

    fun setSelectedUid(ctx: Context, uid: String) {
        selectedCache = uid
        ctx.getSharedPreferences(PREF, Context.MODE_PRIVATE)
            .edit().putString(KEY_SELECTED, uid).apply()
    }

    /** 给某个账号打冷却 */
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
        val until = cooldownUntil[uid] ?: return 0
        return (until - System.currentTimeMillis()).coerceAtLeast(0)
    }

    fun cooldownRemainSec(uid: String): Int = ((cooldownRemainMs(uid) + 999) / 1000).toInt()

    /**
     * 取一个账号并登记租约（inflight+1）。用完**必须** release(uid)。
     *
     * 优先级：手动选中（非冷却）→ 非冷却账号按 (inflight, lastPicked) 升序 → 全冷却时取冷却最快结束的。
     * @param allowCooling false 时全冷却直接返回 null（让调用方决定是否退避）
     */
    fun acquire(
        ctx: Context,
        realm: String,
        exclude: Set<String> = emptySet(),
        allowCooling: Boolean = true
    ): JSONObject? {
        val all = AccountVault.getAccounts()          // 读快照放在锁外，避免与 AccountVault 锁嵌套
        val selected = getSelectedUid(ctx)
        synchronized(this) {
            val candidates = collect(all, realm, exclude).ifEmpty { collect(all, null, exclude) }
            if (candidates.isEmpty()) return null

            val preferred: JSONObject? =
                candidates.firstOrNull { it.optString("uid") == selected && !isCooling(selected) }
            val healthy: JSONObject? = preferred ?: candidates
                .filter { !isCooling(it.optString("uid")) }
                .minWithOrNull(compareBy<JSONObject>(
                    { inflight[it.optString("uid")] ?: 0 },
                    { lastPicked[it.optString("uid")] ?: it.optLong("last_used", 0L) }
                ))
            val chosen: JSONObject = healthy
                ?: (if (allowCooling) candidates.minByOrNull { cooldownRemainMs(it.optString("uid")) } else null)
                ?: return null

            val uid = chosen.optString("uid")
            inflight[uid] = (inflight[uid] ?: 0) + 1
            lastPicked[uid] = System.currentTimeMillis()
            return chosen
        }
    }

    /** 归还租约；ok=true 表示这次请求成功，顺带节流落盘 last_used */
    fun release(uid: String, ok: Boolean) {
        var persist = false
        val now = System.currentTimeMillis()
        synchronized(this) {
            val n = (inflight[uid] ?: 1) - 1
            if (n <= 0) inflight.remove(uid) else inflight[uid] = n
            if (ok && now - (lastPersisted[uid] ?: 0L) >= PERSIST_INTERVAL_MS) {
                lastPersisted[uid] = now
                persist = true
            }
        }
        if (persist) AccountVault.updateAccount(uid) { it.put("last_used", now) }
    }

    /** 是否存在可用（未禁用）账号，不看冷却 */
    fun hasUsableAccount(realm: String): Boolean {
        val all = AccountVault.getAccounts()
        return collect(all, realm, emptySet()).isNotEmpty() || collect(all, null, emptySet()).isNotEmpty()
    }

    private fun collect(all: JSONArray, realm: String?, exclude: Set<String>): List<JSONObject> {
        val out = ArrayList<JSONObject>()
        for (i in 0 until all.length()) {
            val a = all.optJSONObject(i) ?: continue
            if (a.optBoolean("disabled", false)) continue
            if (realm != null && a.optString("realm") != realm) continue
            val uid = a.optString("uid")
            if (uid.isEmpty() || uid in exclude) continue
            out.add(a)
        }
        return out
    }

    /** 账号池状态，供前端展示 */
    fun poolStatus(): JSONArray {
        val out = JSONArray()
        val all = AccountVault.getAccounts()
        val (inf, picked) = synchronized(this) { HashMap(inflight) to HashMap(lastPicked) }
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
                put("inflight", inf[uid] ?: 0)
                put("last_used", picked[uid] ?: a.optLong("last_used", 0L))
                put("request_count", a.optJSONObject("token_usage")?.optInt("request_count", 0) ?: 0)
            })
        }
        return out
    }

    /** 仅供面板「清除冷却」按钮使用；请求路径里不要调用 */
    fun clearAllCooldowns() {
        cooldownUntil.clear()
    }
}
