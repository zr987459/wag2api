package com.wag2api.app.engine

/** 引擎状态机 */
enum class EngineState { OFF, STARTING, READY, FAILED, DRAINING, STOPPING }

/** 宿主接触 Node 引擎的唯一入口。lite 包给的是空实现。 */
interface NodeEngineApi {
    val state: EngineState
    /** Node 实际监听的内部端口，0 表示未就绪 */
    val port: Int
    fun start()
    fun stop()
    /** 在途请求计数，供 drain 使用 */
    fun requestStart()
    fun requestEnd()
    fun awaitIdle(timeoutMs: Long): Boolean
}
