/**
 * AG Open Gateway Server
 *
 * 开源、免费、本地运行的 Antigravity (Google Cloud Code) 反向代理：
 * 1. 兼容 Anthropic Messages API (/v1/messages)
 * 2. 深度思考 (Thinking) 与思考签名 (Thought Signature) 补全
 * 3. 官方配额探测 (/api/gemini/quota)
 * 4. 无授权码、无云端验证、无第三方服务依赖
 */

import http from 'http';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { AccountPool } from './account-pool.mjs';
import { signatureCache } from './signature-cache.mjs';
import { OAuthFlowManager } from './oauth-flow.mjs';
import { runConnectivityTest } from './test-runner.mjs';
import { hostBench } from './host-bench.mjs';
import { upstreamFetch, RUNTIME } from './upstream-fetch.mjs';
import { prewarm, lastPrewarm } from './prewarm.mjs';
import { fetchRealQuota } from './quota-fetcher.mjs';
import { getModelsResponse } from './models-catalog.mjs';
import { parseAgImport } from './ag-import.mjs';
import { statsTracker } from './stats.mjs';
import { ANTIGRAVITY_ENDPOINTS, ANTIGRAVITY_ENDPOINT_DAILY, ANTIGRAVITY_ENDPOINT_AUTOPUSH } from './constants.mjs';
const DAILY_HOST = new URL(ANTIGRAVITY_ENDPOINT_DAILY).hostname;
import { AccessControl } from './access-control.mjs';
import { Persist } from './persist.mjs';
import { dbVault } from './db-vault.mjs';
import {
  buildAntigravityHeaders,
  buildCloudCodePayload,
  MODEL_FALLBACK_CHAINS,
  mapToUpstreamModel,
} from './cloudcode.mjs';
import { runWithPolicy, Cooldowns, shouldInsertNotice, buildDowngradeNotice } from './upstream-policy.mjs';
import { convertGoogleToAnthropic } from './content-converter.mjs';
import { handleStreamConversion } from './sse-streamer.mjs';
import {
  openaiRequestToAnthropic,
  convertGoogleToOpenAI,
  handleOpenAIStreamConversion,
} from './openai-ag-converter.mjs';
import { cacheProbe } from './cache-probe.mjs';
import { historyPin } from './history-pin.mjs';
import { clientSessionKey, bumpSessionOnOverflow, sessionStats } from './session-router.mjs';
import { createWbEngine, decide as decideEngine, mergedModels } from './wb/index.mjs';

let lastClientHeaders = null;

// PR1：失败处理参数（环境变量可调）
const POLICY = {
  allowDowngrade: !['0', 'false'].includes(String(process.env.ALLOW_DOWNGRADE ?? '1')),
  // 实测上游拿到首块才回响应头（长上下文 High 已到 14s），流式响应头超时至少 60s；拿到响应头后不再限时
  streamHeaderTimeoutMs: Number(process.env.UPSTREAM_HEADER_TIMEOUT_MS) || 60000,
  nonStreamHeaderTimeoutMs: Number(process.env.UPSTREAM_NONSTREAM_TIMEOUT_MS) || 180000,
  // 重试不再发起超过这个总时长（首次尝试不受限，仍按响应头超时）
  retryDeadlineMs: Number(process.env.RETRY_DEADLINE_MS) || 45000,
};
const cooldowns = new Cooldowns();
const quotaCache = new Map(); // email → Gemini 5h 剩余比例（来自 /api/gemini/quota），只用来决定换到哪个号

const __dirname = path.dirname(fileURLToPath(import.meta.url));
import { DATA_DIR, IS_BINARY } from './paths.mjs';
import crypto from 'crypto';
import os from 'os';
let EMBED = {};
try { EMBED = (await import('./embedded.mjs')).default || {}; } catch (e) {}
fs.mkdirSync(path.join(DATA_DIR, 'accounts'), { recursive: true });
const PORT = process.env.PORT ? parseInt(process.env.PORT, 10) : 8790;

// 状态持久化
const persist = new Persist(DATA_DIR);
await persist.restore();
statsTracker.load();
persist.startStatsSync(() => statsTracker.flush());

// 账号池
const accountPool = new AccountPool(path.join(DATA_DIR, 'accounts'));

persist.snapshot();
for (const m of ['addAccount', 'removeAccount', 'clearAccounts']) {
  const orig = accountPool[m].bind(accountPool);
  accountPool[m] = (...args) => { const r = orig(...args); persist.schedule(); return r; };
}

const oauthFlowManager = new OAuthFlowManager(accountPool);
const access = new AccessControl(path.join(DATA_DIR, 'keys.json'));

// ── 双引擎（Linux / 源码版）────────────────────────────────
// 安卓上 Node 以 ENGINE_TOKEN 启动，只做 AG 引擎；WB 与前门分流由 Kotlin 负责，这里绝不介入。
// WB_ENGINE=0 可退回只有 AG 的旧行为。
const DUAL = !process.env.ENGINE_TOKEN && process.env.WB_ENGINE !== '0';
const wb = DUAL ? createWbEngine({
  dataDir: DATA_DIR,
  port: PORT,
  defaultEngine: process.env.DEFAULT_ENGINE,
  authEnabled: () => access.enabled,
  onChange: () => persist.schedule(), // 账号 / 设置变化 → 同步到 GitHub state 分支（未配置时空操作）
}) : null;

