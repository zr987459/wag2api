package com.wag2api.ag

import org.json.JSONArray
import org.json.JSONObject
import java.math.BigDecimal
import java.math.BigInteger
import java.security.MessageDigest
import java.security.SecureRandom
import java.util.Collections
import java.util.UUID
import java.util.WeakHashMap

/**
 * Gemini usageMetadata -> 统一的 token 记账口径（移植自 src/usage.mjs）
 *
 * 本网关统一口径（与 Anthropic 一致）：
 *   input_tokens  = prompt + toolUse - cached      （未命中缓存的输入）
 *   cached_tokens = cached                          （= Anthropic cache_read_input_tokens）
 *   output_tokens = candidates + thoughts           （思考 token 计入输出）
 *   total_tokens  = input + cached + output         （= Gemini totalTokenCount，无重复计算）
 *   cache_hit_rate = cached / (input + cached)       （分母为 0 时为 null）
 */
object Usage {
    private val RAW_KEYS = arrayOf(
        "promptTokenCount", "cachedContentTokenCount", "toolUsePromptTokenCount",
        "candidatesTokenCount", "thoughtsTokenCount", "totalTokenCount"
    )

    /** const n = v => (Number.isFinite(Number(v)) && Number(v) > 0 ? Math.floor(Number(v)) : 0) */
    @JvmStatic
    fun n(v: Any?): Long {
        val d = Js.toNumber(v)
        return if (d.isFinite() && d > 0) Math.floor(d).toLong() else 0L
    }

    @JvmStatic
    fun normalizeGeminiUsage(meta: JSONObject?): JSONObject {
        val m = meta ?: JSONObject()
        val prompt = n(m.opt("promptTokenCount")) + n(m.opt("toolUsePromptTokenCount"))
        val cached = minOf(n(m.opt("cachedContentTokenCount")), prompt)
        val thoughts = n(m.opt("thoughtsTokenCount"))
        val output = n(m.opt("candidatesTokenCount")) + thoughts
        val input = prompt - cached
        return JSONObject()
            .put("input_tokens", input)
            .put("cached_tokens", cached)
            .put("output_tokens", output)
            .put("thoughts_tokens", thoughts)
            .put("total_tokens", input + cached + output)
    }

    /**
     * 流式：usageMetadata 会在多个 chunk 中重复出现，且是【累计值】。
     * 按原始字段取最大值合并（绝不相加），最后再统一 normalize。
     */
    @JvmStatic
    fun mergeRawUsage(prev: JSONObject?, meta: JSONObject?): JSONObject? {
        if (meta == null) return prev
        val out = JSONObject()
        if (prev != null) {
            val it = prev.keys()
            while (it.hasNext()) {
                val k = it.next() as String
                out.put(k, prev.opt(k))
            }
        }
        for (k in RAW_KEYS) {
            if (meta.has(k)) out.put(k, maxOf(n(out.opt(k)), n(meta.opt(k))))
        }
        return out
    }

    /** 分母为 0 时返回 null */
    @JvmStatic
    fun cacheHitRate(input: Number?, cached: Number?): Double? {
        val i = input?.toDouble() ?: 0.0
        val c = cached?.toDouble() ?: 0.0
        val denom = i + c
        return if (denom > 0) c / denom else null
    }

    /** Anthropic usage 对象 */
    @JvmStatic
    fun toAnthropicUsage(u: JSONObject?): JSONObject = JSONObject()
        .put("input_tokens", num(u, "input_tokens"))
        .put("output_tokens", num(u, "output_tokens"))
        .put("cache_read_input_tokens", num(u, "cached_tokens"))
        .put("cache_creation_input_tokens", 0)

    private fun num(u: JSONObject?, k: String): Long {
        val v = u?.opt(k)
        return if (v is Number) v.toLong() else 0L
    }

    // ---- _gw_usage：Node 版用不可枚举属性挂在响应对象上（不会序列化给客户端）。
    // org.json 没有不可枚举属性，这里用按对象身份的弱引用表代替：gwUsage(resp) 取回。
    private val gwUsageMap: MutableMap<JSONObject, JSONObject> = Collections.synchronizedMap(WeakHashMap())

