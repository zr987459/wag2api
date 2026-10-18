package com.wag2api.app.engine

import android.content.Context
import com.wag2api.engine.EngineToken

object EngineFactory {
    fun create(ctx: Context): NodeEngineApi = RealNodeEngine(ctx)
    const val SUPPORTS_NODE = true

    /** full 包才拿得到 engine-node 的令牌，注入给宿主侧路由 */
    fun injectToken(ctx: Context) {
        com.wag2api.app.EngineTokenHolder.token = EngineToken.get(ctx)
    }
}
