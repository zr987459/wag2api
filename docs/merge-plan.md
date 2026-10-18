# wag2api × WorkBuddy App 融合方案

> 目标：把 **wag2api**（Google Antigravity / Cloud Code 网关，Node + nodejs-mobile）与 **workbuddy-app**（腾讯 WorkBuddy 网关，纯 Kotlin）融合成一个 App。
>
> 路线：**Kotlin 宿主 + Node 引擎**（同壳不同芯），不重写 Node 核心。
>
> 本文档由 Hark（Claude Opus 5.5）分三轮推演产出，逐段可独立落地、随时可回滚。

---

## 0. 一句话结论

以 **workbuddy-app 的 Kotlin 工程为宿主**，把 wag2api 的 Node 核心作为**可选引擎**（`engine-node` 模块 + `full`/`lite` 双 flavor）装进去。前门统一在 `127.0.0.1:8800`，按**路径 → 模型名 → 默认引擎**三层规则分流，Node 退居 `127.0.0.1:18790` 内部端口。

**不做的事**：不把 wag2api 用 Kotlin 重写（2~3 周，等于白扔现有成果）。

---

## 1. 两个项目的现状对比

| | **workbuddy-app** | **wag2api** |
|---|---|---|
| 上游 | 腾讯 WorkBuddy / CodeBuddy | Google Antigravity / Cloud Code |
| 手机端引擎 | 纯 Kotlin + OkHttp3（约 5MB，零外部依赖） | Node.js（nodejs-mobile + JNI，独立 `:node` 进程，30MB+） |
| 认证 | JWT / Cookie + 腾讯客户端指纹 | Google OAuth Refresh Token + 签名缓存 |
| Linux 版 | `linux/main.py`（Python） | Bun 单文件 xz + systemd |
| 控制台 | `web/`（原生 JS，5 Tab） | `dashboard.html`（51KB）+ `token-page.html` |
| 协议 | OpenAI + Anthropic | Anthropic（**OpenAI 实际返回 400**，见 §7） |
| 签名 | `workbuddy.jks`，密码已公开 | `release.p12.enc` + Secret，保密 |

**共同点**：都是「本地双协议网关 + 账号池 + 统计 + 日志 + Web 控制台 + 安卓壳」。差异集中在**上游适配层**，不在骨架。

---

## 2. 目录结构

宿主用 workbuddy-app（包名待定，见 §8）。wag2api 用 `git subtree` 并入，保留提交历史。

```
workbuddy-app/
├─ engines/ag/          原 wag2api 根目录（src/ package.json tests/ scripts/）
│                       Node 核心只有这一份，Android、Linux、Docker 都从这里取
├─ android/
│  ├─ app/              宿主
│  │   host/            前台服务、前门、路由、悬浮球、开机自启
│  │   wb/              TencentGateway、转换器、AccountVault（原样不动）
│  │   migrate/         AG 老数据导入
│  │   full/ lite/      各放一个引擎工厂：full 返回 Node 引擎，lite 返回空实现
│  └─ engine-node/      Android library：native-lib.cpp、NodeService、AssetCopier、libnode
├─ linux/  web/         WB 原有
└─ .github/workflows/
```

### 关键取舍

- **`src/` 放 `engines/ag` 而不是 `android/` 里**：Linux 单文件版和 Docker 也要用这份源码。放在仓库根目录、与 `android/` 平级，谁都能取，不会出现两份 Node 核心各改各的。Android 构建时由 `engine-node` 在 `preBuild` 阶段同步进 assets。
- **module 与 flavor 两个都要，各管一件事**：
  - **module（`engine-node`）管代码边界**：JNI、CMake、nodejs-mobile、assets 全关在库里，宿主只通过一个引擎接口接触它。将来 Node 移植成 Kotlin，删掉模块即可。
  - **flavor（`full` / `lite`）管打包**：libnode 只有 arm64，带上它 32 位手机装不了，而 WB 现在是纯 Kotlin、全机型可装。`full` 带 Node（arm64，minSdk 26），`lite` 不带（全 ABI，minSdk 24）。两者 applicationId 与签名相同，可互相覆盖。
- **NodeService 保留原包名 `org.agopen.gateway`**，这样 JNI 函数名不用改。

