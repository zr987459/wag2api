# WebView 版 AIS（原型，分支 proto/webview-ais）

用安卓系统 WebView 代替 Go + SpiderMonkey 的 `libaistudio2api.so`（解压后约 79MB）。APK 里不再有 AIS 二进制。

## 工作方式

- `com.wag2api.app.ais.WebViewAisEngine` 在 `127.0.0.1:8820`（和 Go 版同一个地址）起进程内 HTTP 服务，前门 `EngineRouter.proxyToAis` 和控制台都不用改。
- 每个 AIS 账号一个隐藏 WebView（`AisWebWorker`），第一次用到时创建，空闲 10 分钟销毁。
  - WebView 支持 `MULTI_PROFILE`（WebView 123+）时每个账号一个独立 Profile（独立 Cookie / localStorage）；不支持时退回全局 CookieManager，同一时间只活一个账号的 WebView。
  - 页面停在 `https://aistudio.google.com/prompts/new_chat`。初始化时在输入框填一条 `Hi` 点 Run，用 `shouldInterceptRequest` 拦下这次 GenerateContent（不真正发出），记下页面的动态请求头；同时临时替换 `default_MakerSuite` 里调用 `.snapshot({` 的函数，拿到页面自己的 WAA service。
  - 每次请求：Kotlin 组好 MakerSuite 正文（`MakerSuiteWire`）→ 页面输入框写入最后一轮文本，用 WAA service 为 binding prompt 的 SHA-256 生成 fresh proof → 在页面里用带 Cookie 的原生 XHR 发出 → 响应分块回传，`MakerSuiteStream` 还原成 Google 流，复用 App 已有的 `SseStreamer` / `OpenaiAgConverter` 输出 Anthropic / OpenAI 格式。
- UA 去掉 `; wv` 和 `Version/4.0`；支持时把 Client Hints 里的 `Android WebView` 品牌改成 `Google Chrome`，并用 `setRequestedWithHeaderOriginAllowList(空集)` 去掉 `X-Requested-With`。不支持的 WebView 跳过，状态见 `/ais/api/webview`。
- 切回 Go 版：`./gradlew assembleRelease -PaisBackend=go`（CI 用仓库变量 `AIS_BACKEND=go`）。

## 导入账号

Google 不允许在 WebView 里登录，只能导入在电脑浏览器里已登录 AI Studio 的 Cookie：

1. 电脑浏览器打开并登录 https://aistudio.google.com 。
2. 导出 Cookie，以下任一格式都可以：
   - Playwright storage-state JSON（`{"cookies":[...],"origins":[...]}`，Go 版 AIS 导出的就是这个）；
   - Cookie-Editor 等扩展导出的 JSON 数组；
   - Netscape `cookies.txt`；
   - `Cookie:` 请求头（`名=值; 名=值`，按 `.google.com` 处理）。
   必须包含 `__Secure-1PSID`、`SAPISID`、`__Secure-1PAPISID`、`__Secure-3PAPISID`，最好导出 `.google.com` 下的全部 Cookie（含 HttpOnly）。
3. App 控制台 → 切到 AIS → 账号 → 添加 → 粘贴 → 导入（或“导入”里粘贴 wag2api-ais 导出文件）。
   也可以直接调接口：`POST http://127.0.0.1:8800/ais/api/accounts/import/cookies`，正文 `{"cookies":"<上面任一格式>","auth_user":0}`。

## 验证

```bash
# 手机上或 adb forward tcp:8800 tcp:8800 之后在电脑上
curl http://127.0.0.1:8800/ais/v1/models            # 第一次会创建 WebView，30~90 秒
curl http://127.0.0.1:8800/ais/api/webview          # WebView 版本、特性支持、每个账号的阶段 / 拿到的请求头名字
curl http://127.0.0.1:8800/v1/chat/completions -H 'content-type: application/json' \
  -d '{"model":"ais:gemini-2.5-flash","messages":[{"role":"user","content":"hi"}]}'
curl -N http://127.0.0.1:8800/v1/chat/completions -H 'content-type: application/json' \
  -d '{"model":"ais:gemini-2.5-flash","stream":true,"messages":[{"role":"user","content":"hi"}]}'
curl http://127.0.0.1:8800/v1/messages -H 'content-type: application/json' \
  -d '{"model":"ais:gemini-2.5-flash","max_tokens":256,"messages":[{"role":"user","content":"hi"}]}'
curl http://127.0.0.1:8800/ais/api/logs              # 引擎日志（只有阶段和请求头名字，没有 Cookie）
```

`/ais/api/accounts/<id>/refresh` 会重建该账号的 WebView 并拉一次模型表，可当作“测试账号”。

## 原型限制

- 只实现了 GenerateContent 文本 / 图片输入 / 函数调用 / 思考、ListModels；没有 Build 通道、CountTokens、自动续写、Google 搜索等内置工具、图片 / 语音输出。
- `discover`（一份 Cookie 识别多个 /u/N 账号）不支持，导入时直接用 `auth_user`。
- 隐藏 WebView 不挂到窗口上（手动 layout 1280×2000），页面 `visibilityState` 为 hidden，计时器可能被节流。
- 用量统计只在内存里保留最近 200 条。
