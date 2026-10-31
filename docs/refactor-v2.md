# wag2api v2 轻量化重构 · 分工合同

分支：`refactor/v2`（从 main b21d634 拉出）。所有人只往这个分支提交，提交前先拉最新，只提交自己负责的文件，提交信息以自己的编号开头（如 `[M1]`）。main 不动，用户测试通过后才合并。

## 目标
- 现状：v1.3.9 装完占用约 203MB，full APK 55.8MB（其中约 50MB 是 nodejs-mobile 运行时 + 解压出来的 src），运行时多一个 Node 进程（V8 常驻几十到上百 MB 内存）。
- 目标：**一个 APK、没有 Node**。AG 引擎用 Kotlin 在主进程内重写，AIS 引擎（Go .so）保留。安装包目标 ≤ 10MB，装完占用 ≤ 30MB，空闲常驻内存尽量低。
- 功能对齐：客户端看到的 API（`/v1/messages`、`/v1/chat/completions`、`/v1/models`、`/health`）和控制台用到的 `/api/*`、`/panel/api/*` 接口**行为不变**，现有 Web 控制台（assets/web）不用改就能用。

## 关键设计：Kotlin AG 引擎 = 进程内的“小 Node”
- 新建包 `com.wag2api.ag`（目录 `app/app/src/main/java/com/wag2api/ag/`）。
- `KotlinAgEngine` 实现现有接口 `com.wag2api.app.engine.NodeEngineApi`：`start()` 时在 `127.0.0.1` 随机端口起一个进程内 HTTP 服务（复用 `LocalGatewayServer` 的手写 socket 方式，或 `com.sun.net.httpserver` 不可用就手写），提供与 `src/server.mjs` **完全相同的路由和返回**。这样 `EngineRouter.proxyToNode` 和控制台都不用改。
- 端口和鉴权 token 沿用 `EngineTokenHolder`（Node 版要求的内部 token 头照旧校验）。

## 移植规则（所有移植者都遵守）
1. **一对一**：`src/xxx.mjs` → `com/wag2api/ag/Xxx.kt`（帕斯卡命名，如 `account-pool.mjs` → `AccountPool.kt`）。模块导出的函数/类保持原名（camelCase），放进同名 `object`（类就保留 class）。需要别的模块的东西，就按对方 mjs 的导出名直接调用，别人在同时写。
2. **JSON 一律用 `org.json.JSONObject/JSONArray`**（系统自带，零依赖）。请求体、响应体、存盘格式与 Node 版**字节级兼容**（同样的字段名），老用户的数据目录能直接读。
3. **网络**：用已有的 OkHttp（`com.squareup.okhttp3:okhttp`），全局只建一个 `OkHttpClient`，放在 `UpstreamFetch.client`。流式响应逐行读，不要整段读进内存。
4. **并发**：不用协程，用普通线程 + `java.util.concurrent`（同步阻塞调用，在请求线程里跑）。共享状态用 `ConcurrentHashMap`/`@Synchronized`。
5. **数据目录**：`AgPaths.dataDir`（= `context.filesDir/ag`，由 `KotlinAgEngine.start()` 初始化）。Node 版 `DATA_DIR` 下的文件名保持不变；首次启动若发现旧 Node 目录（`filesDir/nodejs-project` 或 Node 版用的目录），把账号/设置/统计迁移过来，然后删除旧的 Node 运行时文件释放空间。
6. **省内存**：日志、请求记录、统计明细都用**有上限的环形缓冲**（默认 200 条），统计按小时/天聚合后再存盘；不缓存整段请求/响应体；大字符串不重复拷贝。
7. **只移植安卓需要的**：`persist.mjs`（GitHub state 分支同步，Linux 专用）、`host-bench.mjs`、`prewarm.mjs`、`cache-probe.mjs`、`test-runner.mjs` 不移植；server.mjs 里对应的路由返回 `{"ok":false,"error":"not supported on android"}`（控制台不会崩）。
8. 不新增第三方依赖。Kotlin 字符串注意转义。写不清的地方在回复【问题】里说明，不要卡住。