// 从 Supabase 云端数据库恢复账号（解决 Render 免费容器重启重置临时硬盘的问题）
await dbVault.restore({
  onAgAccount: (email, refreshToken, projectId) => {
    accountPool.addAccount(refreshToken, email, projectId);
  },
  onWbAccounts: (rawJson) => {
    if (wb && wb.vault) {
      wb.vault.importToken(rawJson);
    }
  },
});
if (wb) wb.start();
const agModelList = () => (getModelsResponse().data || []);

function sendJson(res, status, obj) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(obj));
}

function denyAdmin(res) {
  sendJson(res, 401, { ok: false, need_admin: true, error: '需要管理密钥' });
}

// 仅管理员可访问的内部接口
const ADMIN_PATHS = new Set([
  '/api/status', '/api/stats', '/api/logs', '/api/logs/clear', '/api/gemini/test', '/api/gemini/auth',
  '/api/oauth/exchange', '/api/oauth/token-exchange', '/api/accounts/add-token', '/api/accounts/switch',
  '/api/accounts/remove', '/api/accounts/export', '/api/accounts/import', '/api/trend', '/api/stats/timing',
]);


// 按字节收齐再解码，避免多字节中文被切在 chunk 边界；同一请求只读一次
function readRawBody(req) {
  if (req._rawBody !== undefined) return Promise.resolve(req._rawBody);
  return new Promise(resolve => {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => { req._rawBody = Buffer.concat(chunks).toString('utf-8'); resolve(req._rawBody); });
    req.on('error', () => { req._rawBody = ''; resolve(''); });
  });
}

async function readBody(req) {
  const b = await readRawBody(req);
  try { return JSON.parse(b || '{}'); } catch (e) { return {}; }
}

/** 把 body.model 的引擎前缀去掉，返回新的原文 */
function stripModelPrefix(raw, prefix) {
  if (!prefix || !raw) return raw;
  try {
    const j = JSON.parse(raw);
    if (typeof j.model === 'string' && j.model.startsWith(prefix)) { j.model = j.model.slice(prefix.length); return JSON.stringify(j); }
  } catch (e) { /* 非 JSON 原样 */ }
  return raw;
}

// 控制台网页：与安卓共用 app/app/src/main/assets/web（单文件版打包进 EMBED.web）
const WEB_TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'application/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png' };
const WEB_DIR = [process.env.WEB_DIR, path.join(__dirname, 'web'), path.join(__dirname, '..', 'app', 'app', 'src', 'main', 'assets', 'web')]
  .find(d => d && fs.existsSync(path.join(d, 'index.html')));

function serveWeb(pathname, res) {
  const cleanPath = pathname.replace(/^\/(panel|wag)(\/|$)/, '/');
  const name = cleanPath === '/' ? 'index.html' : cleanPath.replace(/^\/+/, '');
  if (!/^[A-Za-z0-9_.-]+$/.test(name)) return false;
  const type = WEB_TYPES[path.extname(name)];
  if (!type) return false;
  let body = EMBED.web && EMBED.web[name];
  if (body === undefined && WEB_DIR && fs.existsSync(path.join(WEB_DIR, name))) body = fs.readFileSync(path.join(WEB_DIR, name));
  if (body === undefined) return false;
  if (typeof body === 'string' && type.startsWith('image/png')) body = Buffer.from(body, 'base64');
  res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-cache' });
  res.end(body);
  return true;
}