---

## 3. 前门路由

### 端口

- **前门 `127.0.0.1:8800`**：唯一对外端口。
- **Node 改为 `127.0.0.1:18790`**：必须显式设 `HOST`，否则它默认监听 `0.0.0.0`，会绕过前门。
- **内部 token**：Node 校验 `ENGINE_TOKEN`，防止手机上其他 App 直连。

### 三层判断（按顺序）

1. **路径**：控制台与管理接口，不看 body
2. **模型名**：只对 `/v1/messages` 和 `/v1/chat/completions` 生效
3. **默认引擎**：重名或未知模型走默认引擎，由用户在设置里选

```
route(req):
  p = normalize(req.path)        # 折叠 //、去末尾 /，*/messages → /v1/messages

  # 第 1 层：路径
  if p starts with /ag/  → 去掉 /ag 前缀，转发 Node   # Node 控制台挂在 /ag/
  if p starts with /api/ → 原样转发 Node              # Node 控制台内部用绝对路径 fetch
  if p starts with /panel/ or /m/ → WB

  if p == /v1/models → 合并两边列表；重名模型额外列出 ag: / wb: 前缀版本

  # 第 2 层：模型名
  if p in [/v1/messages, /v1/chat/completions]:
    m = body.model
    if m starts with "ag:" → AG，去掉前缀
    elif m starts with "wb:" → WB，去掉前缀
    elif m 只在 AG 模型表里 → AG
    elif m 只在 WB 模型表里（含 global:*）→ WB
    else → 默认引擎                       # 第 3 层

    if 结果是 AG 且 AG 未启用/未就绪 → 503     # 不悄悄改走 WB
    AG → 带内部 token 流式转发到 18790
    WB → 交给原来的 handleAnthropicMessages / handleOpenAiChat

  其他路径 → WB 静态页
```

### 关键取舍

- **只做精确匹配，不按前缀猜**。两边都有 `claude-` 和 `gemini-` 家族（WB 有 `claude-4.0-sonnet`、`gemini-3.5-flash`；AG 有 `claude-sonnet-4-6`、`gemini-3.8-*`），按前缀分一定分错。AG 模型表在 Node 就绪时从它的 `/v1/models` 拉取，之后定期刷新。
- **重名交给用户决定**：`ag:` / `wb:` 前缀强制指定引擎，否则走默认引擎，前门不猜。
- **AG 不可用时直接报错**：用户点的是 Gemini，悄悄换成腾讯模型比报错更糟。
- **前门只管路由，不懂协议**：body 原样透传（只在去前缀时改写 `model` 字段），鉴权头原样交给 Node 校验，响应逐块 flush，SSE 不缓冲。

---

## 4. 进程与生命周期

### 4.1 状态机（全部归 GatewayService / NodeEngine 管）

```
OFF ──enable──► STARTING ──/health 200──► READY
 ▲                 │  ▲                     │
 │                 │  └──系统重建 :node──────┤ (onServiceDisconnected)
 │            30s 内崩 3 次                  │
 │                 ▼                         │ disable / 改配置
 └──────────── FAILED            DRAINING ◄──┘
                                     │ 在途清空或 30s
                                     ▼
                                 STOPPING ──进程退出──► OFF
```

- **通知**：只有 GatewayService 的 #8800。同一 ID 调 `notify()` 按状态刷新文案，如「WB ✓ · AG 启动中 / ✓ / 已关闭 / 异常」。
- **悬浮球**：只在 GatewayService 里有一个，颜色跟状态变。NodeService 里不再有任何 UI。
- **端口**：在 `:node` 内选，通过 Binder 回传。系统重建进程时不会拿到过期端口。
- **崩溃恢复**：`:node` 被系统杀掉后，`BIND_AUTO_CREATE` 会自动重建并再次回调 `onServiceConnected`，宿主**不要手动 rebind**。宿主只做熔断：30s 内崩 3 次就 unbind 并标记 FAILED，防止一直重启耗电。

### 4.2 关闭 AG 引擎：先排空，再 SIGTERM，最后兜底杀进程

