package com.wag2api.app

import org.json.JSONArray
import org.json.JSONObject

/** 腾讯 WorkBuddy 官方真实模型清单（含真实官方倍率标注） */
object WbModels {

    fun list(): JSONArray = JSONArray().apply {
        fun m(id: String, name: String, credits: String? = null, images: Boolean = true, reasoning: Boolean = false) {
            put(JSONObject().apply {
                put("id", id); put("name", name); put("object", "model")
                credits?.let { put("credits", it) }
                put("supports_images", images)
                put("supports_reasoning", reasoning)
            })
        }
        m("deepseek-v4.1-flash-1017", "DeepSeek-V4.1-Flash-1017 [0.00x 限免免费 · 多模态+思考]", "0.00x (Free)", true, true)
        m("global:deepseek-v4.1-flash-1017", "DeepSeek-V4.1-Flash-1017 (Global) [0.00x 限免免费]", "0.00x (Free)", true, true)
        m("deepseek-v4.1-flash", "DeepSeek-V4.1-Flash [0.00x 限免免费]", "0.00x (Free)", true, true)
        m("global:deepseek-v4.1-flash", "DeepSeek-V4.1-Flash (Global) [0.00x 限免免费]", "0.00x (Free)", true, true)
        m("hy4-preview", "Hy4-Preview [0.00x 限免免费 · 混元深度思考]", "0.00x (Free)", true, true)
        m("hy3", "Hy3 [0.00x 限免免费]", "0.00x (Free)", true, true)
        m("gpt-6-astra", "GPT-6-Astra [6.67x · 国际版专属顶级旗舰]", "6.67x", true, true)
        m("gpt-5.6-sol", "GPT-5.6-Sol [国际版专属]", null, true)
        m("gpt-5.4", "GPT-5.4 [国际版原生多模态]", null, true)
        m("grok-4.7", "Grok-4.7 [国际版专属]", null, false)
        m("gemini-3.5-flash", "Gemini-3.5-Flash [国际版原生多模态]", null, true)
        m("glm-5.3-flash", "GLM-5.3-Flash [极低消耗]", null, true, true)
        m("glm-5.3", "GLM-5.3 [最新旗舰]", null, true, true)
        m("glm-5.2", "GLM-5.2 [1M 长上下文]", null, true, true)
        m("kimi-k3", "Kimi-K3 [长文本深度推理]", null, true, true)
        m("kimi-k2.8-preview", "Kimi-K2.8-Preview [深度推理]", null, true, true)
        m("claude-3.7-sonnet", "Claude-3.7-Sonnet (官方映射 default-1.1)", null, true)
        m("claude-4.0-sonnet", "Claude-4.0-Sonnet (官方映射 default-1.2)", null, true)
        m("auto", "Auto [自动智能调度]", null, false)
    }
}
