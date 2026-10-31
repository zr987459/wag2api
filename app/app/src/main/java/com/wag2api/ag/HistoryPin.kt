package com.wag2api.ag

import org.json.JSONArray
import org.json.JSONObject

/**
 * 历史锁定（移植自 src/history-pin.mjs）：部分客户端会在后续请求中改写旧的工具调用参数/工具结果（裁剪、去重、"[内容已清除]"），
 * 让请求前缀与上游已缓存的版本不一致。这里按 key 记住第一次见到的内容，之后同一 key 一律按原样转发，保证前缀稳定。
 * 默认开启，HISTORY_PIN=0 关闭。
 *
 * 安全约束（v1.3.4）：只在客户端带了真实会话 id 时启用（ContentConverter 判断）；
 * 模型回复 / 首条提示 / 系统提示 / 工具声明用 pinIf：只有"同一内容的轻微改写"才还原。
 *
 * 存储：字符串直接存原串；对象存 JSON 文本（与 JSON.stringify 一致），首次命中时解析一次并缓存，之后返回同一个对象
 * （调用方不要改写返回的对象，Node 版对它做了深度冻结）。
 */
class HistoryPin {
    private class Entry(val str: String?, val json: String?, var exp: Long) {
        var obj: Any? = null
    }

    private val map = LinkedHashMap<String, Entry>()
    private var bytes = 0L
    private var hits = 0
    private var overwrites = 0
    @Volatile var active = true

    private fun entrySize(e: Entry): Long {
        if (e.str != null) return e.str.length.toLong()
        return e.json!!.length.toLong() * (if (e.obj == null) 1 else 2)
    }

    private fun parsedOf(e: Entry): Any? {
        if (e.obj == null) {
            e.obj = JsCompat.parse(e.json!!)
            bytes += e.json.length // 解析后的对象另占内存，按同等大小计入上限
        }
        return e.obj
    }

    /** 命中时返回第一次见到的内容；未命中则记住并原样返回。 */
    @Synchronized
    fun pin(key: String?, value: Any?): Any? {
        if (!ENABLED || !active || key.isNullOrEmpty()) return value
        val now = System.currentTimeMillis()
        val old = map[key]
        if (old != null && old.exp > now) {
            old.exp = now + TTL_MS
            if (old.str != null) {
                if (value !is String || value != old.str) hits++
                return old.str
            }
            if (old.json != JsCompat.stringify(value)) hits++
            return parsedOf(old)
        }
        if (old != null) bytes -= entrySize(old)
        map.remove(key)
        val entry = if (value is String) Entry(value, null, now + TTL_MS) else Entry(null, JsCompat.stringify(value) ?: "null", now + TTL_MS)
        map[key] = entry
        bytes += entrySize(entry)
        evict(now)
        return value
    }

    /** 带校验的锁定：命中且 same(旧值, 新值) 为真才返回旧值；否则用新值覆盖旧记录并原样返回新值。 */
    @Synchronized
    fun pinIf(key: String?, value: Any?, same: (Any?, Any?) -> Boolean): Any? {
        if (!ENABLED || !active || key.isNullOrEmpty()) return value
        val now = System.currentTimeMillis()
        val old = map[key]
        if (old != null && old.exp > now) {
            val prev: Any? = old.str ?: parsedOf(old)
            val keep = try { same(prev, value) } catch (e: Exception) { false }
            if (keep) {
                old.exp = now + TTL_MS
                if (if (old.str != null) prev != value else old.json != JsCompat.stringify(value)) hits++
                return prev
            }
            bytes -= entrySize(old)
            map.remove(key)
            overwrites++
        }
        return pin(key, value)
    }

    private fun evict(now: Long) {
        val it = map.entries.iterator()
        while (it.hasNext()) {
            val e = it.next()
            if (bytes <= MAX_BYTES && e.value.exp > now) break
            it.remove()
            bytes -= entrySize(e.value)
        }
    }

    @Synchronized
    fun stats(): JSONObject = JSONObject()
        .put("enabled", ENABLED)
        .put("entries", map.size)
        .put("bytes", bytes)
        .put("restored", hits)
        .put("overwritten", overwrites)