现状问题：`unbindService` 会立刻触发 `onDestroy → killProcess`，Node 来不及 flush。且 core 只在开启 GitHub 持久化时才注册 SIGTERM 处理。好在账号文件是 `writeFileSync` 同步写盘，**最坏只丢最后一段统计，不会丢账号**。

停止顺序：

1. **DRAINING**：前门对 Node 新请求直接回 503，等在途请求（`NodeProxy` 计数）清零，最多 30s
2. 向 `:node` 发 **SIGTERM**（同 uid 允许，pid 从 Binder 拿）
3. 等 `onServiceDisconnected`，最多 5s（状态是 STOPPING 时不当作崩溃）
4. `unbindService`
5. 进程还活着则 `killProcess(pid)` 兜底

「重启」（改端口、改 scrub 开关）就是先停再起。新进程拿新随机端口，不会撞 TIME_WAIT。

```js
// engines/ag/src/server.mjs —— 无论是否开持久化都处理 SIGTERM（Linux systemd 也受益）
process.once('SIGTERM', async () => {
  statsTracker.flush();
  if (persist.enabled) await Promise.race([persist.syncStats(), new Promise(r => setTimeout(r, 8000))]);
  server.close(); process.exit(0);
});
```

```kotlin
// NodeEngine.stop
fun stop(ctx: Context) {
  state = DRAINING
  thread {
    NodeProxy.awaitIdle(30_000)
    state = STOPPING
    pid?.let { android.os.Process.sendSignal(it, 15) }      // SIGTERM
    exited.await(5, TimeUnit.SECONDS)                       // onServiceDisconnected 里 countDown
    main.post { conn?.let(ctx::unbindService); conn = null
                pid?.let { if (alive(it)) android.os.Process.killProcess(it) }
                state = OFF; GatewayService.refreshNotification() }
  }
}
```

关掉**整个网关**：先走 `NodeEngine.stop`，再 `stopForeground` + `stopSelf`。

### 4.3 full 与 lite

`:app` 里定义接口 `NodeEngineApi`，在 `src/full/` 和 `src/lite/` 各放一个 `EngineFactory`：

- **full**：`EngineFactory.create() = RealNodeEngine`，引用 `:engine-node`
- **lite**：返回 `NoopNodeEngine`，状态永远 OFF

只有 full 才 `fullImplementation(project(":engine-node"))`。lite 的 Manifest 里没有 `:node` 服务，也不带 libnode。

| | full | lite |
|---|---|---|
| 启动路径 | 前门 → 按开关 bind `:node` | 只起前门 |
| `ag:` 模型 | 路由到 Node | 返回 501「此版本不含 AG 引擎」 |
| `/ag`、`/api/*` | 转发到 Node | 返回 404 并提示 |
| 设置页 | 显示 AG 开关、迁移入口 | 隐藏 |
| ABI | 只有 arm64 | 任意 |

两包同包名、同签名，可互相覆盖，WB 数据不丢。

### 4.4 开机顺序与未就绪应答

```
BOOT_COMPLETED / MY_PACKAGE_REPLACED
 → GatewayService.onCreate
   1. startForeground（5 秒内必须调用，类型 specialUse，Android 15 开机允许拉起）
   2. 启动前门 :8800 → WB 毫秒级就绪
   3. 若 node_enabled：持 30s 超时 WakeLock，异步 bind :node
      （首次启动或升级后 AssetCopier 要复制文件，会慢一些）
```

**先 WB 后 Node，Node 不阻塞前台服务启动。**

Node 处于 STARTING 时前门应答：

- **命中 Node 的推理请求**：挂起等待就绪，最多 10s。就绪照常转发；超时返回 `503 overloaded_error` + `Retry-After: 3`（Claude Code 会自动重试）
- **关键细节**：`nodeModels` 必须**落盘缓存**。否则启动窗口里模型表为空，没加前缀的 `claude-sonnet-4-6` 会被默认路由到 WB，用户会以为「切模型失灵」
- **`/v1/models`**：返回 WB 列表 + 缓存的 Node 列表，保证客户端看到的模型列表稳定
- **`/health`**：返回 200 带 `node:"starting"`，不要让整个网关显示不健康
- **`/ag` 控制台**：显示「AG 引擎启动中」的自动刷新小页面
- 状态为 OFF 或 FAILED 时，命中 Node 直接 503 并说明原因

