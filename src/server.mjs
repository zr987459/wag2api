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
import { fetchRealQuota } from './quota-fetcher.mjs';
import { getModelsResponse } from './models-catalog.mjs';
import { parseAgImport } from './ag-import.mjs';
import { statsTracker } from './stats.mjs';
import { ANTIGRAVITY_ENDPOINTS, ANTIGRAVITY_ENDPOINT_DAILY } from './constants.mjs';
import { AccessControl } from './access-control.mjs';
import { Persist } from './persist.mjs';
import {
  buildAntigravityHeaders,
  buildCloudCodePayload,
  MODEL_FALLBACK_CHAINS,
} from './cloudcode.mjs';
import { convertGoogleToAnthropic } from './content-converter.mjs';
import { handleStreamConversion } from './sse-streamer.mjs';
import { cacheProbe } from './cache-probe.mjs';
import { historyPin } from './history-pin.mjs';
import { clientSessionKey, bumpSessionOnOverflow, sessionStats } from './session-router.mjs';

let lastClientHeaders = null;

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
  '/api/accounts/remove', '/api/accounts/export', '/api/accounts/import', '/api/trend',
]);


function readBody(req) {
  return new Promise(resolve => {
    let b = '';
    req.on('data', c => (b += c));
    req.on('end', () => {
      try { resolve(JSON.parse(b || '{}')); } catch (e) { resolve({}); }
    });
  });
}

// 控制台网页：与安卓共用 app/app/src/main/assets/web（单文件版打包进 EMBED.web）
const WEB_TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'application/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png' };
const WEB_DIR = [process.env.WEB_DIR, path.join(__dirname, 'web'), path.join(__dirname, '..', 'app', 'app', 'src', 'main', 'assets', 'web')]
  .find(d => d && fs.existsSync(path.join(d, 'index.html')));

