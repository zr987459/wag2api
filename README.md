# wag2api

一个 App，两个 AI 网关引擎。

把 **Google Antigravity（Cloud Code）** 和 **腾讯 WorkBuddy / CodeBuddy** 两条上游，统一到同一个本地端口、同一套 API、同一个控制台。

```
                    ┌──────────────────────────────────┐
                    │   wag2api  (127.0.0.1:8800)      │
   客户端 ────────► │   前门：三层路由                  │
   (Claude Code /   │   1. 路径  2. 模型名  3. 默认引擎 │
    Cherry Studio / └────────┬─────────────────┬───────┘
    任意 OpenAI 客户端)      │                 │
                             ▼                 ▼
                    ┌────────────────┐  ┌──────────────────┐
                    │  WB 引擎        │  │  AG 引擎          │
                    │  Kotlin 原生    │  │  Node (:node)     │
                    │  TencentGateway │  │  Antigravity      │
                    └────────────────┘  └──────────────────┘
```

## 特性

- 🔓 完全开源免费，无授权码、无激活、无云端校验
- 🏠 全程本地运行，账号只存在自己设备上
- 🎯 **统一入口**：一个端口、一套密钥，同时访问两家上游
- 🧠 **双引擎独立**：任一上游失效，另一个照常可用
- 📦 **两个安装包**：`full`（带 AG 引擎，arm64）/ `lite`（纯 Kotlin，全机型）
- 👥 多账号池、自动切换、额度查询
- 📊 精确 Token 统计与请求日志
- 🌓 白天 / 黑夜主题自动适配
- 📱 前台服务保活、开机自启、状态栏常驻

## 快速开始

### 安卓

到 [Releases](../../releases/latest) 下载：

| 包 | 适用 | 大小 |
| --- | --- | --- |
| `wag2api.apk` | 主流手机（arm64），含双引擎 | 较大（内置 Node） |
| `wag2api-lite.apk` | 任意机型 / 32 位 / 模拟器，仅 WB 引擎 | 轻量 |

两个包**包名与签名相同**，可以互相覆盖安装，数据不丢。

装好后打开 App：

1. **WB 引擎**：账号页 → 添加账号 → 腾讯授权登录（或粘贴 JWT）
2. **AG 引擎**：概览页 → AG 控制台 → 添加账号 → Google 登录
3. **接入客户端**：密钥页 → 复制接入地址 `http://127.0.0.1:8800/v1` 与密钥

### Linux 服务端

```bash
curl -fsSL https://raw.githubusercontent.com/zr987459/wag2api/main/scripts/install.sh | sudo bash
```

或手动运行单文件版：

```bash
xz -d wag2api-linux-x64.xz && chmod +x wag2api-linux-x64
./wag2api-linux-x64          # 数据保存在 ~/.wag2api
```

Linux / 源码版（`node src/server.mjs`）同样是 **WB + AG 双引擎**，界面、`/panel/api/*` 接口与分流规则和安卓一致：

| 环境变量 | 作用 |
| --- | --- |
| `PORT` / `HOST` | 监听端口与地址（默认 8790 / 0.0.0.0） |
| `ADMIN_KEY` | 管理密钥；设置后 `/panel/api/*`、`/api/*`、`/v1/*` 都要带 `x-admin-key` / `x-api-key` |
| `DEFAULT_ENGINE` | 首次启动的默认引擎 `wb`（默认）或 `ag`，之后以界面设置为准 |
| `WB_ENGINE=0` | 关闭 WB，退回只有 AG 的旧行为 |
| `DATA_DIR` | 数据目录；WB 账号、统计、设置在 `DATA_DIR/wb/` |

WB 账号也可以直接把官方凭证 `workbuddy-<uid>.json` 放进 `DATA_DIR/wb/auths/`，启动时自动并入。

> ⚠️ **安全**：默认监听 `0.0.0.0`。如果没设 `ADMIN_KEY`，同一网络 / 公网上的任何人都能调用
> `/panel/api/tokens/export`、`/api/accounts/export` **导出你全部 WB / AG Token**，并用你的额度调用 `/v1/*`。
> 启动日志会醒目警告。对外部署务必设置 `ADMIN_KEY`（足够长的随机串），或只在本机监听 `HOST=127.0.0.1`。
> 单文件版首次运行会自动生成密钥（`NO_AUTH=1` 可关闭，不建议）。