    @JvmStatic
    fun attachGwUsage(target: JSONObject, usage: JSONObject) {
        gwUsageMap[target] = usage
    }

    /** = Node 版 resp._gw_usage（没有时返回 null） */
    @JvmStatic
    fun gwUsage(target: JSONObject?): JSONObject? = if (target == null) null else gwUsageMap[target]
}

/**
 * M1 各转换模块共用的 JS 语义小工具：JSON.stringify 等价输出、JS 真值、JS 空白、随机 id。
 * 目的是让流式 SSE 帧、arguments 字符串、token 估算与 Node 版逐字节一致。
 */
internal object Js {
    /** JS 的 \s / String.prototype.trim 所用空白字符集 */
    const val WS_CLASS = "[\\t\\n\\u000B\\f\\r \\u00A0\\u1680\\u2000-\\u200A\\u2028\\u2029\\u202F\\u205F\\u3000\\uFEFF]"
    val WS_RUN = Regex("$WS_CLASS+")

    private val rnd = SecureRandom()

    fun isWs(c: Char): Boolean = when (c) {
        '\t', '\n', '\u000B', '\u000C', '\r', ' ', '\u00A0', '\u1680', '\u2028', '\u2029', '\u202F', '\u205F', '\u3000', '\uFEFF' -> true
        else -> c in '\u2000'..'\u200A'
    }

    fun trim(s: String): String {
        var a = 0
        var b = s.length
        while (a < b && isWs(s[a])) a++
        while (b > a && isWs(s[b - 1])) b--
        return s.substring(a, b)
    }

    fun trimEnd(s: String): String {
        var b = s.length
        while (b > 0 && isWs(s[b - 1])) b--
        return s.substring(0, b)
    }

    /** JS 真值判断（undefined / null / false / 0 / NaN / '' 为假） */
    fun truthy(v: Any?): Boolean = when (v) {
        null -> false
        JSONObject.NULL -> false
        is Boolean -> v
        is String -> v.isNotEmpty()
        is Number -> {
            val d = v.toDouble()
            d != 0.0 && !d.isNaN()
        }
        else -> true
    }

    /** a || b */
    fun or(a: Any?, b: Any?): Any? = if (truthy(a)) a else b

    /** 取字符串值（不是字符串返回 null） */
    fun str(o: JSONObject?, k: String): String? = o?.opt(k) as? String

    /** Number(v) */
    fun toNumber(v: Any?): Double = when (v) {
        null -> Double.NaN
        JSONObject.NULL -> 0.0
        is Number -> v.toDouble()
        is Boolean -> if (v) 1.0 else 0.0
        is String -> {
            val t = trim(v)
            if (t.isEmpty()) 0.0 else try {
                when {
                    t.startsWith("0x") || t.startsWith("0X") -> t.substring(2).toLong(16).toDouble()
                    t == "Infinity" || t == "+Infinity" -> Double.POSITIVE_INFINITY
                    t == "-Infinity" -> Double.NEGATIVE_INFINITY
                    t.any { it.isLetter() && it != 'e' && it != 'E' } -> Double.NaN
                    else -> t.toDouble()
                }
            } catch (e: Exception) {
                Double.NaN
            }
        }
        else -> Double.NaN
    }

    /** 字符串拼接时的 JS 表示：undefined → "undefined"，null → "null" */
    fun cat(v: Any?): String = when (v) {
        null -> "undefined"
        JSONObject.NULL -> "null"
        is String -> v
        is Number -> numberToString(v)
        is Boolean -> v.toString()
        is JSONObject -> "[object Object]"
        is JSONArray -> (0 until v.length()).joinToString(",") { i ->
            val x = v.opt(i)
            if (x == null || x == JSONObject.NULL) "" else cat(x)
        }
        else -> v.toString()
    }

    fun randomHex(bytes: Int): String {
        val b = ByteArray(bytes)
        rnd.nextBytes(b)
        val sb = StringBuilder(bytes * 2)
        for (x in b) sb.append(String.format("%02x", x.toInt() and 0xff))
        return sb.toString()
    }