---

## 5. 数据迁移（诚实结论）

### 5.1 直接读旧包数据：当前条件下做不到

| 途径 | 为什么不行 |
|---|---|
| 直接读 `/data/data/org.agopen.gateway` | 每应用独立 uid + SELinux 隔离，只有 root 能读 |
| `run-as` / adb 拷贝 | 只对 debuggable 包有效，v1.3.1 release 是 `isDebuggable=false` |
| adb backup / 自动备份 / 换机迁移 | wag2api Manifest 写了 `allowBackup="false"`，被排除 |
| sharedUserId | 必须首次安装就声明且签名一致；两边签名不同，机制也已弃用 |
| 旧 App 运行中的 HTTP 接口 | `/api/status` 只返回 `hasRefreshToken: true`，不返回 token |
| 两边 FileProvider | 都是 `exported=false` |

**结论：老版本 v1.3.1 本身不配合的话，数据拿不出来。没有变通。**

### 5.2 能做的：桥接版（比纯手动好得多）

有利条件：wag2api 老用户的 App **自带更新器**（`autoUpdate` 默认开，启动 3 秒后检查 `zr987459/wag2api` 的 latest release，看到 `AGOpen.apk` 就弹更新）。

1. 在 wag2api 仓库发 **v1.4.0 桥接版**，用旧签名覆盖安装，多数老用户会被自动提示升级
2. v1.4.0 加入 `ExportActivity`：校验调用方包名 + 签名指纹，返回 zip 的 content URI
3. 新 App 点一下「导入 AG Open 账号」即可完成，**用户不用碰文件**
4. 兜底：v1.4.0 控制台加「导出 Refresh Token / 导出备份文件」，新 App 粘贴或选文件导入
5. 新 App 迁移页要醒目提示：**导入完成前别卸载旧 App**

**边界**：即便这样，用户仍需手动点一次「更新」+ 一次「导入」。没升到 v1.4.0 的只能手动导出；已卸载且没导出的，账号就没了。

---

## 6. CI 改造

### 包名不写死

keystore 文件、alias、密码走 Secrets，证书指纹走仓库变量 `RELEASE_CERT_SHA256`。选 `org.agopen.gateway` 就用 AG 的 p12，选 `com.workbuddy.app` 就用 `workbuddy.jks`——只改配置，不改 workflow。

### Job 编排

```
engine-test ─┬─ apk（full + lite）──┐
             └─ linux（x64/arm64） ──┴─ release（只在打 tag 时跑）
```

- **engine-test**：在 `engines/ag` 跑 `npm test`，再跑宿主的 JVM 单测（路由表用例）
- **apk**：一个 job 同时构建两个 flavor，不用 matrix。keystore 只解密一次，Gradle 与 libnode 缓存共用
  - nodejs-mobile 用 `actions/cache` 按版本号缓存，下载时 `sha256sum -c` 校验，只保留 arm64（仅 full 用）
  - openssl 解密 keystore → `assembleFullRelease assembleLiteRelease`
  - **签名硬校验**：两个 APK 都跑 `apksigner verify --print-certs`，SHA-256 与 `RELEASE_CERT_SHA256` 不一致就让构建失败。**这就是「永远能平滑覆盖安装」的保证**
  - 无密钥的 Fork 改用 debug 签名，跳过校验，不发布
  - 只上传 artifact，不创建 Release
- **linux**：Bun 构建 x64/arm64 单文件 → xz，再打 Node 轻量包 tar.gz，跑冒烟测试。路径改成 `engines/ag`
- **release**：等 apk 和 linux 都完成后，下载全部 artifact，生成 `SHA256SUMS`，**只调用一次** `action-gh-release`。现在 wag2api 是两个 job 各调一次往同一 tag 上传，存在竞态

### 发布触发条件

现在两边都是 push main 就发 Release（WB 甚至写死 `v1.1.1`），没升版本号会覆盖已发布版本。改成：

- push main 只出 artifact
- 推 `v*` tag 才发布
- release job 先校验 tag 与 versionName 一致，再校验 versionCode 大于上一个 Release，不满足就失败

### Release 产物（文件名固定，Updater 靠文件名识别）

