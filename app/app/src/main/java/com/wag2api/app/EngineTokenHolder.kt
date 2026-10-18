package com.wag2api.app

/**
 * 内部引擎令牌的宿主侧持有者。
 * lite 包没有 engine-node 模块，所以不能直接引用 com.wag2api.engine.EngineToken，
 * 由 GatewayService 在启动时按 flavor 注入。
 */
object EngineTokenHolder {
    @Volatile var token: String = ""
}