## 分工
| 编号 | 负责文件（只改这些） | 来源 |
|---|---|---|
| M1 协议转换 | `ag/ContentConverter.kt` `ag/OpenaiAgConverter.kt` `ag/SchemaSanitizer.kt` `ag/SseStreamer.kt` `ag/TokenEstimate.kt` `ag/Usage.kt` `ag/Scrub.kt` | 同名 mjs |
| M2 账号与鉴权 | `ag/AccountPool.kt` `ag/TokenManager.kt` `ag/OauthFlow.kt` `ag/AgImport.kt` `ag/AccessControl.kt` `ag/SignatureCache.kt` `ag/DbVault.kt` | 同名 mjs |
| M3 上游请求 | `ag/Cloudcode.kt` `ag/UpstreamFetch.kt` `ag/UpstreamPolicy.kt` `ag/DowngradeNotice.kt` `ag/Constants.kt` `ag/ModelsCatalog.kt` `ag/SessionRouter.kt` `ag/HistoryPin.kt` | 同名 mjs |
| M4 额度与统计 | `ag/QuotaFetcher.kt` `ag/QuotaRefresher.kt` `ag/AccountTester.kt` `ag/Stats.kt` | 同名 mjs（Stats 要按第 6 条瘦身） |
| M5 构建瘦身 | `app/settings.gradle.kts` `app/app/build.gradle.kts` `app/app/proguard-rules.pro` `AndroidManifest.xml` `.github/workflows/build.yml` `GatewayService.kt` `AisEngine.kt`，删除 `app/engine-node/`、`app/app/src/full`、`app/app/src/lite`、旧工程 `android/`、`app/linux/` | 见下 |
| M6 集成（第二阶段） | `ag/KotlinAgEngine.kt` `ag/AgServer.kt` `ag/AgPaths.kt`，`engine/EngineFactory.kt`，把 server.mjs 的全部路由接上，修编译 | server.mjs |
| R 审查（第三阶段） | 全新上下文审查并直接修 | — |

### M5 细节
- 去掉 `full`/`lite` flavor 和 `:engine-node` 模块，只出一个 `wag2api.apk`；`EngineFactory` 移到 `main` 返回 `KotlinAgEngine`（M6 会实现该类，M5 先写好 `EngineFactory.create(ctx, tokenProvider) = com.wag2api.ag.KotlinAgEngine(ctx, tokenProvider)`）。
- release 开 `isMinifyEnabled = true`、`isShrinkResources = true`，补好 keep 规则（org.json 反射无需 keep；保留 Service/Receiver 由 AGP 自动处理）。
- `jniLibs.useLegacyPackaging = false`，Manifest 去掉 `extractNativeLibs="true"`（.so 直接从 APK 映射，不再解压一份）。
- 检查 appcompat/material 是否真的需要；只用到少量 UI 就换成平台控件，能删的依赖都删（协程若 M1–M4 不用也删）。
- AIS：只有存在 AIS 账号或用户在设置里开启时才启动子进程；给子进程加 `GOMEMLIMIT=64MiB`、`GOGC=50`；日志只保留最近 200 行。
- CI：删掉 nodejs-mobile 下载和 Node 资源同步；`refactor/**` 分支 push 时也编译并上传 APK artifact；打 `v2.*` tag 时发预发布。`npm test` 和 Docker 那步保留（Linux 版仍用 src/）。
- 版本号改为 `2.0.0-beta.1`（version.properties）。

## Linux 版
`src/*.mjs`（Node）继续作为 Linux/Docker 服务端，不打进 APK，本次不改。README 第二阶段再更新。

## 回复格式
【结论】一句话 / 【证据】提交 SHA / 【问题】需要别人配合或合同没写清的点（没有写“无”）/ 【完成】