| 产物 | 说明 |
|---|---|
| `<App>.apk` | full 版，arm64，带 Node |
| `<App>-lite.apk` | lite 版，全 ABI，不带 Node |
| `wag2api-linux-x64(.xz)`、`wag2api-linux-arm64(.xz)` | Linux 单文件 |
| `wag2api-node.tar.gz` | Node 轻量包 |
| `SHA256SUMS` | 校验和 |

### 容易踩的坑

- **full 与 lite 用同一 versionCode**：包名、签名、versionCode 都相同时可直接覆盖互换。Updater 按 `BuildConfig.FLAVOR` 取对应文件
- **版本号只保留一个来源**：仓库根目录 `version.properties`。Gradle、Linux 构建、Node 的 `APP_VERSION` 都从这里读
- **R8 混淆**：AG 的 release 开了混淆，WB 没开。合并后若开启，NodeService 的 JNI 方法必须保留。keep 规则放 `engine-node` 的 `consumer-rules.pro`，不要留在 app 模块
- **统一用 Gradle wrapper**：WB 有 gradlew，AG 用的是 setup-gradle 8.5
- **老 AG Updater 读的是 `zr987459/wag2api` latest Release 里的 `AGOpen.apk`**：若合并仓库不是 wag2api，桥接版仍需在 wag2api 发布；若最终沿用 `org.agopen.gateway`，就把合并后的 full 包按 `AGOpen.apk` 发到 wag2api，老用户自动升级

---

## 7. /v1/chat/completions

### 结论

**第一步不补，先把 README 改对；合并稳定后在 Node 里补，前门一行都不用改。**

### 三选项对比

| 方案 | 工作量 | 问题 |
|---|---|---|
| 前门用 Kotlin 写反向转换器 | 大 | 等于重写一个转换器；Linux 用户用不上；前门开始关心协议细节 |
| 复用 WB 的转换器 | — | **方向相反**，请求和流式两侧都用不上，只能借鉴 `repairToolPairing` 思路 |
| **Node 里加 `openai-compat.mjs`** | 中（约 300 行 + 测试） | 无明显问题：手机与 Linux 同时可用，README 自然就对了 |

### 最省事的做法：在 Node 里套壳，不碰核心

OpenAI 请求 → 转成 Anthropic 请求 → 交给现有 `/v1/messages` 处理函数；用响应适配器把它吐出的 Anthropic SSE 实时翻译成 OpenAI chunk。这样工具调用、thinking、签名缓存、账号池逻辑仍只有一份，兼容层只管格式。

**请求侧**：
- system 消息合并到顶层 `system`
- `tool` 角色转成 user 消息里的 `tool_result`，连续 user 消息要合并
- assistant 的 `tool_calls` 转成 `tool_use`
- `image_url` 只支持 data URL
- `max_completion_tokens`、`max_tokens`、`stop`、`tool_choice` 字段映射

**响应侧**：
- `text_delta` → `content`
- `input_json_delta` → `tool_calls[i].function.arguments`
- `thinking_delta` → `reasoning_content`
- `stop_reason` → `finish_reason`
- usage 换算成 `prompt_tokens` / `completion_tokens`
- 非流式先整体组装再返回

**明确返回 400 而不是假装支持**：`n>1`、`logprobs`、远程图片 URL。

**真正的难点**：OpenAI 客户端不回传 thinking 块和签名，而多轮工具调用时上游需要它们。靠现有 `signature-cache.mjs` 按 `tool_use id` 把签名补回去，测试用例加到 `tests/test-converter.mjs`。

### 第一步只做两件小事

1. README 改成「当前仅支持 `/v1/messages`」
2. 400 错误信息里提示可改用 `/v1/messages`

前门在这条路径上只负责按模型分流，等 Node 补上兼容层后自动生效。

---

## 8. 待主人拍板：包名归属

「Kotlin 宿主」≠「宿主包名必须是 `com.workbuddy.app`」。`applicationId` 与 Kotlin 包名是两回事，WB 代码可照原样跑在 `org.agopen.gateway` 下。