function serveWeb(pathname, res) {
  const name = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
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

  // 1. 控制台（新版双引擎界面；独立运行时只有 AG）
  if (req.method === 'GET' && (url.pathname === '/' || /^\/[A-Za-z0-9_.-]+\.(html|js|css|json|svg|png)$/.test(url.pathname)) && serveWeb(url.pathname, res)) {
    return;
  }
  if (url.pathname === '/token' || url.pathname === '/get-token' || url.pathname === '/token.html') {
    res.writeHead(302, { Location: '/' });
    res.end();
    return;
  }

  // 1.0.1 独立运行时（Linux / 源码）给新界面一个引擎状态，界面据此隐藏 WB
  if (url.pathname === '/panel/api/engine/state') {
    sendJson(res, 200, { supported: true, enabled: true, state: 'READY', port: PORT, default_engine: 'ag', standalone: true, auth: access.enabled });
    return;
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
    sendJson(res, 200, quotaData);
    return;
  }

  // 3. 统计数据与日志
  if (url.pathname === '/api/stats') {
    sendJson(res, 200, statsTracker.getStats());
    return;
  }

  if (url.pathname === '/api/debug/cache') {
    sendJson(res, 200, { pin: historyPin.stats(), session: sessionStats(), clientHeaders: lastClientHeaders, requests: cacheProbe.report() });
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

  // 4. 模型列表接口
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

  // 9.5 OpenAI 兼容接口：/v1/chat/completions
  if (url.pathname === '/v1/chat/completions' && req.method === 'POST') {
    if (access.enabled && !access.isAdmin(req)) {
      sendJson(res, 401, { error: { message: 'Incorrect API key', type: 'invalid_request_error' } });
      return;
    }
    sendJson(res, 400, { error: { message: '暂不支持 /v1/chat/completions，请使用 Anthropic 协议的 /v1/messages', type: 'invalid_request_error' } });
    return;
  }

  // 10. 核心 Anthropic 协议推理接口：/v1/messages
  if (url.pathname === '/v1/messages' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => (body += chunk));
    req.on('end', async () => {
      const startTime = Date.now();
      let statsRecorded = false;
      let statsEmail = null;
      let statsModel = null;
      try {
        if (access.enabled && !access.isAdmin(req)) {
          sendJson(res, 401, { type: 'error', error: { type: 'authentication_error', message: 'API Key 无效或缺失 (x-api-key)' } });
          return;
        }

        const anthropicReq = JSON.parse(body);
        statsModel = anthropicReq.model;

        // Google / Antigravity 路由通道
        anthropicReq._gwSessionKey = clientSessionKey(req.headers, anthropicReq);
        lastClientHeaders = {
          names: Object.keys(req.headers).sort(),
          metadataKeys: Object.keys(anthropicReq.metadata || {}),
          hasClientSession: Boolean(anthropicReq._gwSessionKey),
        };

        let activeMgr = accountPool.getActiveManager();
        if (!activeMgr) {
          sendJson(res, 401, {
            error: {
              type: 'authentication_error',
              message: '账号池暂无可用 Google 账号，请在控制台添加账号',
            },
          });
          return;
        }

        statsEmail = activeMgr.tokenData.email;
        let accessToken = await activeMgr.getValidAccessToken();
        const isStreaming = Boolean(anthropicReq.stream);
        let lastFailedDetails = null;

        let response = null;
        const trySendToAccount = async (mgr) => {
          let tok = await mgr.getValidAccessToken();
          if (!tok) return null;
          if (!mgr.tokenData.projectId && typeof mgr.ensureProjectId === 'function') {
            await mgr.ensureProjectId().catch(() => '');
          }
          anthropicReq._gwEmail = mgr.tokenData.email;
          let p = buildCloudCodePayload(anthropicReq, mgr.tokenData.projectId);
          cacheProbe.record(mgr.tokenData.email, anthropicReq.model, p);

          const streamUrl = `${ANTIGRAVITY_ENDPOINT_DAILY}/v1internal:streamGenerateContent?alt=sse`;
          const nonStreamUrl = `${ANTIGRAVITY_ENDPOINT_DAILY}/v1internal:generateContent`;
          const targetUrl = isStreaming ? streamUrl : nonStreamUrl;

          let r = await fetch(targetUrl, {
            method: 'POST',
            headers: buildAntigravityHeaders(tok),
            body: JSON.stringify(p),
          });

          if (r && r.status === 400) {
            const errText = await r.clone().text().catch(() => '');
            if (bumpSessionOnOverflow(anthropicReq, mgr.tokenData.email, errText)) {
              p = buildCloudCodePayload(anthropicReq, mgr.tokenData.projectId);
              r = await fetch(targetUrl, {
                method: 'POST',
                headers: buildAntigravityHeaders(tok),
                body: JSON.stringify(p),
              });
            }
          }
          return r;
        };

        try {
          response = await trySendToAccount(activeMgr);
          if (response && (response.status === 429 || response.status === 403 || response.status === 401)) {
            const errBody = await response.clone().text().catch(() => '');
            if (response.status === 429 || /RESOURCE_EXHAUSTED|quota/i.test(errBody)) {
              console.warn(`[Failover] 主账号 ${activeMgr.tokenData.email} 触发配额耗尽(${response.status})，借调备用账号...`);
              const altMgr = accountPool.rotateToNext();
              if (altMgr && altMgr !== activeMgr) {
                const altResp = await trySendToAccount(altMgr);
                if (altResp && altResp.ok) {
                  activeMgr = altMgr;
                  accessToken = await activeMgr.getValidAccessToken();
                  statsEmail = activeMgr.tokenData.email;
                  response = altResp;
                }
              }
            }
          }
        } catch (e) {
          lastFailedDetails = { status: 500, body: e.message };
        }

        if (!response || !response.ok) {
          const executeAttempt = async (modelToUse) => {
            const reqCopy = { ...anthropicReq, model: modelToUse };
            const payload = buildCloudCodePayload(reqCopy, activeMgr.tokenData.projectId);
            const headers = buildAntigravityHeaders(accessToken);

            for (const host of ANTIGRAVITY_ENDPOINTS) {
              const upstreamEndpoint = isStreaming
                ? `${host}/v1internal:streamGenerateContent?alt=sse`
                : `${host}/v1internal:generateContent`;

              try {
                const r = await fetch(upstreamEndpoint, {
                  method: 'POST',
                  headers,
                  body: JSON.stringify(payload),
                });
                if (r.ok) return r;
                const errText = await r.text().catch(() => '');
                lastFailedDetails = { status: r.status, body: errText };
              } catch (e) {
                lastFailedDetails = { status: 500, body: e.message };
              }
            }
            return null;
          };

          response = await executeAttempt(anthropicReq.model);
          if (!response || !response.ok) {
            const fallbacks = MODEL_FALLBACK_CHAINS[anthropicReq.model] || [];
            for (const fallbackModel of fallbacks) {
              response = await executeAttempt(fallbackModel);
              if (response && response.ok) break;
            }
          }
        }

        if (!response || !response.ok) {
          const errDetail = lastFailedDetails ? lastFailedDetails.body : 'Google 集群无响应';
          sendJson(res, 502, {
            error: {
              type: 'upstream_error',
              message: errDetail,
            },
          });
          statsTracker.recordRequest({
            email: activeMgr.tokenData.email,
            model: anthropicReq.model,
            latency_ms: Date.now() - startTime,
            status: 502,
            error: String(errDetail).slice(0, 100),
          });
          statsRecorded = true;
          return;
        }

        if (isStreaming) {
          await handleStreamConversion(response, res, anthropicReq.model, (usage) => {
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
            });
          }, startTime);
        } else {
          const googleData = await response.json();
          const anthropicResp = convertGoogleToAnthropic(googleData, anthropicReq.model);
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
          });
        }
        statsRecorded = true;
      } catch (err) {
        console.error('[Messages Handler Error]', err);
        if (!statsRecorded && statsEmail) {
          statsTracker.recordRequest({
            email: statsEmail,
            model: statsModel,
            latency_ms: Date.now() - startTime,
            status: 500,
            error: String(err?.message || err).slice(0, 100),
          });
        }
        if (!res.headersSent) {
          sendJson(res, 500, {
            error: {
              type: 'api_error',
              message: err.message,
            },
          });
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

// 统一的优雅退出：宿主关闭引擎时先 drain 再 SIGTERM，Linux systemd 同样受益。
// 必须在 server.close() 前 flush 统计，且不能有其它监听器提前 process.exit。
let shuttingDown = false;
for (const sig of ['SIGTERM', 'SIGINT']) {
  process.once(sig, async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`收到 ${sig}，正在安全退出…`);
    try { statsTracker.flush(); } catch (e) {}
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
  const lan = Object.values(os.networkInterfaces()).flat().filter(i => i && i.family === 'IPv4' && !i.internal).map(i => i.address);
  console.log(`🚀 wag2api 已启动`);
  console.log(`   本机:   http://127.0.0.1:${PORT}`);
  if (HOST === '0.0.0.0') lan.forEach(ip => console.log(`   局域网: http://${ip}:${PORT}`));
  console.log(`   数据:   ${DATA_DIR}`);
  console.log(access.enabled ? `   密钥:   ${access.adminKey}` : '   密钥:   未设置（任何人都能访问，建议设置 ADMIN_KEY）');
});
