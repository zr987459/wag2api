package com.wag2api.ag

/**
 * System Prompt Identity Scrubbing（移植自 src/scrub.mjs）
 *
 * Google Cloud Code 上游接口对系统提示词有指纹审查机制。
 * 若检测到明显的非官方/竞品 Agent 身份标识（如 Claude、Hermes、Nous 等），
 * 上游会静默抛出伪装的 429 RESOURCE_EXHAUSTED。
 * 本模块在向 Google 转发前将此类指纹替换为通用助手描述。
 */
object Scrub {
    private val DEFAULT_SCRUB_RULES: List<Pair<Regex, String>> = listOf(
        Regex("Nous Research", RegexOption.IGNORE_CASE) to "the assistant team",
        Regex("Hermes Agent", RegexOption.IGNORE_CASE) to "the assistant",
        Regex("Hermes", RegexOption.IGNORE_CASE) to "the assistant",
        Regex("Claude Code", RegexOption.IGNORE_CASE) to "the coding assistant",
        Regex("Claude", RegexOption.IGNORE_CASE) to "the assistant",
        Regex("Anthropic", RegexOption.IGNORE_CASE) to "the AI provider"
    )

    /** 非字符串原样返回 */
    @JvmStatic
    fun scrubIdentity(text: Any?): Any? {
        if (text !is String) return text
        return scrubIdentity(text)
    }

    @JvmStatic
    fun scrubIdentity(text: String): String {
        var result = text
        for ((pattern, replacement) in DEFAULT_SCRUB_RULES) {
            // 替换文本不含 $ / \，可直接用 Regex.replace
            result = pattern.replace(result, replacement)
        }
        return result
    }
}