配置了 `GH_TOKEN` + `GH_REPO`（见 `src/persist.mjs`）时，AG 账号、WB 账号与设置、两边统计都会同步到仓库的 `state` 分支，重新部署后自动恢复。

## AG 引擎首字延迟（TTFT）调优

### 分段耗时

每条 AG 请求日志都带分段打点（毫秒），控制台「分段耗时」面板显示最近 20 条的中位数：

| 字段 | 含义 |
| --- | --- |
| `t_token` / `t_payload` | 取 token / 组包完成（相对请求开始） |
| `upload_ms` | 本次尝试从发起请求到请求体全部写出（含建连/握手）。取自 Node `req.on('finish')`，表示数据已交给本机 socket 缓冲区，**是近似值、偏小**；Bun 下为 `null` |
| `wait_headers_ms` | 响应头耗时 − `upload_ms`，即上游排队 + prefill（+ 首个思考块）的时间；Bun 下等于整段头耗时 |
| `first_chunk_ms` / `first_thought_ms` / `first_text_ms` | 首个内容块 / 首个思考块 / 首个正文（相对请求开始） |
| `body_bytes` | 发给上游的请求体字节数 |
| `host` / `attempts` / `thinking_level` | 最终走的 host、尝试次数、思考档位 |

日志卡片里「头」被拆成「上传 · 等待 · 首思考 · 首正文」，并显示请求体大小和 host。

### 长上下文回放测速

控制台 → AG 账号页 → 「🔁 长上下文回放」：用**最近一次正式 AG 请求**（同账号、同 sessionId、同上下文）按 daily → autopush → prod 交替各发 2 轮，输出每个组合的响应头 / 首思考 / 首正文中位数和缓存命中率。

- payload 只在内存保留最近一份，不落盘、不进日志，接口只返回大小等元信息；
- 回放只改顶层 `requestId` 和 `maxOutputTokens`（≤ 256），其余原样，所以能测到真实缓存命中；
- 可选变体：思考 `low / high`，safety `on / off`，组合数 × 3 个集群 × 2 轮就是请求次数；
- ⚠️ 每次都按完整上下文计输入，未命中缓存的集群按全价计；同一 sessionId 在上游有约 1,048,576 token 的累计上限，回放次数多了可能触发换代，下一轮正式对话会未命中缓存。按钮会先弹出预计 token 量让你确认。

### 调优开关

以下开关都可以用**环境变量**设置，也可以在控制台「AG 调优开关」卡片里改（控制台的值优先，保存在 `DATA_DIR/ag-tuning.json`，清空即恢复环境变量 / 默认值；安卓上只能用控制台）。改动从下一个请求开始生效。

| 开关 | 默认 | 说明 |
| --- | --- | --- |
| `AG_ENDPOINTS` | `daily,autopush,prod` | 集群顺序，逗号分隔，取值 `daily` / `autopush` / `prod` 或完整 URL。正式请求走第 1 个；5xx / 超时 / 首块超时换第 2 个。默认与原行为一致 |
| `AG_FIRST_CHUNK_FAILOVER_MS` | `0`（关） | 流式请求在这么多毫秒内**没收到响应头**就中止并换下一个 host 重发，只换一次；不换账号、不降级、不改 sessionId。拿到响应头后（开始吐字）绝不重发。第二个 host 也失败则直接返回错误。⚠️ 换过去的 host 很可能没有这个会话的缓存，长上下文会按全量 prefill，可能更慢、更费额度；被中止的请求上游也可能照常计费。先用回放测速确认再开 |
| `AG_SAFETY_SETTINGS` | `block_none` | `block_none` = 发送 5 条 `BLOCK_NONE`（原行为）；`off` = 不发送 `safetySettings`，与官方 Antigravity 客户端一致。⚠️ 切换取值会改变请求序列化结果，**切换后的第一轮可能未命中缓存**；`off` 时上游按默认阈值过滤，个别回答可能以 `SAFETY` 结束 |
| `AG_HOST_HEALTH` | `0`（关） | host 健康度：每个 host 记最近 10 次等待头时间，按请求体大小分档（<256KB / <1MB / ≥1MB）比较；某 host 同档中位数持续 > 其他 host 2 倍时，**新会话**把它排到后面 10 分钟 |

