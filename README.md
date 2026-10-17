# wag2api

把 Google Antigravity（Cloud Code）账号变成标准的 **Anthropic / OpenAI 兼容 API**。

提供两个版本，功能相同、互相独立：

| 版本 | 适合 | 下载 |
| --- | --- | --- |
| 📱 **手机独立版**（AG Open） | 安卓手机，网关直接在手机上运行，不需要电脑或服务器 | `AGOpen.apk` |
| 🐧 **Linux 版** | 电脑、服务器、软路由，单文件运行，无需安装 Node，带电脑版控制台 | `wag2api-linux-x64` / `wag2api-linux-arm64` |

- 🔓 完全开源、免费，无授权码、无激活、无云端校验，代码不混淆
- 🏠 本地运行，不经过任何第三方服务器，账号只保存在你自己的设备上
- 🔌 兼容 Claude Code、Cherry Studio 等 Anthropic / OpenAI 协议客户端
- 👥 多账号池，自动切换，每个账号单独显示 Gemini / Claude 的 5 小时与 7 天额度和重置时间
- 📊 精确统计输入、缓存、输出、思考 Token 与缓存命中率
- 🧠 思考签名（Thought Signature）缓存，多轮工具调用不再报 400
- 🌓 白天 / 黑夜主题，手机和电脑两套界面自动适配
- 📱 手机独立版：悬浮球 + 前台服务保活
- 🐧 Linux 版：一条命令安装成 systemd 服务，开机自启

> ⚠️ 本项目仅供学习与个人使用，与 Google、Anthropic 无关。使用 Google 账号请自行遵守其服务条款，风险自负。

---

## 快速开始

### 方式一：安卓手机

1. 到 [Releases](../../releases/latest) 下载 `AGOpen.apk` 并安装
2. 打开 App，点「添加账号」，用 Google 登录（或粘贴 Refresh Token）
3. 点「复制接入」，把地址和密钥填进你的客户端

App 内可修改端口、重新生成密钥、开关悬浮球，也会自动检查新版本。

### 方式二：Linux 一键安装（推荐服务器使用）

```bash
curl -fsSL https://raw.githubusercontent.com/zr987459/wag2api/main/scripts/install.sh | sudo bash
```

装好后会显示控制台地址和自动生成的密钥，用浏览器打开即可。重复执行就是升级。

- 修改端口 / 密钥：编辑 `/etc/wag2api.env`，然后 `sudo systemctl restart wag2api`
- 查看日志：`journalctl -u wag2api -f`
- 卸载：`curl -fsSL https://raw.githubusercontent.com/zr987459/wag2api/main/scripts/install.sh | sudo bash -s uninstall`

也可以不安装服务，直接运行：

```bash
chmod +x wag2api-linux-x64
./wag2api-linux-x64          # 数据保存在 ~/.wag2api，首次启动自动生成密钥
```

### 方式三：从源码运行（Node.js ≥ 18）

```bash
git clone https://github.com/zr987459/wag2api.git
cd wag2api
npm install
ADMIN_KEY=你的密钥 node src/server.mjs
```

浏览器打开 <http://127.0.0.1:8790> 进入控制台，添加账号即可。不设置 `ADMIN_KEY` 时不校验密钥，只建议在本机使用。

### 方式四：Docker

```bash
docker build -t wag2api .
docker run -d -p 8790:8790 -e ADMIN_KEY=你的密钥 -v $PWD/data:/app/data wag2api
```

---

## 客户端接入

**Claude Code**

```bash
export ANTHROPIC_BASE_URL="http://127.0.0.1:8790"
export ANTHROPIC_API_KEY="你的密钥"
claude
```

**OpenAI 兼容客户端**

- Base URL：`http://127.0.0.1:8790/v1`
- API Key：你的密钥

## 接口

| 路径 | 说明 |
| --- | --- |
| `POST /v1/messages` | Anthropic Messages（支持流式、工具调用、思考） |
| `POST /v1/chat/completions` | OpenAI Chat Completions |
| `GET /v1/models` | 可用模型列表 |
| `GET /` | 控制台 |
| `GET /token` | Refresh Token 获取助手 |
| `GET /health` | 健康检查 |

## 环境变量

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `PORT` | `8790` | 监听端口 |
| `HOST` | `0.0.0.0` | 监听地址，只想本机访问可设为 `127.0.0.1` |
| `ADMIN_KEY` | 空 | 访问密钥。源码运行时留空则不校验；Linux 单文件版留空会自动生成 |
| `DATA_DIR` | `data/` 或 `~/.wag2api` | 数据目录 |
| `GH_TOKEN` / `GH_REPO` | 空 | 可选：把账号和统计同步到你自己仓库的 `state` 分支（适合 Render 等重启会清盘的平台）。请使用**私有**仓库 |
| `HISTORY_PIN` / `TOOL_PIN` | 开启 | 设为 `0` 关闭工具调用的历史锁定 |

账号、密钥和统计都保存在 `data/` 目录，已在 `.gitignore` 中忽略，请不要提交。

## 目录结构

```
src/                 网关源码（Node.js）
  server.mjs           HTTP 服务与路由
  cloudcode.mjs        Cloud Code 请求封装与模型映射
  content-converter.mjs / sse-streamer.mjs   协议与流式转换
  account-pool.mjs     多账号池
  quota-fetcher.mjs    额度查询
  dashboard.html       控制台
android/             安卓 App（Kotlin + nodejs-mobile）
scripts/             Linux 单文件构建（Bun）与一键安装脚本
tests/               单元测试（npm test）
```

## 自己构建

推送到 `main` 会由 GitHub Actions 自动构建 APK 和 Linux 单文件版，并发布到 Releases。

本地构建 Linux 版：安装 [Bun](https://bun.sh) 后执行 `node scripts/build-linux.mjs`，产物在 `dist/`。

Fork 后没有本仓库的签名密码，Actions 会自动改用 debug 签名构建，产物在该次运行的 Artifacts 里。想要正式签名，请生成你自己的 keystore，用 openssl 加密成 `android/keystore/release.p12.enc`，并在仓库 Secrets 里添加 `KS_PW`。

## 许可

[MIT](LICENSE)