const server = http.createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS, DELETE');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, x-api-key, x-admin-key, anthropic-version');
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

  // ── 内部引擎令牌校验 ────────────────────────────────────────
  // 仅当宿主以 ENGINE_TOKEN 启动时启用（安卓前门模式）。
  // 防止手机上其他 App 直接连内部端口绕过前门。
  const ENGINE_TOKEN = process.env.ENGINE_TOKEN;
  if (ENGINE_TOKEN) {
    const given = req.headers['x-engine-token'];
    if (given !== ENGINE_TOKEN) {
      res.writeHead(403, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: 'engine token required' }));
      return;
    }
  }
  {
    let p = url.pathname.replace(/\/{2,}/g, '/').replace(/\/+$/, '') || '/';
    if (/(^|\/)messages$/.test(p) && !p.startsWith('/api/')) p = '/v1/messages';
    else if (/(^|\/)chat\/completions$/.test(p) && !p.startsWith('/api/')) p = '/v1/chat/completions';
    else if (/(^|\/)v1\/models$/.test(p)) p = '/v1/models';
    url.pathname = p;
  }

  // 1. 控制台（新版双引擎界面；独立运行时只有 AG，支持 /panel 与 /wag 专属管理入口）
  const isWebPath = url.pathname === '/' || /^\/(panel|wag)(\/|$)/.test(url.pathname) || /^\/[A-Za-z0-9_.-]+\.(html|js|css|json|svg|png)$/.test(url.pathname);
  if (req.method === 'GET' && isWebPath && serveWeb(url.pathname, res)) {
    return;
  }
  if (url.pathname === '/token' || url.pathname === '/get-token' || url.pathname === '/token.html') {
    res.writeHead(302, { Location: '/' });
    res.end();
    return;
  }

  // 1.0.1 引擎状态：双引擎时 dual:true（界面显示引擎切换）；WB_ENGINE=0 时 standalone:true（只有 AG）
  if (url.pathname === '/panel/api/engine/state' || url.pathname === '/m/api/engine/state') {
    if (wb) {
      if (!access.isAdmin(req)) { denyAdmin(res); return; }
      sendJson(res, 200, wb.engineState());
    } else {
      sendJson(res, 200, { supported: true, enabled: true, state: 'READY', port: PORT, default_engine: 'ag', standalone: true, auth: access.enabled });
    }
    return;
  }

  // 1.0.2 WB 管理接口（与安卓 LocalGatewayServer 同一套 /panel/api/*），设置 ADMIN_KEY 时需带密钥
  if (wb && (url.pathname.startsWith('/panel/api/') || url.pathname.startsWith('/m/api/'))) {
    if (!access.isAdmin(req)) { denyAdmin(res); return; }
    const raw = req.method === 'GET' || req.method === 'HEAD' ? '' : await readRawBody(req);
    await wb.handlePanel(req, res, url, raw);
    return;
  }

  // 1.0.3 网关总开关：关闭时只拦数据面（/v1/*），控制台照常可用
  if (wb && url.pathname.startsWith('/v1/') && !wb.gatewayEnabled()) {
    res.writeHead(503, { 'Content-Type': 'application/json; charset=utf-8', 'Retry-After': '30' });
    res.end(JSON.stringify({ error: { message: 'WorkBuddy 网关已关闭，请在管理面板开启', type: 'gateway_disabled', code: 'gateway_disabled' } }));
    return;
  }

  // 1.0.4 前门分流：/v1/messages 与 /v1/chat/completions 按 EngineRouter 规则交给 WB 或 AG
  if (wb && req.method === 'POST' && (url.pathname === '/v1/messages' || url.pathname === '/v1/chat/completions')) {
    const raw = await readRawBody(req);
    let model = '';
    try { model = String(JSON.parse(raw).model || ''); } catch (e) { /* 交给下游报错 */ }
    const d = decideEngine(url.pathname, model, { agModels: agModelList(), wbModels: wb.models(), defaultEngine: wb.defaultEngine() });
    if (d.engine === 'wb') {
      if (access.enabled && !access.isAdmin(req)) {
        sendJson(res, 401, { type: 'error', error: { type: 'authentication_error', message: 'API Key 无效或缺失 (x-api-key)' } });
        return;
      }
      let json;
      try { json = JSON.parse(stripModelPrefix(raw, 'wb:')); } catch (e) {
        sendJson(res, 400, { type: 'error', error: { type: 'invalid_request_error', message: '请求体不是合法 JSON' } });
        return;
      }
      if (url.pathname === '/v1/messages') await wb.handleMessages(req, res, json);
      else await wb.handleChat(req, res, json);
      return;
    }
    req._rawBody = stripModelPrefix(raw, 'ag:'); // 交给下面的 AG 处理
  }

  // 1.5 OAuth 回调
  if ((url.pathname === '/oauth-callback' || url.pathname === '/oauth-result') && oauthFlowManager.handleHttp(url, res)) {
    return;
  }

  // 1.6 健康检查
  if (url.pathname === '/health') {
    sendJson(res, 200, { ok: true, app: 'ag-open-gateway', version: '1.3.1', auth: access.enabled });
    return;
  }

  // 1.7 管理接口鉴权拦截
  if (ADMIN_PATHS.has(url.pathname) && !access.isAdmin(req)) {
    denyAdmin(res);
    return;
  }

  // ====================== Antigravity 核心接口 ======================
  // 2. 真实配额接口 (/api/gemini/quota)
  if (url.pathname === '/api/gemini/quota') {
    const email = url.searchParams.get('email');
    const mgr = email ? accountPool.getManager(email) : accountPool.getActiveManager();
    const targetMgr = mgr || accountPool.getActiveManager();
    const quotaData = await fetchRealQuota(targetMgr);
    const frac = quotaData?.gemini_5h?.remaining_fraction;
    if (quotaData?.ok && quotaData.email && typeof frac === 'number') quotaCache.set(quotaData.email, frac);
    sendJson(res, 200, quotaData);
    return;
  }

  // 2.2 AG 账号池调度与切换接口
  if (url.pathname === '/api/accounts/pool') {
    sendJson(res, 200, { ok: true, accounts: accountPool.poolStatus(), selected_email: accountPool.getSelectedEmail() });
    return;
  }
  if (url.pathname === '/api/accounts/select' && req.method === 'POST') {
    try {
      const { email } = await readBody(req);
      accountPool.setSelectedEmail(email);
      sendJson(res, 200, { ok: true, selected_email: accountPool.getSelectedEmail(), message: email ? `已锁定账号 ${email}` : '已改为全自动智能轮询' });
    } catch (e) {
      sendJson(res, 500, { ok: false, error: e.message });
    }
    return;
  }
  if (url.pathname === '/api/accounts/clear-cooldown' && req.method === 'POST') {
    accountPool.clearAllCooldowns();
    cooldowns.clear();
    sendJson(res, 200, { ok: true, message: 'AG 账号池冷却已全部清除' });
    return;
  }

  // 3. 统计数据与日志
  if (url.pathname === '/api/stats') {
    sendJson(res, 200, { ...statsTracker.getStats(), cooldowns: cooldowns.list() });
    return;
  }

  if (url.pathname === '/api/debug/cache') {
    sendJson(res, 200, { pin: historyPin.stats(), session: sessionStats(), clientHeaders: lastClientHeaders, requests: cacheProbe.report() });
    return;
  }

  if (url.pathname === '/api/stats/timing') {
    sendJson(res, 200, statsTracker.getTimingSummary(Number(url.searchParams.get('n')) || 20));
    return;
  }

  if (url.pathname === '/api/logs') {
    sendJson(res, 200, statsTracker.getAllLogs(100));
    return;
  }

  if (url.pathname === '/api/logs/clear' && req.method === 'POST') {
    const resetAll = url.searchParams.get('all') === '1';
    if (resetAll) {
      statsTracker.resetStats();
    } else {
      statsTracker.clearAllLogs();
    }
    sendJson(res, 200, { ok: true, resetAll });
    return;
  }

  if (url.pathname === '/api/stats/reset' && req.method === 'POST') {
    statsTracker.resetStats();
    sendJson(res, 200, { ok: true, message: '统计数据已归零' });
    return;
  }

  // 4. 模型列表接口（双引擎时 /v1/models 合并两边；/api/models 仍只给 AG）
  if (url.pathname === '/v1/models' && wb) {
    sendJson(res, 200, mergedModels(wb.models(), agModelList()));
    return;
  }
  if (url.pathname === '/v1/models' || url.pathname === '/models' || url.pathname === '/api/models') {
    sendJson(res, 200, getModelsResponse());
    return;
  }

  // 5. 服务状态
  if (url.pathname === '/api/status') {
    const activeMgr = accountPool.getActiveManager();
    const host = req.headers.host || '';
    const status = {
      app: 'ag-open-gateway',
      version: '1.3.1',
      auth_enabled: access.enabled,
      port: PORT,
      auth_url: oauthFlowManager.getAuthUrl(host),
      active_account: activeMgr ? activeMgr.getStatus() : null,
      accounts: accountPool.getAllStatus(),
      stats: statsTracker.getStats(),
      signature_cache_size: signatureCache.size(),
      persist: persist.status(),
    };
    sendJson(res, 200, status);
    return;
  }

  // 6. 出字测速
  if (url.pathname === '/api/gemini/test' && req.method === 'POST') {
    const activeMgr = accountPool.getActiveManager();
    const testResult = await runConnectivityTest(activeMgr, accountPool);
    sendJson(res, 200, testResult);
    return;
  }

  // 6.2 预热（启动 / 网络恢复 / 控制台回前台）：token + projectId + 上游连接
  if (url.pathname === '/api/prewarm') {
    if (!access.isAdmin(req)) { denyAdmin(res); return; }
    if (req.method === 'POST') {
      const body = await readBody(req).catch(() => ({}));
      const r = await prewarm(accountPool, { reason: String(body.reason || 'manual').slice(0, 20) });
      sendJson(res, 200, { runtime: RUNTIME, ...r });
      return;
    }
    sendJson(res, 200, { runtime: RUNTIME, last: lastPrewarm() });
    return;
  }

  // 6.1 集群测速（daily / autopush / prod），后台执行，GET 轮询结果
  if (url.pathname === '/api/bench/hosts') {
    if (!access.isAdmin(req)) { denyAdmin(res); return; }
    if (req.method === 'POST') {
      const body = await readBody(req).catch(() => ({}));
      const mgr = accountPool.getActiveManager();
      if (!mgr) { sendJson(res, 400, { ok: false, error: '账号池暂无可用 Google 账号' }); return; }
      const started = hostBench.start(mgr, { rounds: body.rounds, model: body.model || 'gemini-3.8-flash-high' });
      sendJson(res, started ? 200 : 409, { ok: started, ...(started ? {} : { error: '已有测速在进行' }), ...hostBench.status() });
      return;
    }
    sendJson(res, 200, { ok: true, ...hostBench.status() });
    return;
  }

  // 7. OAuth 授权链接
  if (url.pathname === '/api/gemini/auth' && req.method === 'POST') {
    const host = req.headers.host || '';
    const authUrl = oauthFlowManager.getAuthUrl(host);
    sendJson(res, 200, { ok: true, auth_url: authUrl, message: '授权链接已就绪' });
    return;
  }

  // 8. 手动回贴回调 URL 或 Code 换票入池
  if (url.pathname === '/api/oauth/exchange' && req.method === 'POST') {
    try {
      const { code_or_url } = await readBody(req);
      if (!code_or_url) {
        sendJson(res, 400, { ok: false, error: '请粘贴回调 URL 或 Code' });
        return;
      }
      const tokenResult = await oauthFlowManager.exchangeRawInput(code_or_url);
      if (tokenResult.refreshToken && tokenResult.email) {
        accountPool.addAccount(tokenResult.refreshToken, tokenResult.email);
      }
      sendJson(res, 200, {
        ok: true,
        message: `账号 ${tokenResult.email} 授权成功并加入账号池！`,
        email: tokenResult.email,
        refreshToken: tokenResult.refreshToken,
      });
    } catch (e) {
      sendJson(res, 500, { ok: false, error: e.message });
    }
    return;
  }

  // 8.5 专门提取 Token 的 API (/token 页面使用)
  if (url.pathname === '/api/oauth/token-exchange' && req.method === 'POST') {
    try {
      const { code_or_url } = await readBody(req);
      if (!code_or_url) {
        sendJson(res, 400, { ok: false, error: '请粘贴回调 URL 或 Code' });
        return;
      }
      const tokenResult = await oauthFlowManager.exchangeRawInput(code_or_url);
      sendJson(res, 200, {
        ok: true,
        email: tokenResult.email,
        refreshToken: tokenResult.refreshToken,
        accessToken: tokenResult.accessToken,
      });
    } catch (e) {
      sendJson(res, 500, { ok: false, error: e.message });
    }
    return;
  }

  // 8.6 直接通过 Refresh Token 添加账号
  if (url.pathname === '/api/accounts/add-token' && req.method === 'POST') {
    try {
      const { refresh_token } = await readBody(req);
      if (!refresh_token || !refresh_token.trim()) {
        sendJson(res, 400, { ok: false, error: '请提供有效的 Refresh Token' });
        return;
      }
      const result = await oauthFlowManager.validateAndAddRefreshToken(refresh_token);
      sendJson(res, 200, {
        ok: true,
        message: `账号 ${result.email} 验证通过并已成功加入账号池！`,
        email: result.email,
      });
    } catch (e) {
      sendJson(res, 500, { ok: false, error: e.message });
    }
    return;
  }

  // 8.7 账号导出（含 Refresh Token，可直接回导）
  if (url.pathname === '/api/accounts/export') {
    const only = (url.searchParams.get('email') || '').trim().toLowerCase();
    const accounts = [];
    for (const [email, tm] of accountPool.managers.entries()) {
      if (only && email !== only) continue;
      if (!tm.tokenData.refreshToken) continue;
      accounts.push({ email, refresh_token: tm.tokenData.refreshToken, project_id: tm.tokenData.projectId || '' });
    }
    sendJson(res, 200, { ok: true, format: 'wag2api-ag', version: 1, exported_at: new Date().toISOString(), accounts });
    return;
  }

  // 8.8 批量导入：JSON 备份 / 多行 Refresh Token，逐个向 Google 校验后入池
  if (url.pathname === '/api/accounts/import' && req.method === 'POST') {
    const { raw } = await readBody(req);
    const items = parseAgImport(raw);
    if (!items.length) {
      sendJson(res, 400, { ok: false, error: '没有识别到 Refresh Token（应以 1// 开头）' });
      return;
    }
    const added = [], failed = [];
    for (const it of items) {
      try {
        const r = await oauthFlowManager.validateAndAddRefreshToken(it.refresh_token);
        added.push(r.email);
      } catch (e) {
        failed.push({ email: it.email || it.refresh_token.slice(0, 12) + '…', error: e.message });
      }
    }
    sendJson(res, 200, { ok: added.length > 0, added, failed, message: `导入成功 ${added.length} 个${failed.length ? `，失败 ${failed.length} 个` : ''}` });
    return;
  }

  // 8.9 全部账号汇总的 24 小时趋势
  if (url.pathname === '/api/trend') {
    sendJson(res, 200, statsTracker.getAggregateTrend());
    return;
  }

  // 9. 账号切换与管理
  if (url.pathname === '/api/accounts/switch' && req.method === 'POST') {
    try {
      const { email } = await readBody(req);
      accountPool.switchAccount(email);
      sendJson(res, 200, { ok: true, message: `已切换至账号 ${email}` });
    } catch (e) {
      sendJson(res, 500, { ok: false, error: e.message });
    }
    return;
  }

  if (url.pathname === '/api/accounts/remove' && req.method === 'POST') {
    try {
      const { email } = await readBody(req);
      accountPool.removeAccount(email);
      sendJson(res, 200, { ok: true, message: `已移除账号 ${email}` });
    } catch (e) {
      sendJson(res, 500, { ok: false, error: e.message });
    }
    return;
  }

  // 10. 核心推理接口：OpenAI (/v1/chat/completions) 与 Anthropic (/v1/messages) 双协议兼容
  const isOaiChat = url.pathname === '/v1/chat/completions';
  const isAnthropicMsg = url.pathname === '/v1/messages';
  if ((isOaiChat || isAnthropicMsg) && req.method === 'POST') {
    readRawBody(req).then(async (body) => {
      const startTime = Date.now();
      // PR2 分段打点：各时间点均为相对 startTime 的毫秒数；多次尝试时保留最后一次（即最终生效的那次）
      const timing = { t_token: null, t_payload: null, t_headers: null, t_tls: null, conn_reused: null, host: null, attempts: 0, switched_account: false, switched_host: false };
      const mark = (k) => { timing[k] = Date.now() - startTime; };
      const markHeaders = (u, r) => { mark('t_headers'); try { timing.host = new URL(u).hostname; } catch (e) {} if (r) { timing.conn_reused = r._gwReused ?? null; timing.t_tls = r._gwTlsMs ?? null; } };
      const timingOut = (extra = {}) => ({ ...timing, switched_host: Boolean(timing.host && timing.host !== DAILY_HOST), ...extra });
      let statsRecorded = false;
      let statsEmail = null;
      let statsModel = null;
      try {
        if (access.enabled && !access.isAdmin(req)) {
          if (isOaiChat) {
            sendJson(res, 401, { error: { message: 'Incorrect API key', type: 'invalid_request_error' } });
          } else {
            sendJson(res, 401, { type: 'error', error: { type: 'authentication_error', message: 'API Key 无效或缺失 (x-api-key)' } });
          }
          return;
        }

        const rawParsed = JSON.parse(body || '{}');
        const anthropicReq = isOaiChat ? openaiRequestToAnthropic(rawParsed) : rawParsed;
        if (isOaiChat && rawParsed.stream !== undefined) {
          anthropicReq.stream = Boolean(rawParsed.stream);
        }
        statsModel = anthropicReq.model;

        // Google / Antigravity 路由通道
        // OpenAI 请求体里的 session_id / conversation_id / metadata 在协议转换时会丢，取会话 id 时用原始请求体（不使用常被设成固定值的 user 字段）
        anthropicReq._gwSessionKey = clientSessionKey(req.headers, isOaiChat ? { ...rawParsed, user: undefined } : anthropicReq);
        lastClientHeaders = {
          names: Object.keys(req.headers).sort(),
          metadataKeys: Object.keys(anthropicReq.metadata || {}),
          hasClientSession: Boolean(anthropicReq._gwSessionKey),
        };

        // 智能选号：优先命中会话亲和表（保持 KV-Cache），新会话按最小负载轮询分发，支持 429 冷却避障
        let activeMgr = accountPool.pickManager(anthropicReq._gwSessionKey);
        if (!activeMgr) {
          const errMsg = '账号池暂无可用 Google 账号，请在控制台添加账号';
          if (isOaiChat) {
            sendJson(res, 503, { error: { message: errMsg, type: 'server_error' } });
          } else {
            sendJson(res, 401, { error: { type: 'authentication_error', message: errMsg } });
          }
          return;
        }

        statsEmail = activeMgr.tokenData.email;
        const isStreaming = Boolean(anthropicReq.stream);

        // PR1：失败处理收敛到 upstream-policy（400 直接返回；429 冷却换号；5xx/超时换 host 一次再换号一次；最后才降级）
        const send = async (payload, mgr, host, timeoutMs) => {
          const tok = await mgr.getValidAccessToken();
          const targetUrl = isStreaming ? `${host}/v1internal:streamGenerateContent?alt=sse` : `${host}/v1internal:generateContent`;
          timing.attempts++;
          const ac = timeoutMs ? new AbortController() : null;
          const timer = ac ? setTimeout(() => {
            const e = new Error(`upstream header timeout ${timeoutMs}ms`); e.name = 'TimeoutError'; ac.abort(e);
          }, timeoutMs) : null;
          try {
            const r = await upstreamFetch(targetUrl, {
              method: 'POST',
              headers: buildAntigravityHeaders(tok),
              body: JSON.stringify(payload),
              ...(ac ? { signal: ac.signal } : {}),
            });
            markHeaders(targetUrl, r);
            return r;
          } finally {
            if (timer) clearTimeout(timer);
          }
        };

        const result = await runWithPolicy({
          model: anthropicReq.model,
          anthropicReq,
          upstreamOf: mapToUpstreamModel,
          accounts: () => Array.from(accountPool.managers.values()),
          activeEmail: activeMgr.tokenData.email,
          quotaOf: email => quotaCache.get(email) ?? null,
          cooldowns,
          prepare: async (mgr) => {
            const tok = await mgr.getValidAccessToken();
            if (!tok) return false;
            if (!mgr.tokenData.projectId && typeof mgr.ensureProjectId === 'function') {
              await mgr.ensureProjectId().catch(() => '');
            }
            mark('t_token');
            return true;
          },
          buildPayload: (model, mgr) => {
            if (model === anthropicReq.model) {
              anthropicReq._gwEmail = mgr.tokenData.email;
              const p = buildCloudCodePayload(anthropicReq, mgr.tokenData.projectId);
              cacheProbe.record(mgr.tokenData.email, anthropicReq.model, p);
              mark('t_payload');
              return p;
            }
            const p = buildCloudCodePayload({ ...anthropicReq, model, _gwEmail: mgr.tokenData.email }, mgr.tokenData.projectId);
            mark('t_payload');
            return p;
          },
          onBadRequest: (body, mgr) => bumpSessionOnOverflow(anthropicReq, mgr.tokenData.email, body),
          send,
          hosts: [ANTIGRAVITY_ENDPOINT_DAILY, ANTIGRAVITY_ENDPOINT_AUTOPUSH],
          chain: MODEL_FALLBACK_CHAINS[anthropicReq.model] || [],
          allowDowngrade: POLICY.allowDowngrade,
          headerTimeoutMs: isStreaming ? POLICY.streamHeaderTimeoutMs : POLICY.nonStreamHeaderTimeoutMs,
          deadlineMs: POLICY.retryDeadlineMs,
          startedAt: startTime,
          log: m => console.warn(m),
        });

        timing.switched_account = result.switchedAccount;
        if (result.mgr) {
          activeMgr = result.mgr;
          statsEmail = activeMgr.tokenData.email;
          if (anthropicReq._gwSessionKey) {
            accountPool.bindSession(anthropicReq._gwSessionKey, activeMgr.tokenData.email);
          }
        }
        const modelUsed = result.modelUsed || anthropicReq.model;
        const dg = { model_used: modelUsed, downgraded: Boolean(result.downgraded), downgrade_reason: result.reason && result.downgraded ? result.reason : null };
        res.setHeader('X-Gateway-Model-Requested', String(anthropicReq.model || ''));
        res.setHeader('X-Gateway-Model-Used', String(modelUsed || ''));
        if (dg.downgraded) {
          res.setHeader('X-Gateway-Downgrade-Reason', dg.downgrade_reason);
          console.warn(`[Downgrade] ${anthropicReq.model} → ${modelUsed}（${dg.downgrade_reason}）`);
        }
        const notice = dg.downgraded && shouldInsertNotice(anthropicReq) ? buildDowngradeNotice(anthropicReq.model, modelUsed, dg.downgrade_reason) : null;

        if (!result.ok) {
          const e = result.error || {};
          const errDetail = e.body || 'Google 集群无响应';
          let status = 502, type = 'upstream_error';
          if (e.kind === 'bad_request') { status = e.status >= 400 && e.status < 500 ? e.status : 400; type = 'invalid_request_error'; }
          else if (e.kind === 'quota') {
            status = 429;
            type = 'rate_limit_error';
            accountPool.markCooling(activeMgr.tokenData.email, (e.retryDelaySec || 10) * 1000);
          }
          if (result.reason && e.kind !== 'bad_request') res.setHeader('X-Gateway-Failure-Reason', result.reason);

          if (isOaiChat) {
            sendJson(res, status, { error: { message: errDetail, type, code: status } });
          } else {
            sendJson(res, status, { type: 'error', error: { type, message: errDetail } });
          }
          statsTracker.recordRequest({
            email: activeMgr.tokenData.email,
            model: anthropicReq.model,
            latency_ms: Date.now() - startTime,
            status,
            error: String(errDetail).slice(0, 100),
            timing: timingOut(),
            ...dg,
          });
          statsRecorded = true;
          return;
        }
        const response = result.response;

        if (isStreaming) {
          const streamHandler = isOaiChat ? handleOpenAIStreamConversion : handleStreamConversion;
          await streamHandler(response, res, modelUsed, (usage) => {
            const status = usage.outcome === 'ok' ? 200 : usage.outcome === 'client_abort' ? 499 : 502;
            statsTracker.recordRequest({
              email: activeMgr.tokenData.email,
              model: anthropicReq.model,
              latency_ms: Date.now() - startTime,
              ttft_ms: usage.ttft_ms,
              status,
              is_stream: true,
              input_tokens: usage.input_tokens,
              output_tokens: usage.output_tokens,
              cached_tokens: usage.cached_tokens,
              thoughts_tokens: usage.thoughts_tokens,
              error: usage.error || null,
              timing: timingOut({ t_first_thought: usage.t_first_thought ?? null, t_first_text: usage.t_first_text ?? null }),
              ...dg,
            });
          }, startTime, { notice });
        } else {
          const googleData = await response.json();
          if (isOaiChat) {
            const oaiResp = convertGoogleToOpenAI(googleData, modelUsed);
            if (notice && oaiResp.choices?.[0]?.message) {
              const m = oaiResp.choices[0].message;
              m.content = (m.content ? notice + m.content : notice);
            }
            sendJson(res, 200, oaiResp);
            const u = oaiResp._gw_usage || {};
            statsTracker.recordRequest({
              email: activeMgr.tokenData.email,
              model: anthropicReq.model,
              latency_ms: Date.now() - startTime,
              status: 200,
              is_stream: false,
              input_tokens: u.input_tokens || 0,
              output_tokens: u.output_tokens || 0,
              cached_tokens: u.cached_tokens || 0,
              thoughts_tokens: u.thoughts_tokens || 0,
              timing: timingOut(),
              ...dg,
            });
          } else {
            const anthropicResp = convertGoogleToAnthropic(googleData, modelUsed);
            if (notice) {
              const tb = anthropicResp.content.find(b => b.type === 'text');
              if (tb) tb.text = notice + tb.text;
            }
            sendJson(res, 200, anthropicResp);

            const u = anthropicResp._gw_usage || {};
            statsTracker.recordRequest({
              email: activeMgr.tokenData.email,
              model: anthropicReq.model,
              latency_ms: Date.now() - startTime,
              status: 200,
              is_stream: false,
              input_tokens: u.input_tokens || 0,
              output_tokens: u.output_tokens || 0,
              cached_tokens: u.cached_tokens || 0,
              thoughts_tokens: u.thoughts_tokens || 0,
              timing: timingOut(),
              ...dg,
            });
          }
        }
        statsRecorded = true;
      } catch (err) {
        console.error('[Inference Handler Error]', err);
        if (!statsRecorded && statsEmail) {
          statsTracker.recordRequest({
            email: statsEmail,
            model: statsModel,
            latency_ms: Date.now() - startTime,
            status: 500,
            error: String(err?.message || err).slice(0, 100),
            timing: timingOut(),
          });
        }
        if (!res.headersSent) {
          if (isOaiChat) {
            sendJson(res, 500, {
              error: {
                message: err.message,
                type: 'api_error',
              },
            });
          } else {
            sendJson(res, 500, {
              error: {
                type: 'api_error',
                message: err.message,
              },
            });
          }
        }
      }
    });
    return;
  }

  console.warn('[404]', req.method, req.url);
  sendJson(res, 404, { error: 'Endpoint not found', method: req.method, path: url.pathname });
});

