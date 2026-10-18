package com.wag2api.app

import android.content.Context
import org.json.JSONArray
import org.json.JSONObject
import java.util.concurrent.ConcurrentHashMap

/**
 * 账号调度器：多账号轮询 + 429 冷却。
 *
 * 设计要点：
 *  - 429 / 14003（模型繁忙）命中后给该账号打短冷却，换下一个账号重试。
 *  - 冷却按 uid 记录，到期自动恢复，不做永久淘汰（腾讯的限流是波动的）。
 *  - 优先用「当前选中账号」，其次「在途请求最少 → 最久没被选中」。
 *
 * 并发语义（修复点）：
 *  - pick() 是 @Synchronized 的，并且在**选中的那一刻**就记 lastPicked + inflight++，
 *    所以 N 个并发请求会被摊到不同账号上。旧实现只在流结束后 touch()，
 *    整个流期间 last_used 不变，并发请求全部挤到同一个账号。
 *  - lastPicked / inflight 只放内存，不再每个请求重写一次 SharedPreferences。
 *  - 调用方必须在请求结束时 release(uid)（TencentGateway 用 try/finally 保证）。
 */
object AccountScheduler {

    private const val PREF = "wag2api_scheduler"
    private const val KEY_SELECTED = "selected_uid"

    /** 429 默认冷却时长：模型繁忙通常是瞬时的，8 秒足够躲过一波 */
    const val DEFAULT_COOLDOWN_MS = 8_000L

    /** uid -> 冷却到期时间戳 */
    private val cooldownUntil = ConcurrentHashMap<String, Long>()
    /** uid -> 最近一次被 pick 的时间戳（内存态，重启归零无所谓） */
    private val lastPicked = ConcurrentHashMap<String, Long>()
    /** uid -> 在途请求数 */
    private val inflight = ConcurrentHashMap<String, Int>()

    @Volatile private var selectedCache: String? = null

    fun init(ctx: Context) {
        selectedCache = readSelected(ctx)
    }

    private fun readSelected(ctx: Context): String =
        ctx.getSharedPreferences(PREF, Context.MODE_PRIVATE).getString(KEY_SELECTED, "") ?: ""

    /** 用户手动选中的账号 uid（空表示自动） */
    fun getSelectedUid(ctx: Context): String =
        selectedCache ?: readSelected(ctx).also { selectedCache = it }

    fun setSelectedUid(ctx: Context, uid: String) {
        ctx.getSharedPreferences(PREF, Context.MODE_PRIVATE)
            .edit().putString(KEY_SELECTED, uid).apply()
        selectedCache = uid
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
     * 取一个可用账号并**登记占用**，按 exclude 排除已试过的。
     * 优先级：手动选中（非冷却）→ 非冷却账号（在途最少，再按最久未选）→ 全冷却时取冷却最快结束的
     * 拿到非 null 后必须配对调用 release(uid)。
     */
    @Synchronized
    fun pick(ctx: Context, realm: String, exclude: Set<String> = emptySet()): JSONObject? {
        val all = AccountVault.getAccounts()
        val candidates = ArrayList<JSONObject>()
        for (i in 0 until all.length()) {
            val a = all.optJSONObject(i) ?: continue
            if (a.optBoolean("disabled", false)) continue
            val uid = a.optString("uid")
            if (uid.isEmpty() || uid in exclude) continue
            val r = a.optString("realm")
            // realm 缺失的老数据视为通配；绝不把 cn 账号发给 global 端点（反之亦然）。
            // 旧实现在「该 realm 的账号都被 exclude 掉」时也会回退到全部账号，导致跨 realm 发 token。
            if (r.isNotEmpty() && r != realm) continue
            candidates.add(a)
        }
        if (candidates.isEmpty()) return null

        val chosen = run {
            val selected = getSelectedUid(ctx)
            if (selected.isNotEmpty()) {
                candidates.firstOrNull { it.optString("uid") == selected && !isCooling(selected) }
                    ?.let { return@run it }
            }
            val healthy = candidates.filter { !isCooling(it.optString("uid")) }
            if (healthy.isNotEmpty()) {
                return@run healthy.minWithOrNull(
                    compareBy<JSONObject>({ inflight[it.optString("uid")] ?: 0 },
                        { lastPicked[it.optString("uid")] ?: 0L })
                )
            }
            candidates.minByOrNull { cooldownRemainMs(it.optString("uid")) }
        } ?: return null

        val uid = chosen.optString("uid")
        lastPicked[uid] = System.currentTimeMillis()
        inflight.merge(uid, 1, Int::plus)
        return chosen
    }

    /** 与 pick() 配对：请求结束（无论成败）时调用 */
    fun release(uid: String) {
        inflight.computeIfPresent(uid) { _, n -> if (n <= 1) null else n - 1 }
    }

    /** 兼容旧调用；last_used 已改为 pick 时登记，这里不再写盘 */
    @Deprecated("pick() 已在选中时登记使用时间", ReplaceWith(""))
    fun touch(uid: String) {}

    /** 当前非冷却账号里最早恢复的剩余时间（全冷却时用于退避），无账号返回 0 */
    fun minCooldownRemainMs(realm: String): Long {
        val all = AccountVault.getAccounts()
        var best = Long.MAX_VALUE
        for (i in 0 until all.length()) {
            val a = all.optJSONObject(i) ?: continue
            if (a.optBoolean("disabled", false)) continue
            val r = a.optString("realm")
            if (r.isNotEmpty() && r != realm) continue
            best = minOf(best, cooldownRemainMs(a.optString("uid")))
        }
        return if (best == Long.MAX_VALUE) 0 else best
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
                put("last_used", lastPicked[uid] ?: 0L)
                put("inflight", inflight[uid] ?: 0)
                put("request_count", a.optJSONObject("token_usage")?.optInt("request_count", 0) ?: 0)
            })
        }
        return out
    }

    /** 仅供面板手动操作；网关内部不要调用（会影响其它并发请求） */
    fun clearAllCooldowns() {
        cooldownUntil.clear()
    }
}
