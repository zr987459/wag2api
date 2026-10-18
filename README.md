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
├─ tests/                协议转换、usage、路由规则测试
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