server.keepAliveTimeout = 120000;
server.headersTimeout = 125000;

// 单文件版默认对外监听，首次运行若没有密钥就自动生成一个，避免裸奔
if ((IS_BINARY || process.env.AUTO_KEY === '1') && !access.enabled && process.env.NO_AUTH !== '1') {
  access.adminKey = 'sk-ag-' + crypto.randomBytes(18).toString('base64url');
  access.save();
}

const HOST = process.env.HOST || '0.0.0.0';
const PUBLIC_BIND = ['0.0.0.0', '::', ''].includes(HOST.trim());

// 统一的优雅退出：宿主关闭引擎时先 drain 再 SIGTERM，Linux systemd 同样受益。
// 必须在 server.close() 前 flush 统计，且不能有其它监听器提前 process.exit。
let shuttingDown = false;
for (const sig of ['SIGTERM', 'SIGINT']) {
  process.once(sig, async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`收到 ${sig}，正在安全退出…`);
    try { statsTracker.flush(); } catch (e) {}
    try { if (wb) wb.flush(); } catch (e) {}
    try {
      if (persist.enabled) {
        await Promise.race([
          persist.syncStats(),
          new Promise(r => setTimeout(r, 8000)),
        ]);
      }
    } catch (e) {}
    // 强制 3 秒后退出，避免卡死的长连接拖住进程
    const force = setTimeout(() => process.exit(0), 3000);
    force.unref();
    server.close(() => process.exit(0));
  });
}

