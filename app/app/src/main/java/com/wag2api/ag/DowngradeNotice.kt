package com.wag2api.ag

import org.json.JSONArray
import org.json.JSONObject

/**
 * PR1：降级提示行（移植自 src/downgrade-notice.mjs）。插入在响应正文第一个 text block 最前面；
 * 客户端回传历史时由 ContentConverter 精确剔掉。
 */
object DowngradeNotice {
    const val DOWNGRADE_NOTICE_PREFIX = "⚠️ 已降级："

    @JvmField val DOWNGRADE_REASON_LABELS: Map<String, String> = linkedMapOf(
        "quota_all_accounts" to "所有账号配额冷却中",
        "quota" to "配额不足",
        "upstream_5xx" to "上游 5xx",
        "timeout" to "上游超时",
        "network" to "网络错误",
        "auth" to "账号凭据失效",
        "unknown" to "未知错误",
    )

    @JvmStatic
    fun buildDowngradeNotice(requested: String?, used: String?, reason: String?): String {
        val label = DOWNGRADE_REASON_LABELS[reason ?: ""]?.takeIf { it.isNotEmpty() } ?: JsCompat.str(reason)
        return "$DOWNGRADE_NOTICE_PREFIX${JsCompat.str(requested)} → ${JsCompat.str(used)}（原因：$label；降级模型无前缀缓存）\n\n"
    }

    /** 剔掉 assistant 历史开头由网关插入的提示行（固定前缀精确匹配），剔完与从未插入时字节一致 */
    @JvmStatic
    fun stripDowngradeNotice(text: String?): String? {
        if (text == null || !text.startsWith(DOWNGRADE_NOTICE_PREFIX)) return text
        val i = text.indexOf("\n\n")
        if (i >= 0) return text.substring(i + 2)
        val j = text.indexOf('\n')
        return if (j >= 0) text.substring(j + 1) else ""
    }

    private val JSON_RE = Regex("json", RegexOption.IGNORE_CASE)

    /** 带 tools 或要求 JSON 输出时不插提示行（只靠 message.model / 响应头 / 统计） */
    @JvmStatic
    @JvmOverloads
    fun shouldInsertNotice(anthropicReq: JSONObject?, env: Map<String, String> = sysEnv()): Boolean {
        val dn = env["DOWNGRADE_NOTICE"]
        if (dn == "0" || dn == "false") return false
        val tools = anthropicReq?.opt("tools")
        if (tools is JSONArray && tools.length() > 0) return false
        val oc = anthropicReq?.opt("output_config")
        val fmt = JsCompat.or(anthropicReq?.opt("output_format"), anthropicReq?.opt("response_format"), (oc as? JSONObject)?.opt("format"), null)
        if (JsCompat.truthy(fmt) && JSON_RE.containsMatchIn(JsCompat.stringify(fmt) ?: "")) return false
        return true
    }

    private fun sysEnv(): Map<String, String> = try { System.getenv() } catch (e: Exception) { emptyMap() }
}
