package com.wag2api.ag

import org.json.JSONArray
import org.json.JSONObject
import java.math.BigDecimal
import java.security.MessageDigest
import java.text.SimpleDateFormat
import java.util.Locale
import java.util.TimeZone

/**
 * Antigravity Cloud Code Constants & Verified Clusters（移植自 src/constants.mjs）
 */
object Constants {
    private fun env(name: String): String? = try { System.getenv(name)?.takeIf { it.isNotEmpty() } } catch (e: Exception) { null }

    @JvmField val ANTIGRAVITY_CLIENT_ID: String = env("ANTIGRAVITY_CLIENT_ID") ?: ("1071006060591-tmhssin2h21lc" + "re235vtolojh4g403ep.apps.googleusercontent.com")
    @JvmField val ANTIGRAVITY_CLIENT_SECRET: String = env("ANTIGRAVITY_CLIENT_SECRET") ?: ("GOCSPX-" + "K58FWR486LdLJ1mLB8sXC4z6qDAf")
    const val CALLBACK_PORT = 51121

    @JvmField val SCOPES: List<String> = listOf(
        "https://www.googleapis.com/auth/cloud-platform",
        "https://www.googleapis.com/auth/userinfo.email",
        "https://www.googleapis.com/auth/userinfo.profile",
        "https://www.googleapis.com/auth/cclog",
        "https://www.googleapis.com/auth/experimentsandconfigs",
    )

    const val GOOGLE_TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token"
    const val GOOGLE_AUTH_ENDPOINT = "https://accounts.google.com/o/oauth2/v2/auth"

    // 核心 Google 集群路由：第一优先级走 daily.sandbox
    const val ANTIGRAVITY_ENDPOINT_DAILY = "https://daily-cloudcode-pa.sandbox.googleapis.com"
    const val ANTIGRAVITY_ENDPOINT_AUTOPUSH = "https://autopush-cloudcode-pa.sandbox.googleapis.com"
    const val ANTIGRAVITY_ENDPOINT_PROD = "https://cloudcode-pa.googleapis.com"

    const val CLOUDCODE_API_ENDPOINT = ANTIGRAVITY_ENDPOINT_PROD
    const val DAILY_API_ENDPOINT = ANTIGRAVITY_ENDPOINT_DAILY

    @JvmField val ANTIGRAVITY_ENDPOINTS: List<String> = listOf(
        ANTIGRAVITY_ENDPOINT_DAILY,
        ANTIGRAVITY_ENDPOINT_AUTOPUSH,
        ANTIGRAVITY_ENDPOINT_PROD,
    )

    const val API_VERSION = "v1internal"
}

/**
 * 与 Node 行为对齐的小工具（M3 自用，其他模块需要字节级兼容时也可直接用）：
 *  - stringify：等价 JSON.stringify（不转义 "/"，整数不带 .0，整数形 key 排在前面）
 *  - truthy / str / number / parseFloat：JS 真值、String()、Number()、parseFloat()
 *  - trim / WS：JS 的空白定义（含 \u00a0、\u3000 等）
 *  - dateParse：Date.parse（ISO 8601 与 RFC 1123）
 */
object JsCompat {
    const val WS_CLASS = "[\\t\\n\\u000B\\f\\r \\u00A0\\u1680\\u2000-\\u200A\\u2028\\u2029\\u202F\\u205F\\u3000\\uFEFF]"
    @JvmField val WS_RUN = Regex("$WS_CLASS+")
    private val TRIM_RE = Regex("^$WS_CLASS+|$WS_CLASS+$")

    fun trim(s: String): String = TRIM_RE.replace(s, "")

    fun isNullish(v: Any?): Boolean = v == null || v == JSONObject.NULL

    fun truthy(v: Any?): Boolean = when (v) {
        null -> false
        JSONObject.NULL -> false
        is Boolean -> v
        is String -> v.isNotEmpty()
        is Double -> !(v == 0.0 || v.isNaN())
        is Float -> !(v == 0f || v.isNaN())
        is Number -> v.toDouble() != 0.0
        else -> true
    }

    /** a || b：返回第一个真值，否则最后一个 */
    fun or(vararg vs: Any?): Any? {
        for (v in vs) if (truthy(v)) return v
        return vs.lastOrNull()
    }

    /** String(v) */
    fun str(v: Any?): String = when (v) {
        null -> "undefined"
        JSONObject.NULL -> "null"
        is String -> v
        is Number -> numberToString(v)
        is Boolean -> v.toString()
        is JSONObject -> "[object Object]"
        is JSONArray -> (0 until v.length()).joinToString(",") { val x = v.opt(it); if (isNullish(x)) "" else str(x) }
        else -> v.toString()
    }

