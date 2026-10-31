package com.wag2api.app.engine

import android.content.Context
import java.security.SecureRandom

/**
 * v2：只有一个包、没有 Node。AG 引擎是进程内的 Kotlin 实现 [com.wag2api.ag.KotlinAgEngine]。
 * （原 full/lite 两份 EngineFactory 合并到 main；内部令牌逻辑从已删除的 engine-node 模块移过来，
 *  SharedPreferences 名和键不变，老用户升级后令牌保持一致。）
 */
object EngineFactory {
    /** v2 永远带 AG 引擎；EngineRouter / LocalGatewayServer 仍读这个常量 */
    const val SUPPORTS_NODE = true

    private const val PREF = "wag2api_engine"
    private const val KEY = "engine_token"

    fun create(ctx: Context, tokenProvider: () -> String): NodeEngineApi =
        com.wag2api.ag.KotlinAgEngine(ctx, tokenProvider)

    fun create(ctx: Context): NodeEngineApi {
        val app = ctx.applicationContext
        return create(app) { token(app) }
    }

    /** 内部引擎令牌：每次安装生成一次，只有宿主知道，用于防止其他 App 直连内部 AG 端口 */
    @Synchronized
    fun token(ctx: Context): String {
        val sp = ctx.getSharedPreferences(PREF, Context.MODE_PRIVATE)
        sp.getString(KEY, null)?.let { return it }
        val bytes = ByteArray(32).also { SecureRandom().nextBytes(it) }
        val t = bytes.joinToString("") { "%02x".format(it) }
        sp.edit().putString(KEY, t).commit()
        return t
    }

    /** 把令牌注入给宿主侧路由（EngineRouter.proxyToNode 用） */
    fun injectToken(ctx: Context) {
        com.wag2api.app.EngineTokenHolder.token = token(ctx.applicationContext)
    }
}