| | 沿用 `com.workbuddy.app`（当前方案） | 沿用 `org.agopen.gateway` |
|---|---|---|
| 谁要迁移 | wag2api 用户 | WB 用户 |
| 迁移手段 | 没有导出功能，需要桥接版 | **WB 已有 Token 导出/导入（JSON，与 CookieBox 互通）** |
| 能否推桥接版 | 能（wag2api 有更新器） | 不能（WB 没有自更新） |
| 签名 | `workbuddy.jks`，密码已公开 | `release.p12.enc` + Secret，**保密** |
| wag2api 旧 Key / 8790 端口 | 要做兼容处理 | 原样保留 |

**Hark 的看法**：哪边用户多就保哪边包名。若差不多，沿用 `org.agopen.gateway` 更省事——签名本来保密，签名泄露问题顺带解决；WB 用户已有现成导出导入，只差在 WB 再发一个提示迁移的版本，而该版本得靠用户自己下载。

---

## 9. 分阶段里程碑

每步半天到一天，一个 PR，可独立提交、随时回滚。

### 步骤 1 · CI 加固（半天，产品行为不变）

- **内容**：宿主仓库加密 keystore、密码挪进 Secrets、加证书指纹校验、改成推 tag 发布、版本号收到一个来源
- **验证**：新包能覆盖安装当前线上版；故意换 keystore，CI 必须失败；无 Secrets 的 Fork 能构建但不发布
- **回滚**：revert workflow 与 gradle 改动

### 步骤 2 · 搬代码，AG 不启动（一天）

- **内容**：subtree 引入 `engines/ag`；建 `engine-node` 模块和 full/lite 双 flavor；宿主代码拆成 `host/` 和 `wb/`；AssetCopier 不再依赖 `VERSION_CODE`；补 consumer-rules。**AG 引擎不开放任何入口**
- **验证**：CI 同时产出两个 APK；`unzip -l` 确认 full 有 `libnode.so` 和 `assets/gateway/src/server.mjs`、lite 没有；lite 能装在 32 位机或 x86 模拟器；WB 回归脚本（curl `/v1/models`、`/v1/messages`）结果与改动前一致
- **回滚**：revert 该 PR，回到单引擎

### 步骤 3 · Node 跑在前门后面（一天，开关控制，默认关闭）

- **内容**：NodeService 改成 bound service；环境变量加 `HOST`、`DATA_DIR`、`ENGINE_TOKEN`；Node 校验 token；前门转发 `/ag/*` 和 `/api/*`；通知与悬浮球合并成一个；前台服务类型改 `specialUse`；实现状态机的启动、停止、崩溃计数
- **验证**：只有一个通知和一个悬浮球；`/ag/` 控制台能打开；不带 token 直连 18790 返回 403；关开关后 `adb shell ps` 看不到 `:node`；快速开关 5 次不卡死；`kill -9` 掉 `:node` 后自动恢复；空闲时 `dumpsys power` 无常驻锁
- **回滚**：开关默认关，出问题先关开关再 revert

### 步骤 4 · 模型分流与开机顺序（一天）

- **内容**：EngineRouter 加流式代理；合并 `/v1/models` 并缓存 AG 模型表；支持 `ag:`/`wb:` 前缀与默认引擎设置；AG 启动期请求最多等 20s；停机前 drain。**路由做成纯函数**，配 JVM 单测用例表，覆盖重名、未知模型、前缀、`global:` 与各种路径变体
- **验证**：单测全绿；AG 模型流式正常，首字延迟比直连 Node 多不到 50ms；客户端中途断开后 Node 端请求被取消；重启手机后第一个 AG 请求不报错；AG 关闭时返回 503 不落到 WB
- **回滚**：只关分流开关，`/v1/*` 全走 WB，与步骤 3 行为一致

**第一步到此结束。** 数据迁移要等包名定下来才能做，`chat/completions` 放在之后，两者都不阻塞前 4 步。

---

## 10. 明确不做的边界

- **`scrub.mjs`**（改写系统提示里的身份词以躲过上游审查）、伪装官方客户端 UA、优先走「免限制」sandbox 集群——这几块属于绕过上游校验，**不移植、不增强**。融合方案里隔离成独立开关，保持原样。
- **不把 Node 核心用 Kotlin 重写**（除非将来 APK 体积/启动速度/双语言维护真的成为痛点，届时先抽 Provider 接口再换实现）。