    /** Number(v)（不支持 0x/0b 前缀以外的少见写法时返回 NaN） */
    fun number(v: Any?): Double = when (v) {
        null -> Double.NaN
        JSONObject.NULL -> 0.0
        is Number -> v.toDouble()
        is Boolean -> if (v) 1.0 else 0.0
        is String -> {
            val t = trim(v)
            when {
                t.isEmpty() -> 0.0
                t == "Infinity" || t == "+Infinity" -> Double.POSITIVE_INFINITY
                t == "-Infinity" -> Double.NEGATIVE_INFINITY
                Regex("^0[xX][0-9a-fA-F]+$").matches(t) -> t.substring(2).toLong(16).toDouble()
                Regex("^[+-]?(\\d+\\.?\\d*|\\.\\d+)([eE][+-]?\\d+)?$").matches(t) -> t.toDouble()
                else -> Double.NaN
            }
        }
        else -> Double.NaN
    }

    private val FLOAT_PREFIX = Regex("^[+-]?(\\d+\\.?\\d*|\\.\\d+)([eE][+-]?\\d+)?")

    /** parseFloat(s) */
    fun parseFloat(s: String): Double {
        val t = trim(s)
        if (t.startsWith("Infinity") || t.startsWith("+Infinity")) return Double.POSITIVE_INFINITY
        if (t.startsWith("-Infinity")) return Double.NEGATIVE_INFINITY
        val m = FLOAT_PREFIX.find(t) ?: return Double.NaN
        return m.value.toDouble()
    }

    /** Math.round */
    fun round(d: Double): Long = Math.floor(d + 0.5).toLong()

    fun numberToString(n: Number): String {
        if (n is Int || n is Long || n is Short || n is Byte) return n.toString()
        val d = n.toDouble()
        if (d.isNaN()) return "NaN"
        if (d.isInfinite()) return if (d > 0) "Infinity" else "-Infinity"
        if (d == 0.0) return "0"
        if (d == Math.rint(d) && Math.abs(d) < 1e21) return BigDecimal(d).toPlainString()
        val a = Math.abs(d)
        val s = d.toString()
        if (a >= 1e-6 && a < 1e21) return BigDecimal(s).stripTrailingZeros().toPlainString()
        // 指数形式：1.0E-7 → 1e-7，1.5E22 → 1.5e+22
        val bd = BigDecimal(s).stripTrailingZeros()
        val digits = bd.unscaledValue().abs().toString()
        val exp = digits.length - 1 - bd.scale()
        val mant = if (digits.length == 1) digits else digits[0] + "." + digits.substring(1)
        return (if (d < 0) "-" else "") + mant + "e" + (if (exp >= 0) "+" else "-") + Math.abs(exp)
    }

    private fun isArrayIndex(k: String): Boolean {
        if (k.isEmpty() || k.length > 10) return false
        if (k.length > 1 && k[0] == '0') return false
        for (c in k) if (c !in '0'..'9') return false
        return k.toLong() < 4294967295L
    }

    /** JS 对象的 key 枚举顺序：整数形 key 升序在前，其余保持插入顺序 */
    fun keysInJsOrder(o: JSONObject): List<String> {
        val ints = ArrayList<String>()
        val rest = ArrayList<String>()
        val it = o.keys()
        while (it.hasNext()) {
            val k = it.next()
            if (isArrayIndex(k)) ints.add(k) else rest.add(k)
        }
        if (ints.isEmpty()) return rest
        ints.sortBy { it.toLong() }
        return ints + rest
    }

    /** JSON.stringify(v)；v 为 undefined（null）时返回 null */
    fun stringify(v: Any?): String? {
        if (v == null) return null
        val sb = StringBuilder()
        if (!write(sb, v)) return null
        return sb.toString()
    }

    private fun write(sb: StringBuilder, v: Any?): Boolean {
        when (v) {
            null -> return false
            JSONObject.NULL -> sb.append("null")
            is String -> quote(sb, v)
            is Boolean -> sb.append(v)
            is Number -> {
                val d = v.toDouble()
                if (d.isNaN() || d.isInfinite()) sb.append("null") else sb.append(numberToString(v))
            }
            is JSONObject -> {
                sb.append('{')
                var first = true
                for (k in keysInJsOrder(v)) {
                    val x = v.opt(k)
                    if (x == null) continue
                    val mark = sb.length
                    if (!first) sb.append(',')
                    quote(sb, k)
                    sb.append(':')
                    if (!write(sb, x)) { sb.setLength(mark); continue }
                    first = false
                }
                sb.append('}')
            }
            is JSONArray -> {
                sb.append('[')
                for (i in 0 until v.length()) {
                    if (i > 0) sb.append(',')
                    if (!write(sb, v.opt(i))) sb.append("null")
                }
                sb.append(']')
            }
            is Map<*, *> -> return write(sb, JSONObject(v))
            is Collection<*> -> return write(sb, JSONArray(v))
            else -> quote(sb, v.toString())
        }
        return true
    }