    /** crypto.randomUUID().replace(/-/g, '').slice(0, 24) */
    fun uuid24(): String = UUID.randomUUID().toString().replace("-", "").substring(0, 24)

    fun sha1Hex(s: String): String {
        val d = MessageDigest.getInstance("SHA-1").digest(s.toByteArray(Charsets.UTF_8))
        val sb = StringBuilder(40)
        for (x in d) sb.append(String.format("%02x", x.toInt() and 0xff))
        return sb.toString()
    }

    // ---------------------------------------------------------------- JSON.stringify

    /** 与 JS JSON.stringify 相同的输出（不转义 /、不转义非 ASCII、数字格式同 JS） */
    fun stringify(v: Any?): String {
        val sb = StringBuilder()
        write(sb, v)
        return sb.toString()
    }

    private fun write(sb: StringBuilder, v: Any?) {
        when (v) {
            null, JSONObject.NULL -> sb.append("null")
            is String -> quote(sb, v)
            is Boolean -> sb.append(if (v) "true" else "false")
            is Number -> sb.append(numberToJson(v))
            is JSONObject -> {
                sb.append('{')
                var first = true
                val it = v.keys()
                while (it.hasNext()) {
                    val k = it.next() as String
                    val x = v.opt(k)
                    if (x == null) continue
                    if (!first) sb.append(',')
                    first = false
                    quote(sb, k)
                    sb.append(':')
                    write(sb, x)
                }
                sb.append('}')
            }
            is JSONArray -> {
                sb.append('[')
                for (i in 0 until v.length()) {
                    if (i > 0) sb.append(',')
                    write(sb, v.opt(i))
                }
                sb.append(']')
            }
            is Map<*, *> -> write(sb, JSONObject(v))
            is Collection<*> -> write(sb, JSONArray(v))
            else -> quote(sb, v.toString())
        }
    }

