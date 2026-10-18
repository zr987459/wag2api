package com.wag2api.app.engine

import android.content.Context

object EngineFactory {
    fun create(ctx: Context): NodeEngineApi = NoopNodeEngine()
    const val SUPPORTS_NODE = false
    fun injectToken(ctx: Context) { /* lite 无 Node 引擎 */ }
}