    companion object {
        @JvmField val ENABLED: Boolean = System.getenv("HISTORY_PIN") != "0"
        private const val TTL_MS = 6 * 60 * 60 * 1000L
        // Node 版 150MB；安卓按合同第 6 条省内存，默认 24MB（HISTORY_PIN_MAX_MB 可调）
        private val MAX_BYTES: Long = (System.getenv("HISTORY_PIN_MAX_MB")?.toLongOrNull() ?: 24L) * 1024 * 1024

        /** 全局单例（对应 export const historyPin） */
        @JvmField val historyPin = HistoryPin()

        // ---- 校验函数 ----
        private fun norm(t: Any?): String {
            val s = if (JsCompat.isNullish(t)) "" else JsCompat.str(t)
            return JsCompat.trim(JsCompat.WS_RUN.replace(s.replace("\r\n", "\n"), " "))
        }

        /** 文本近似相同：归一化空白后相等，或公共前缀 + 公共后缀覆盖较长串的 90% 以上。 */
        @JvmStatic
        fun nearSameText(a: Any?, b: Any?): Boolean {
            val x = norm(a)
            val y = norm(b)
            if (x == y) return true
            val max = Math.max(x.length, y.length)
            if (max == 0) return true
            if (Math.min(x.length, y.length).toDouble() / max < 0.9) return false
            var p = 0
            while (p < x.length && p < y.length && x[p] == y[p]) p++
            var s = 0
            while (s < x.length - p && s < y.length - p && x[x.length - 1 - s] == y[y.length - 1 - s]) s++
            return (p + s).toDouble() / max >= 0.9
        }

        private fun vis(ps: Any?): String {
            val arr = ps as? JSONArray ?: return ""
            val out = ArrayList<String>()
            for (i in 0 until arr.length()) {
                val p = arr.opt(i)
                if (!JsCompat.truthy(p)) continue
                val o = p as? JSONObject
                if (o != null && JsCompat.truthy(o.opt("thought"))) continue
                val fc = o?.opt("functionCall")
                val fr = o?.opt("functionResponse")
                val inl = o?.opt("inlineData")
                val s = when {
                    JsCompat.truthy(fc) -> {
                        val f = fc as? JSONObject
                        val name = f?.opt("name")
                        val args = f?.opt("args").let { if (JsCompat.isNullish(it)) JSONObject() else it }
                        "fc:" + JsCompat.stringify(JSONArray().put(name ?: JSONObject.NULL).put(args))
                    }
                    JsCompat.truthy(fr) -> "fr:" + JsCompat.str((fr as? JSONObject)?.opt("name"))
                    JsCompat.truthy(inl) -> {
                        val d = (inl as? JSONObject)?.opt("data")
                        "img:" + (if (JsCompat.truthy(d)) JsCompat.str(d) else "").length
                    }
                    else -> norm(o?.opt("text"))
                }
                if (s.isNotEmpty()) out.add(s)
            }
            return out.joinToString("\n")
        }

        /** 模型回复可见内容（剔除 thought 与签名）一致：只允许还原被客户端剥掉/降级的思考块与签名。 */
        @JvmStatic
        fun sameVisibleParts(a: Any?, b: Any?): Boolean = vis(a) == vis(b)

        private fun names(fs: Any?): String {
            val arr = fs as? JSONArray ?: return ""
            val l = ArrayList<String>()
            for (i in 0 until arr.length()) {
                val n = (arr.opt(i) as? JSONObject)?.opt("name")
                l.add(if (JsCompat.truthy(n)) JsCompat.str(n) else "")
            }
            l.sort()
            return l.joinToString(",")
        }

        /** 工具声明：工具名集合相同才还原（只吸收描述/参数的微调）。 */
        @JvmStatic
        fun sameToolNames(a: Any?, b: Any?): Boolean = names(a) == names(b)

        private val TRIM_WORDS = Regex("清除|省略|截断|已移除|truncat|omit|clear|remov|elided", RegexOption.IGNORE_CASE)

        /** 工具结果：仅当新内容像是被裁剪/清除时才还原。 */
        @JvmStatic
        fun looksTrimmed(prev: Any?, cur: Any?): Boolean {
            if (prev !is String || cur !is String) return false
            if (cur == prev) return true
            if (cur.length < prev.length) return true
            return cur.length <= 200 && TRIM_WORDS.containsMatchIn(cur)
        }
    }
}
