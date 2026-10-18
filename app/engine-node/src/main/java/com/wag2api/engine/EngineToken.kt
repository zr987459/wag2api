package com.wag2api.engine

import android.content.Context
import java.security.SecureRandom

/** 内部引擎令牌：每次安装生成一次，只有宿主知道，用于防止其他 App 直连 Node 端口 */
object EngineToken {
    private const val PREF = "wag2api_engine"
    private const val KEY = "engine_token"

    fun get(ctx: Context): String {
        val sp = ctx.getSharedPreferences(PREF, Context.MODE_PRIVATE)
        sp.getString(KEY, null)?.let { return it }
        val bytes = ByteArray(32).also { SecureRandom().nextBytes(it) }
        val token = bytes.joinToString("") { "%02x".format(it) }
        sp.edit().putString(KEY, token).apply()
        return token
    }
}
