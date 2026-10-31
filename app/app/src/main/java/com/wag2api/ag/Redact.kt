package com.wag2api.ag

/**
 * [P3] 日志脱敏：写 logcat / 控制台日志前把令牌、密钥、Cookie 值替换掉。
 * 只做字符串替换，不改业务数据；对非敏感文本是无操作。
 */
object Redact {
    private val RULES: List<Pair<Regex, String>> = listOf(
        // Google access token / refresh token
        Regex("ya29\\.[A-Za-z0-9._\\-]+") to "ya29.***",
        Regex("1//[A-Za-z0-9._\\-]{8,}") to "1//***",
        // Authorization: Bearer xxx
        Regex("(?i)(bearer\\s+)[A-Za-z0-9._~+/=\\-]+") to "$1***",
        // URL / 表单 / JSON 里的 key=、token=、secret= 等
        Regex("(?i)\\b((?:api[_-]?key|key|access[_-]?token|refresh[_-]?token|id[_-]?token|token|client[_-]?secret|code|admin[_-]?key)=)[^&\\s\"']+") to "$1***",
        Regex("(?i)(\"(?:api[_-]?key|access_?token|refresh_?token|id_?token|client_?secret|admin_?key|accessToken|refreshToken)\"\\s*:\\s*\")[^\"]*\"") to "$1***\"",
        // Cookie 值（Google 系 Cookie 名）
        Regex("(?i)\\b((?:__Secure-[A-Za-z0-9_\\-]+|__Host-[A-Za-z0-9_\\-]+|SAPISID|APISID|HSID|SSID|SID|SIDCC|NID|OSID)=)[^;\\s\"']+") to "$1***",
    )

    @JvmStatic
    fun redact(s: String?): String {
        if (s.isNullOrEmpty()) return s ?: ""
        var out: String = s
        for ((re, rep) in RULES) out = re.replace(out, rep)
        return out
    }

    /** 只保留路径，去掉查询串（?key= 可能带管理密钥） */
    @JvmStatic
    fun pathOnly(target: String?): String = (target ?: "").substringBefore('?')
}
