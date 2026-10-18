package com.wag2api.app.engine

/** lite 包：不含 Node 引擎，状态永远是 OFF */
class NoopNodeEngine : NodeEngineApi {
    override val state = EngineState.OFF
    override val port = 0
    override fun start() {}
    override fun stop() {}
    override fun requestStart() {}
    override fun requestEnd() {}
    override fun awaitIdle(timeoutMs: Long) = true
}
