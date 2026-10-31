# wag2api

一个 App，两个 AI 网关引擎。

把 **Google Antigravity（Cloud Code）** 和 **Google AI Studio（AIS / AIStudio2API）** 两条上游，统一到同一个本地端口、同一套 API、同一个控制台。

```
                    ┌──────────────────────────────────┐
                    │   wag2api  (127.0.0.1:8800)      │
   客户端 ────────► │   前门：三层路由                  │
   (Claude Code /   │   1. 路径  2. 模型名  3. 默认引擎 │
    Cherry Studio / └────────┬─────────────────┬───────┘
    任意 OpenAI 客户端)      │                 │
                             ▼                 ▼
                    ┌────────────────┐  ┌──────────────────┐
                    │  AIS 引擎       │  │  AG 引擎          │
                    │  系统 WebView   │  │  Kotlin（进程内） │
                    │  AI Studio 页面 │  │  Antigravity      │
                    └────────────────┘  └──────────────────┘
```

## 特性

- 🔓 完全开源免费，无授权码、无激活、无云端校验
- 🏠 全程本地运行，账号只存在自己设备上
- 🎯 **统一入口**：一个端口、一套密钥，同时访问两家上游
- 🧠 **双引擎独立**：任一上游失效，另一个照常可用
- 📦 **一个安装包**：`wag2api.apk` 约 961 KB，不含任何原生库，全机型通用
- 👥 多账号池、自动切换、额度查询
- 📊 精确 Token 统计与请求日志
- 🌓 白天 / 黑夜主题自动适配
- 📱 前台服务保活、开机自启、状态栏常驻

## 快速开始

### 安卓

到 [Releases](../../releases/latest) 下载：

| 包 | 适用 | 大小 |
| --- | --- | --- |
| `wag2api.apk` | 安卓 7.0+ 全机型，含双引擎 | 约 961 KB |

AIS 引擎借用系统 WebView（建议在应用商店把 Android System WebView 更新到较新版本）。包名与签名不变，可直接覆盖旧版安装，账号保留。

装好后打开 App：

1. **AIS 引擎**：Google AI Studio 网页协议，账号用粘贴电脑浏览器里已登录 AI Studio 的 Cookie 添加，详见 [docs/ais-webview.md](docs/ais-webview.md)（Linux/Docker 版暂不内置 AIS）
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

Linux / 源码版（`node src/server.mjs`）目前只有 **AG 引擎**（AIS 依赖安卓系统 WebView，暂不内置），控制台与安卓共用一份：

| 环境变量 | 作用 |
| --- | --- |
| `PORT` / `HOST` | 监听端口与地址（默认 8790 / 0.0.0.0） |
| `ADMIN_KEY` | 管理密钥；设置后 `/api/*`、`/v1/*` 都要带 `x-admin-key` / `x-api-key` |
| `DATA_DIR` | 数据目录 |

> ⚠️ **安全**：默认监听 `0.0.0.0`。如果没设 `ADMIN_KEY`，同一网络 / 公网上的任何人都能调用
> `/api/accounts/export` **导出你全部 AG Token**，并用你的额度调用 `/v1/*`。
> 启动日志会醒目警告。对外部署务必设置 `ADMIN_KEY`（足够长的随机串），或只在本机监听 `HOST=127.0.0.1`。
> 单文件版首次运行会自动生成密钥（`NO_AUTH=1` 可关闭，不建议）。

配置了 `GH_TOKEN` + `GH_REPO`（见 `src/persist.mjs`）时，AG 账号、设置与统计会同步到仓库的 `state` 分支，重新部署后自动恢复。

## 模型分流规则

前门按三层顺序判断，**绝不靠模型名前缀猜**（两边都有 `claude-` 和 `gemini-` 家族，猜一定错）：

| 顺序 | 规则 | 示例 |
| --- | --- | --- |
| 1 | 路径 | `/ag/*` 与 `/api/*` → AG；`/ais/*` → AIS |
| 2 | 模型名前缀 | `ag:xxx` 强制走 AG，`ais:xxx` 强制走 AIS（`wb:xxx` 兼容映射到 `ais`） |
| 3 | 模型表精确匹配 | 只在一边表里存在 → 走那一边 |
| 4 | 默认引擎 | 两边重名或未知模型 → 用设置里的默认引擎 |