    private const val HEX = "0123456789abcdef"

    fun quote(sb: StringBuilder, s: String) {
        sb.append('"')
        var i = 0
        val n = s.length
        while (i < n) {
            val c = s[i]
            when {
                c == '"' -> sb.append("\\\"")
                c == '\\' -> sb.append("\\\\")
                c == '\b' -> sb.append("\\b")
                c == '\u000C' -> sb.append("\\f")
                c == '\n' -> sb.append("\\n")
                c == '\r' -> sb.append("\\r")
                c == '\t' -> sb.append("\\t")
                c < ' ' -> u4(sb, c)
                Character.isHighSurrogate(c) -> {
                    if (i + 1 < n && Character.isLowSurrogate(s[i + 1])) { sb.append(c).append(s[i + 1]); i++ } else u4(sb, c)
                }
                Character.isLowSurrogate(c) -> u4(sb, c)
                else -> sb.append(c)
            }
            i++
        }
        sb.append('"')
    }

    private fun u4(sb: StringBuilder, c: Char) {
        val x = c.code
        sb.append("\\u").append(HEX[(x shr 12) and 15]).append(HEX[(x shr 8) and 15]).append(HEX[(x shr 4) and 15]).append(HEX[x and 15])
    }

    /** JSON.parse：返回 JSONObject / JSONArray / String / Number / Boolean / JSONObject.NULL */
    fun parse(text: String): Any? = org.json.JSONTokener(text).nextValue()

    /** sha256(seed) 前 8 字节（大端）屏蔽符号位，前缀 "-" */
    fun sid(seed: String): String {
        val d = MessageDigest.getInstance("SHA-256").digest(seed.toByteArray(Charsets.UTF_8))
        var v = 0L
        for (i in 0 until 8) v = (v shl 8) or (d[i].toLong() and 0xff)
        return "-" + (v and Long.MAX_VALUE).toString()
    }

    private val ISO = Regex("^([+-]\\d{6}|\\d{4})(?:-(\\d{2})(?:-(\\d{2}))?)?(?:T(\\d{2}):(\\d{2})(?::(\\d{2})(?:[.,](\\d+))?)?(Z|[+-]\\d{2}:?\\d{2})?)?$")

    /** Date.parse：ISO 8601 与 RFC 1123 / RFC 850 / asctime；无法解析返回 null */
    fun dateParse(s0: String?): Long? {
        if (s0 == null) return null
        val s = trim(s0)
        if (s.isEmpty()) return null
        val m = ISO.find(s)
        if (m != null) {
            try {
                val g = m.groupValues
                val y = g[1].toInt()
                val mo = if (g[2].isEmpty()) 1 else g[2].toInt()
                val d = if (g[3].isEmpty()) 1 else g[3].toInt()
                val hasTime = g[4].isNotEmpty()
                val h = if (hasTime) g[4].toInt() else 0
                val mi = if (hasTime) g[5].toInt() else 0
                val se = if (g[6].isEmpty()) 0 else g[6].toInt()
                val ms = if (g[7].isEmpty()) 0 else (g[7] + "00").substring(0, 3).toInt()
                if (mo !in 1..12 || d !in 1..31 || h > 24 || mi > 59 || se > 59) return null
                val tz = g[8]
                val cal = java.util.GregorianCalendar(TimeZone.getTimeZone("UTC"))
                cal.clear()
                cal.isLenient = true
                cal.set(y, mo - 1, d, h, mi, se)
                cal.set(java.util.Calendar.MILLISECOND, ms)
                var t = cal.timeInMillis
                when {
                    tz == "Z" -> {}
                    tz.isNotEmpty() -> {
                        val sign = if (tz[0] == '-') -1 else 1
                        val digits = tz.substring(1).replace(":", "")
                        val off = digits.substring(0, 2).toInt() * 60 + digits.substring(2).toInt()
                        t -= sign * off * 60000L
                    }
                    hasTime -> t -= TimeZone.getDefault().getOffset(t).toLong() // 有时间无时区：按本地时间
                }
                return t
            } catch (e: Exception) {
                return null
            }
        }
        for (p in arrayOf("EEE, dd MMM yyyy HH:mm:ss zzz", "EEE, d MMM yyyy HH:mm:ss zzz", "EEEE, dd-MMM-yy HH:mm:ss zzz", "EEE MMM d HH:mm:ss yyyy", "EEE, dd MMM yyyy HH:mm:ss Z", "dd MMM yyyy HH:mm:ss zzz")) {
            try {
                val f = SimpleDateFormat(p, Locale.US)
                f.timeZone = TimeZone.getTimeZone("GMT")
                f.isLenient = false
                val pos = java.text.ParsePosition(0)
                val dt = f.parse(s, pos)
                if (dt != null && pos.index == s.length) return dt.time
            } catch (e: Exception) {
            }
        }
        return null
    }
}