**host 粘滞**（始终开启，不改 request）：会话第一次成功的 host 会被记住（会话 key → host，TTL 与账号亲和相同，30 分钟），之后同会话固定走它，避免因为缓存按 host 隔离而来回跳；只有换 host 成功后才重新绑定。辅助请求（标题生成等）不参与粘滞。

> 已知：`UPSTREAM_HEADER_TIMEOUT_MS`（默认 180 秒）大于 `RETRY_DEADLINE_MS`（默认 90 秒），所以一次头超时之后不会再重试。开启 `AG_FIRST_CHUNK_FAILOVER_MS` 后，切换发生在截止时间之前，不受影响。

<!-- ttft-env -->

## 模型分流规则

前门按三层顺序判断，**绝不靠模型名前缀猜**（两边都有 `claude-` 和 `gemini-` 家族，猜一定错）：

| 顺序 | 规则 | 示例 |
| --- | --- | --- |
| 1 | 路径 | `/ag/*` 与 `/api/*` → AG；`/panel/*`、`/m/*` → WB |
| 2 | 模型名前缀 | `ag:xxx` 强制走 AG，`wb:xxx` 强制走 WB |
| 3 | 模型表精确匹配 | 只在一边表里存在 → 走那一边 |
| 4 | 默认引擎 | 两边重名或未知模型 → 用设置里的默认引擎 |

```bash
# 自动分流：claude-sonnet-4-6 只在 AG 表里
curl http://127.0.0.1:8800/v1/messages -H "x-api-key: $KEY" \
  -d '{"model":"claude-sonnet-4-6","messages":[{"role":"user","content":"hi"}]}'

# 强制指定引擎
curl ... -d '{"model":"ag:gemini-3.8-flash", ...}'
curl ... -d '{"model":"wb:deepseek-v4.1-flash-1017", ...}'
```

`GET /v1/models` 返回两边的合并列表，重名模型会额外列出 `ag:` / `wb:` 前缀版本供你显式选择。

## 协议支持

| 接口 | 状态 |
| --- | --- |
| `POST /v1/messages`（Anthropic） | ✅ 完整支持，含 thinking 与 tool_use |
| `POST /v1/chat/completions`（OpenAI） | ✅ 完整支持 |
| `GET /v1/models` | ✅ 双引擎合并列表 |
| `GET /health` | ✅ 含引擎状态 |

## 目录结构

```
├─ src/                  Node 核心（AG 引擎），Linux / Docker / Android 共用这一份
├─ app/                  安卓宿主工程
│  ├─ app/               Kotlin 宿主：前门、路由、WB 引擎、Web 控制台
│  │  ├─ src/main/       前门、路由、WB 引擎、UI
│  │  ├─ src/full/       带 Node 引擎（RealNodeEngine）
│  │  └─ src/lite/       不带 Node 引擎（NoopNodeEngine）
│  └─ engine-node/       Node 引擎模块：JNI、NodeService、libnode
├─ linux/                Linux 服务端（Python 单脚本）
├─ src/wb/               WB 引擎 Node 版（Linux / 源码版用；安卓由 Kotlin 处理）
├─ tests/                协议转换、usage、路由规则、WB 引擎测试
└─ docs/merge-plan.md    双引擎融合设计文档
```

## 构建

本地构建需要 JDK 17 + Android SDK + NDK：

```bash
cd app
./gradlew assembleFullRelease assembleLiteRelease
```

`full` 包需要 nodejs-mobile 运行时，CI 会自动下载到 `app/engine-node/libnode`。

日常构建全部走 GitHub Actions（`.github/workflows/build.yml`）：

- push `main` → 只产出 artifact，不发布
- push `v*` tag → 校验 tag 与 `version.properties` 一致后发布 Release

## 测试

```bash
npm test        # 协议转换 + usage 统计 + 前门路由规则
```

## 免责声明

本项目仅供学习与个人使用，与 Google、Tencent 无关。使用各家账号请自行遵守其服务条款，风险自负。

## License

MIT