```bash
# 自动分流：claude-sonnet-4-6 只在 AG 表里
curl http://127.0.0.1:8800/v1/messages -H "x-api-key: $KEY" \
  -d '{"model":"claude-sonnet-4-6","messages":[{"role":"user","content":"hi"}]}'

# 强制指定引擎
curl ... -d '{"model":"ag:gemini-2.5-pro", ...}'
curl ... -d '{"model":"ais:gemini-2.5-flash", ...}'
```

`GET /v1/models` 返回两边的合并列表，重名模型会额外列出 `ag:` / `ais:` 前缀版本供你显式选择。

## 协议支持

| 接口 | 状态 |
| --- | --- |
| `POST /v1/messages`（Anthropic） | ✅ 完整支持，含 thinking 与 tool_use |
| `POST /v1/chat/completions`（OpenAI） | ✅ 完整支持 |
| `GET /v1/models` | ✅ 双引擎合并列表 |
| `GET /health` | ✅ 含引擎状态 |

## v2 架构与体积

v2（`2.0.0-beta.*`）把安卓端改成纯 Kotlin：前门、AG 引擎都在 App 进程内，AIS 引擎用系统 WebView 打开 AI Studio 页面完成签名与请求。
不再包含 nodejs-mobile（libnode）、Go 版 `libaistudio2api.so`、SpiderMonkey，也不再区分 full / lite 两个包。

| | v1.3.10（full） | v2.0.0-beta.1 |
| --- | --- | --- |
| APK | 55.8 MB | 961 KB（CI release 包实测） |
| 安装后 | 约 203 MB | 约 12 MB（模拟器 debug 包实测：代码 3.8 MB + 数据 8.4 MB；release 包更小） |
| 原生库 | libnode.so、libaistudio2api.so | 无 |

### 内存（模拟器实测）

AIS 的 WebView 按账号**按需创建**，空闲 10 分钟后自动销毁；HTTP 线程池空闲 60 秒后连核心线程也回收；控制台退到后台时暂停渲染。
CI 在 Android 14 x86_64 模拟器（debug 包）上用 `dumpsys meminfo` 记录（见 `ais-emulator` 工作流产物 `meminfo.txt`）：

| 时刻 | App 进程 PSS | WebView 渲染进程 PSS | 存活 AIS WebView |
| --- | --- | --- | --- |
| 启动后空闲（控制台已加载、未用 AIS） | 81 MB | 58 MB | 0 |
| AIS 请求刚结束 | 88 MB | 141 MB | 1 |
| 空闲约 12 分钟后 | 95 MB | 79 MB | 0 |

渲染进程是 App 内所有 WebView（控制台 + AIS）共用的一个，AIS WebView 回收后回落约 60 MB；Java 堆不会立即归还，App 进程 PSS 有小幅波动。数值随设备与 WebView 版本不同。

## 目录结构

```
├─ app/                  安卓工程（v2：纯 Kotlin，无原生库）
│  └─ app/src/main/
│     ├─ java/com/wag2api/app/   前门 LocalGatewayServer、EngineRouter、GatewayService
│     │  └─ ais/                 WebView 版 AIS 引擎（WebViewAisEngine / AisWebWorker / MakerSuite 协议）
│     ├─ java/com/wag2api/ag/    AG 引擎（Kotlin，自 Node 版移植）
│     └─ assets/web/             Web 控制台（打包时压缩）
├─ src/                  Node 版 AG 引擎（Linux / Docker / 源码版用）
├─ tests/                Node 版协议转换、usage、路由规则测试
├─ docs/                 设计文档（refactor-v2.md、ais-webview.md）
└─ .github/              CI：构建、单测、模拟器实测
```

## 构建

本地构建需要 JDK 17 + Android SDK（不需要 NDK）：

```bash
cd app
./gradlew assembleRelease        # 或 assembleDebug
```

日常构建全部走 GitHub Actions（`.github/workflows/build.yml`）：

- push `refactor/**` → 单测 + 出 APK artifact，不发布
- push `v*` tag → 校验 tag 与 `app/version.properties` 一致后发布 Release（`v2.*` 为预发布）
- `ais-emulator.yml`：模拟器实测 AIS（导入账号、OpenAI / Anthropic 接口、内存记录）

## 测试

```bash
npm test                                   # Node 版：协议转换 + usage 统计 + 前门路由规则
cd app && ./gradlew :app:testReleaseUnitTest   # Kotlin：AIS 协议 + AG 引擎单测
```

## 免责声明

本项目仅供学习与个人使用，与 Google、Tencent 无关。使用各家账号请自行遵守其服务条款，风险自负。

## License

MIT
