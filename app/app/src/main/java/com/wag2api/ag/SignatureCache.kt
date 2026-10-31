package com.wag2api.ag

import org.json.JSONObject
import java.io.File
import java.util.concurrent.ScheduledFuture

/**
 * 移植自 src/signature-cache.mjs
 *
 * Thought Signature & Tool Call Registry：记住每个工具调用 id 对应的 thought_signature 与工具名，
 * 下游回传 tool_result 时缝合回去；持久化到 DATA_DIR/signatures.json（格式与 Node 版一致：
 * {callId: {signature, name, expireAt}}），找不到时用合法兜底签名。
 */
class SignatureCache(val ttlMs: Long = 24 * 60 * 60 * 1000L, val maxSize: Int = 3000) {
    /** callId → {signature, name, expireAt}，插入顺序 = 淘汰顺序 */
    private val cache = LinkedHashMap<String, JSONObject>()
    private val persistFile: File = File(AgPaths.dataDir.toString(), "signatures.json")
    private var pendingSave: ScheduledFuture<*>? = null

    init {
        load()
    }

    @Synchronized
    fun load() {
        try {
            if (persistFile.exists()) {
                val raw = M2Json.parse(persistFile.readText(Charsets.UTF_8)) as? JSONObject ?: return
                val now = System.currentTimeMillis()
                for (k in raw.keys()) {
                    val v = raw.optJSONObject(k) ?: continue
                    val exp = v.opt("expireAt")
                    if (exp is Number && exp.toDouble() > now) cache[k] = v
                }
            }
        } catch (_: Exception) {}
    }

    /** 立即写盘 */
    fun save() {
        val text: String
        synchronized(this) {
            pendingSave = null
            val obj = JSONObject()
            for ((k, v) in cache) obj.put(k, v)
            text = M2Json.stringify(obj)
        }
        try {
            M2Json.writeFile(persistFile, text)
        } catch (_: Exception) {}
    }

    /** 请求线程里不做整文件写盘：合并到 1 秒后写一次（内容与逐次写相同） */
    private fun scheduleSave() {
        synchronized(this) {
            if (pendingSave != null) return
            pendingSave = M2Exec.later(1000) { save() }
        }
    }

    fun set(callId: String?, signature: String?, name: String? = "") {
        if (callId.isNullOrEmpty()) return
        cleanup()
        synchronized(this) {
            if (cache.size >= maxSize && !cache.containsKey(callId)) {
                val oldest = cache.keys.iterator().next()
                cache.remove(oldest)
            }
            // Map.set 对已有 key 不改变顺序
            cache[callId] = JSONObject()
                .put("signature", if (signature.isNullOrEmpty()) FALLBACK_THOUGHT_SIGNATURE else signature)
                .put("name", name ?: "")
                .put("expireAt", System.currentTimeMillis() + ttlMs)
        }
        scheduleSave()
    }

    @Synchronized
    fun get(callId: String?): String {
        if (callId.isNullOrEmpty()) return FALLBACK_THOUGHT_SIGNATURE
        val entry = cache[callId] ?: return FALLBACK_THOUGHT_SIGNATURE
        if (System.currentTimeMillis() > entry.optLong("expireAt", 0)) {
            cache.remove(callId)
            return FALLBACK_THOUGHT_SIGNATURE
        }
        val sig = entry.optString("signature", "")
        return if (sig.isEmpty()) FALLBACK_THOUGHT_SIGNATURE else sig
    }

    @Synchronized
    fun getName(callId: String?): String {
        if (callId.isNullOrEmpty()) return ""
        val entry = cache[callId] ?: return ""
        val n = entry.opt("name")
        return if (n is String) n else ""
    }

    fun cleanup() {
        var changed = false
        synchronized(this) {
            val now = System.currentTimeMillis()
            val it = cache.entries.iterator()
            while (it.hasNext()) {
                val e = it.next()
                if (now > e.value.optLong("expireAt", 0)) { it.remove(); changed = true }
            }
        }
        if (changed) scheduleSave()
    }

    @Synchronized
    fun size(): Int = cache.size

    companion object {
        /** Google 官方认证有效的合法思考签名兜底数据 (Base64) */
        const val FALLBACK_THOUGHT_SIGNATURE =
            "Ep4DCpsDAWkUfRPMXRY1Nr/Bc9gU+E+ZC+EvFegUic8lBiObBzAqrkyCng1WzxqB2QrZyDn9xVyUwfMTu6Rn++0jI9z+ak/n/KBhoOg4nu4tue3eZbMDQ07d81AXSl6wmgW/2Ynf7vU66bEsm0V6vRPhsuXLuVeWO1EtqwKcSsAD1JkSbJALtdhd1WPhwxdVkYVLoxGUUK8iE5l5ugsFrPPTkzmwz1EfBLIsD5FUiZ8i8pAujAlWn2i2IelwM7lAaoM9lg+KLBuxtUuGR8hlttbFrwUDn+vdw+rn3/OBAEgcRNNbXq/dimSU6BcJ7l2TLZbArcCyNj5HqEQRtUVHTxnTW6ZsiUsjPXn6KXWBxsTP4cCZgcjZtRrvCgkgc/svb6ckkfk8V4eiCIOWkfUJrcTAmJj99NZ4ypPwKftiPoK6BZvX7nDXMTthtUUrrl2RXhJSl/BUUDeU1KpSiXwSDj+4+bb+9xfcT1lD1nxn2hcxGk84gvs1nmSbihCfCER48J8583wsdKEzUyeLf0tpmNcNEJUlzsFAU1JCjeEdYqSF"

        /** 全局单例（首次使用时从 AgPaths.dataDir 加载，须在 KotlinAgEngine.start() 初始化数据目录之后） */
        @JvmStatic val signatureCache: SignatureCache by lazy { SignatureCache() }
    }
}

/** 与 mjs 导出名一致 */
const val FALLBACK_THOUGHT_SIGNATURE: String = SignatureCache.FALLBACK_THOUGHT_SIGNATURE
val signatureCache: SignatureCache get() = SignatureCache.signatureCache
