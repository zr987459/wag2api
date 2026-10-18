# streamChat 重试/调度 JVM 回归测试（宿主外跑，不进 Gradle）

用 MockWebServer 模拟上游，验证：
- T1 429 只换号，不在被限流账号上再打 /console
- T2 流中途断开不重放（无重复输出），错误上抛
- T3 所有账号持续 429 时有限时间内结束（不再无限递归）
- T4 401 → POST /v2/plugin/auth/token/refresh（X-Refresh-Token）→ 同账号新 token 重试
- T5 并发 acquire 均摊到不同账号
- T6 file-backed 账号 setDisabled / updateTokens 保留 refreshToken

运行：kotlinc stubs + AccountVault/AccountScheduler/TokenKeeper/TencentGateway + Main.kt，
classpath: okhttp 4.12, okio 3.6, org.json, mockwebserver 4.12；
测试前把 TencentGateway.UPSTREAM_GLOBAL 替换为 http://127.0.0.1:18555 。
结果：修复版 13/13 通过；原 main@3bc4d22 8 项失败（T3 25s 后仍在跑，上游被打 42 次）。