    private fun quote(sb: StringBuilder, s: String) {
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
                c < ' ' -> sb.append(String.format("\\u%04x", c.code))
                Character.isHighSurrogate(c) -> {
                    if (i + 1 < n && Character.isLowSurrogate(s[i + 1])) {
                        sb.append(c).append(s[i + 1])
                        i++
                    } else sb.append(String.format("\\u%04x", c.code))
                }
                Character.isLowSurrogate(c) -> sb.append(String.format("\\u%04x", c.code))
                else -> sb.append(c)
            }
            i++
        }
        sb.append('"')
    }

    private fun numberToJson(v: Number): String {
        val d = v.toDouble()
        if ((v is Double || v is Float || v is BigDecimal) && !d.isFinite()) return "null"
        return numberToString(v)
    }

    /** JS Number.prototype.toString(10) */
    fun numberToString(v: Number): String {
        when (v) {
            is Int, is Long, is Short, is Byte, is BigInteger -> return v.toString()
        }
        val d = v.toDouble()
        if (d.isNaN()) return "NaN"
        if (d.isInfinite()) return if (d > 0) "Infinity" else "-Infinity"
        if (d == 0.0) return "0"
        val neg = d < 0
        val bd = BigDecimal(java.lang.Double.toString(Math.abs(d))).stripTrailingZeros()
        val digits = bd.unscaledValue().toString()
        val k = digits.length
        val n = k - bd.scale()
        val body = when {
            n in k..21 -> digits + "0".repeat(n - k)
            n in 1..21 -> digits.substring(0, n) + "." + digits.substring(n)
            n > -6 && n <= 0 -> "0." + "0".repeat(-n) + digits
            else -> {
                val e = n - 1
                val sign = if (e >= 0) "+" else "-"
                if (k == 1) digits + "e" + sign + Math.abs(e)
                else digits[0] + "." + digits.substring(1) + "e" + sign + Math.abs(e)
            }
        }
        return if (neg) "-$body" else body
    }

    /**
     * JSON.parse：先按 RFC 8259 严格校验（org.json 的解析器很宽松，会接受 JSON.parse 拒绝的写法），
     * 失败抛 IllegalArgumentException。返回 JSONObject / JSONArray / String / Number / Boolean / JSONObject.NULL
     */
    fun parse(s: String): Any? {
        StrictJson(s).validate()
        return org.json.JSONTokener(s).nextValue()
    }

    /** parseInt(String(v), 10)；NaN 返回 null */
    fun parseInt10(v: Any?): Long? {
        val s = trim(cat(v))
        var i = 0
        var neg = false
        if (i < s.length && (s[i] == '+' || s[i] == '-')) { neg = s[i] == '-'; i++ }
        val start = i
        while (i < s.length && s[i] in '0'..'9') i++
        if (i == start) return null
        val digits = s.substring(start, i)
        val v2 = digits.toBigInteger().let { if (neg) it.negate() else it }
        return if (v2.bitLength() < 63) v2.toLong() else v2.toDouble().toLong()
    }

    private class StrictJson(private val s: String) {
        private var i = 0

        fun validate() {
            ws()
            value(0)
            ws()
            if (i != s.length) fail()
        }

        private fun fail(): Nothing = throw IllegalArgumentException("Unexpected token in JSON at position $i")

        private fun ws() {
            while (i < s.length && (s[i] == ' ' || s[i] == '\t' || s[i] == '\n' || s[i] == '\r')) i++
        }

        private fun value(depth: Int) {
            if (depth > 2000 || i >= s.length) fail()
            when (s[i]) {
                '{' -> {
                    i++; ws()
                    if (i < s.length && s[i] == '}') { i++; return }
                    while (true) {
                        ws()
                        if (i >= s.length || s[i] != '"') fail()
                        string()
                        ws()
                        if (i >= s.length || s[i] != ':') fail()
                        i++; ws()
                        value(depth + 1)
                        ws()
                        if (i < s.length && s[i] == ',') { i++; continue }
                        if (i < s.length && s[i] == '}') { i++; return }
                        fail()
                    }
                }
                '[' -> {
                    i++; ws()
                    if (i < s.length && s[i] == ']') { i++; return }
                    while (true) {
                        ws()
                        value(depth + 1)
                        ws()
                        if (i < s.length && s[i] == ',') { i++; continue }
                        if (i < s.length && s[i] == ']') { i++; return }
                        fail()
                    }
                }
                '"' -> string()
                't' -> lit("true")
                'f' -> lit("false")
                'n' -> lit("null")
                else -> number()
            }
        }

        private fun lit(w: String) {
            if (!s.startsWith(w, i)) fail()
            i += w.length
        }

        private fun string() {
            i++ // "
            while (true) {
                if (i >= s.length) fail()
                val c = s[i]
                when {
                    c == '"' -> { i++; return }
                    c == '\\' -> {
                        i++
                        if (i >= s.length) fail()
                        when (s[i]) {
                            '"', '\\', '/', 'b', 'f', 'n', 'r', 't' -> i++
                            'u' -> {
                                                                for (k in 1..4) {
                                    if (i + k >= s.length) fail()
                                    val h = s[i + k]
                                    if (!(h in '0'..'9' || h in 'a'..'f' || h in 'A'..'F')) fail()
                                }
                                i += 5
                            }
                            else -> fail()
                        }
                    }
                    c < ' ' -> fail()
                    else -> i++
                }
            }
        }

        private fun number() {
            if (i < s.length && s[i] == '-') i++
            if (i >= s.length) fail()
            if (s[i] == '0') i++
            else if (s[i] in '1'..'9') { while (i < s.length && s[i] in '0'..'9') i++ }
            else fail()
            if (i < s.length && s[i] == '.') {
                i++
                val st = i
                while (i < s.length && s[i] in '0'..'9') i++
                if (i == st) fail()
            }
            if (i < s.length && (s[i] == 'e' || s[i] == 'E')) {
                i++
                if (i < s.length && (s[i] == '+' || s[i] == '-')) i++
                val st = i
                while (i < s.length && s[i] in '0'..'9') i++
                if (i == st) fail()
            }
        }
    }

    /** JSON 值的浅拷贝（对象展开 {...o}） */
    fun spread(vararg objs: JSONObject?): JSONObject {
        val out = JSONObject()
        for (o in objs) {
            if (o == null) continue
            val it = o.keys()
            while (it.hasNext()) {
                val k = it.next() as String
                out.put(k, o.opt(k))
            }
        }
        return out
    }
}
