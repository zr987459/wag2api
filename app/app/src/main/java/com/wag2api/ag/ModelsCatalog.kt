package com.wag2api.ag

import org.json.JSONArray
import org.json.JSONObject

/**
 * Standard OpenAI & Anthropic Models Catalog with Fast Tiers（移植自 src/models-catalog.mjs）
 */
object ModelsCatalog {
    private fun model(id: String, name: String, ownedBy: String, maxTokens: Int, reasoning: Boolean = false): JSONObject {
        val o = JSONObject()
            .put("id", id)
            .put("name", name)
            .put("object", "model")
            .put("created", System.currentTimeMillis() / 1000)
            .put("owned_by", ownedBy)
            .put("context_window", 1000000)
            .put("max_tokens", maxTokens)
        if (reasoning) o.put("reasoning", true)
        return o
    }

    @JvmField val MODEL_LIST: JSONArray = JSONArray()
        .put(model("gemini-3.8-flash-fast", "Gemini 3.8 Flash (极速秒出字模式)", "antigravity", 64000))
        .put(model("gemini-3.8-flash-high", "Gemini 3.8 Flash High (深度思考旗舰)", "antigravity", 64000, reasoning = true))
        .put(model("gemini-3.8-flash-medium", "Gemini 3.8 Flash Medium", "antigravity", 64000))
        .put(model("gemini-3.8-flash-tiered", "Gemini 3.8 Flash Tiered", "antigravity", 64000))
        .put(model("claude-sonnet-4-6", "Claude Sonnet 4.6 (高优直连)", "antigravity-3p", 128000))
        .put(model("claude-opus-4-6", "Claude Opus 4.6 (深度规划)", "antigravity-3p", 128000))
        .put(model("claude-haiku-4-5", "Claude Haiku 4.5", "antigravity-3p", 64000))
        .put(model("gemini-2.5-flash", "Gemini 2.5 Flash", "antigravity", 64000))

    @JvmStatic
    fun getModelsResponse(): JSONObject = JSONObject()
        .put("object", "list")
        .put("data", MODEL_LIST)
        .put("models", MODEL_LIST)
}