server.listen(PORT, HOST, () => {
  // PR4：启动即预热（不阻塞监听）
  setTimeout(() => { prewarm(accountPool, { reason: 'start', force: true }).then(r => console.log(`[Prewarm] start ok=${r.ok} conn=${r.t_conn}ms tls=${r.tls_ms}ms`)).catch(() => {}); }, 500).unref?.();
  const lan = Object.values(os.networkInterfaces()).flat().filter(i => i && i.family === 'IPv4' && !i.internal).map(i => i.address);
  console.log(`🚀 wag2api 已启动`);
  console.log(`   本机:   http://127.0.0.1:${PORT}`);
  if (HOST === '0.0.0.0') lan.forEach(ip => console.log(`   局域网: http://${ip}:${PORT}`));
  console.log(`   数据:   ${DATA_DIR}`);
  console.log(wb ? `   引擎:   WB + AG（默认 ${wb.defaultEngine().toUpperCase()}，模型名加 wb: / ag: 可强制指定）` : '   引擎:   仅 AG');
  console.log(access.enabled ? `   密钥:   ${access.adminKey}` : '   密钥:   未设置（任何人都能访问，建议设置 ADMIN_KEY）');
  if (PUBLIC_BIND && !access.enabled) {
    const bar = '!'.repeat(64);
    console.warn([
      '', bar,
      '!!  安全警告：正在监听所有网卡（HOST=' + (HOST || '0.0.0.0') + '），且没有设置 ADMIN_KEY',
      '!!  同一网络 / 公网上的任何人都能：',
      '!!    · 调用 /panel/api/tokens/export、/api/accounts/export 导出全部 WB / AG Token',
      '!!    · 用你的账号额度调用 /v1/*',
      '!!  修复：设置 ADMIN_KEY=<足够长的随机串>，或只在本机监听 HOST=127.0.0.1',
      bar, '',
    ].join('\n'));
  }
});
