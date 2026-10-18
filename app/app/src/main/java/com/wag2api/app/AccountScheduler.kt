package com.wag2api.app

import android.content.Context
import org.json.JSONArray
import org.json.JSONObject
import java.util.concurrent.ConcurrentHashMap

/**
 * 账号调度器：多账号轮询 + 429 冷却 + 自动重试。
 *
 * 设计要点：
 *  - 429 / 14003（模型繁忙）属于**上游限流**，不是账号问题，但它也会挑账号，
 *    所以命中后先给该账号打一个短冷却，换下一个账号立刻重试，用户无感。
 *  - 冷却按 uid 记录，到期自动恢复，不做永久淘汰（腾讯的限流是波动的）。
 *  - 优先用「当前选中账号」，其次按最近使用时间轮询（Round-Robin）。
 */
object AccountScheduler {

    private const val PREF = "wag2api_scheduler"
    private const val KEY_SELECTED = "selected_uid"

    /** uid -> 冷却到期时间戳 */
    private val cooldownUntil = ConcurrentHashMap<String, Long>()

    /** 429 默认冷却时长：模型繁忙通常是瞬时的，8 秒足够躲过一波 */
    private const val DEFAULT_COOLDOWN_MS = 8_000L

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

    /** 给某个账号打冷却 */
    fun markCooling(uid: String, ms: Long = DEFAULT_COOLDOWN_MS) {
        cooldownUntil[uid] = System.currentTimeMillis() + ms
    }

    /** uid -> 最近一次被分配的时间（内存，不落盘） */
    private val lastPicked = ConcurrentHashMap<String, Long>()

    fun isCooling(uid: String): Boolean {
        val until = cooldownUntil[uid] ?: return false
        if (System.currentTimeMillis() >= until) {
            // 条件删除：避免把另一个线程刚写入的新冷却误删
            cooldownUntil.remove(uid, until)
            return false
        }
        return true
    }

    fun cooldownRemainSec(uid: String): Int {
        val until = cooldownUntil[uid] ?: return 0
        val left = until - System.currentTimeMillis()
        return if (left > 0) ((left + 999) / 1000).toInt() else 0
    }

    /**
     * 取一个可用账号，按 exclude 排除已试过的。
     * 优先级：手动选中 → 非冷却账号（按最近分配时间轮询）→ 全冷却时取冷却最快结束的
     *
     * 并发：整个「挑选 + 记录分配时间」在同一把锁里完成，
     * 两个并发请求不会因为读到同一个 last_used 而挑中同一个账号
     * （手动选中账号除外，那是用户明确要求固定用它）。
     * realm：只在「账号本身没有 realm 字段」时才兼容回退，绝不把 cn 账号塞给 global 请求。
     */
    @Synchronized
    fun pick(ctx: Context, realm: String, exclude: Set<String> = emptySet()): JSONObject? {
        val all = AccountVault.getAccounts()
        val candidates = ArrayList<JSONObject>()
        for (i in 0 until all.length()) {
            val a = all.optJSONObject(i) ?: continue
            if (a.optBoolean("disabled", false)) continue
            val r = a.optString("realm")
            if (r.isNotEmpty() && r != realm) continue
            val uid = a.optString("uid")
            if (uid.isEmpty() || uid in exclude) continue
            candidates.add(a)
        }
        if (candidates.isEmpty()) return null

        val chosen = run {
            // 1. 手动选中优先（且不在冷却）
            val selected = getSelectedUid(ctx)
            if (selected.isNotEmpty()) {
                candidates.firstOrNull { it.optString("uid") == selected && !isCooling(selected) }
                    ?.let { return@run it }
            }
            // 2. 非冷却账号里，按最近分配时间升序（最久没用的先用）
            val healthy = candidates.filter { !isCooling(it.optString("uid")) }
            if (healthy.isNotEmpty()) {
                return@run healthy.minByOrNull { lastPicked[it.optString("uid")] ?: 0L }
            }
            // 3. 全在冷却：取冷却最快结束的
            candidates.minByOrNull { cooldownUntil[it.optString("uid")] ?: 0L }
        } ?: return null

        lastPicked[chosen.optString("uid")] = System.currentTimeMillis()
        return chosen
    }

    /** 毫秒级剩余冷却，供退避等待使用 */
    fun cooldownRemainMs(uid: String): Long {
        val until = cooldownUntil[uid] ?: return 0L
        return (until - System.currentTimeMillis()).coerceAtLeast(0L)
    }

    /**
     * 记录成功使用。只写内存：原实现每次请求都 updateAccount → 重写整个 JSONArray 进 prefs，
     * 而且 auths/ 文件条目会覆盖 prefs，写进去的 last_used 根本读不回来，轮询实际上一直挑第一个。
     */
    fun touch(uid: String) {
        lastPicked[uid] = System.currentTimeMillis()
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
                put("last_used", lastPicked[uid] ?: a.optLong("last_used", 0L))
                put("request_count", a.optJSONObject("token_usage")?.optInt("request_count", 0) ?: 0)
            })
        }
        return out
    }

    fun clearAllCooldowns() {
        cooldownUntil.clear()
    }
}
