/**
 * WB 引擎（腾讯 WorkBuddy）的 Node 实现，供 Linux / 源码版使用。
 * 安卓上 WB 由 Kotlin 处理，这个模块不会被加载（server.mjs 在 ENGINE_TOKEN 模式下跳过）。
 *
 * 对外：
 *   wb.handlePanel(req, res, url, raw)   /panel/api/* 与 /m/api/*（返回格式与 LocalGatewayServer.kt 一致）
 *   wb.handleChat(req, res, body)        /v1/chat/completions（OpenAI）
 *   wb.handleMessages(req, res, body)    /v1/messages（Anthropic）
 */
import path from 'path';
import { AccountVault } from './vault.mjs';
import { AccountScheduler } from './scheduler.mjs';
import { TokenKeeper } from './token-keeper.mjs';
import { GatewayMetrics, usageFromOpenAi } from './metrics.mjs';
import { TencentGateway, UpstreamError } from './gateway.mjs';
import { runConnectivityTest } from './connectivity.mjs';
import { Settings } from './store.mjs';
import { wbModels, DEFAULT_MODEL } from './constants.mjs';
import { convertRequest, convertResponse, AnthropicStreamTranslator, conversationId } from './convert.mjs';

export { decide, mergedModels, normalizePath } from './router.mjs';
export { wbModels } from './constants.mjs';

const VERSION = '1.3.0-node';

function sendJson(res, status, obj) {
  if (res.headersSent) return;
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(typeof obj === 'string' ? obj : JSON.stringify(obj));
}

function sseHead(res) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    'X-Accel-Buffering': 'no',
    Connection: 'keep-alive',
  });
  if (res.flushHeaders) res.flushHeaders();
}

/** 与 LocalGatewayServer.errorPayload 一致 */
export function errorPayload(e) {
  let status = 500, type = 'gateway_error';
  if (e instanceof UpstreamError) {
    if (e.code === 11128) { status = 403; type = 'upstream_channel_rejected'; }
    else if (e.status === 403) { status = 403; type = 'upstream_forbidden'; }
    else if (e.status === 429 || e.code === 14003) { status = 529; type = 'overloaded_error'; }
    else { status = 502; type = 'upstream_error'; }
  }
  const message = type === 'overloaded_error' ? '上游模型繁忙，请稍后重试（已自动尝试切换账号）' : (e && e.message) || type;
  const err = { message, type };
  if (e instanceof UpstreamError) err.code = e.code ?? e.status;
  return [status, { type: 'error', error: err }];
}

const hasDelta = c => {
  const d = c && Array.isArray(c.choices) && c.choices[0] && c.choices[0].delta;
  return Boolean(d && (d.content || d.reasoning_content || d.tool_calls));
};

const syncUsage = res => usageFromOpenAi(res.usage)
  || usageFromOpenAi({ prompt_tokens: res.prompt_tokens || 0, completion_tokens: res.completion_tokens || 0 });

function parseJson(raw) {
  if (!raw) return {};
  try { const v = JSON.parse(raw); return v && typeof v === 'object' ? v : {}; } catch (e) { return {}; }
}

export function createWbEngine({
  dataDir,
  port = 8790,
  defaultEngine = 'wb',
  fetchImpl = (...a) => fetch(...a),
  log = console,
  authEnabled = () => false,
  backoffMs,
  onChange = () => {},
} = {}) {
  const dir = path.join(dataDir, 'wb');
  const settings = new Settings(dir, { default_engine: defaultEngine === 'ag' ? 'ag' : 'wb' }, onChange);
  const vault = new AccountVault(dir, onChange);
  const scheduler = new AccountScheduler(vault, settings);
  const tokenKeeper = new TokenKeeper(vault, { fetchImpl, log });
  const metrics = new GatewayMetrics(dir);
  const gateway = new TencentGateway({ vault, scheduler, tokenKeeper, fetchImpl, log, ...(backoffMs !== undefined ? { backoffMs } : {}) });

  const clientSignal = (req, res) => {
    const ctl = new AbortController();
    res.on('close', () => { if (!res.writableFinished) ctl.abort(); });
    return ctl.signal;
  };

  async function handleChat(req, res, json) {
    const start = Date.now();
    const model = json.model || DEFAULT_MODEL;
    const convId = conversationId(req.headers, json);
    const signal = clientSignal(req, res);
    if (!json.stream) {
      try {
        const r = await gateway.chatSync(json, convId, { signal });
        const pt = r.prompt_tokens ?? 20, ct = r.completion_tokens ?? 20;
        const message = { role: 'assistant', content: r.content };
        if (r.reasoning_content) message.reasoning_content = r.reasoning_content;
        if (r.tool_calls) message.tool_calls = r.tool_calls;
        metrics.record('POST', '/v1/chat/completions', model, 'sync', 200, syncUsage(r), Date.now() - start);
        sendJson(res, 200, {
          id: `chatcmpl_${Date.now()}`, object: 'chat.completion', created: Math.floor(Date.now() / 1000), model,
          choices: [{ index: 0, message, finish_reason: r.tool_calls ? 'tool_calls' : 'stop' }],
          usage: { prompt_tokens: pt, completion_tokens: ct, total_tokens: pt + ct },
        });
      } catch (e) {
        const [st, body] = errorPayload(e);
        metrics.record('POST', '/v1/chat/completions', model, 'sync', st, 0, Date.now() - start, null, e.message);
        sendJson(res, st, body);
      }
      return;
    }
    sseHead(res);
    let usage = null, ttft = null;
    try {
      await gateway.streamChat(json, convId, line => {
        if (res.destroyed) return false;
        if (line.startsWith('data: ')) {
          const s = line.slice(6).trim();
          if (s.startsWith('{')) {
            try {
              const c = JSON.parse(s);
              if (c.usage && typeof c.usage === 'object') usage = c.usage;
              if (ttft === null && hasDelta(c)) ttft = Date.now() - start;
            } catch (e) { /* 原样透传 */ }
          }
        }
        res.write(line);
        return true;
      }, { signal });
      metrics.record('POST', '/v1/chat/completions', model, 'stream', 200, usageFromOpenAi(usage), Date.now() - start, ttft);
    } catch (e) {
      const [st, payload] = errorPayload(e);
      metrics.record('POST', '/v1/chat/completions', model, 'stream', st, 0, Date.now() - start, null, e.message);
      if (!res.destroyed) { res.write(`data: ${JSON.stringify(payload)}\n\n`); res.write('data: [DONE]\n\n'); }
    } finally {
      if (!res.writableEnded) res.end();
    }
  }

  async function handleMessages(req, res, json) {
    const start = Date.now();
    const modelRaw = json.model || DEFAULT_MODEL;
    let oaiReq, convId;
    try {
      convId = conversationId(req.headers, json);
      oaiReq = convertRequest(json);
    } catch (e) {
      const [st, body] = errorPayload(e);
      metrics.record('POST', '/v1/messages', modelRaw, 'error', st, 0, Date.now() - start, null, e.message);
      sendJson(res, st, body);
      return;
    }
    const signal = clientSignal(req, res);
    if (!json.stream) {
      try {
        const r = await gateway.chatSync(oaiReq, convId, { signal });
        // chatSync 返回扁平结构，这里补成 OpenAI 响应再转换（安卓版此处会因缺 choices 报错）
        const message = { role: 'assistant', content: r.content };
        if (r.tool_calls) message.tool_calls = r.tool_calls;
        const oai = {
          choices: [{ message, finish_reason: r.tool_calls ? 'tool_calls' : 'stop' }],
          usage: { prompt_tokens: r.prompt_tokens, completion_tokens: r.completion_tokens },
        };
        const out = convertResponse(oai, modelRaw);
        if (r.reasoning_content) out.content.unshift({ type: 'thinking', thinking: r.reasoning_content, signature: '' });
        metrics.record('POST', '/v1/messages', modelRaw, 'sync', 200, syncUsage(r), Date.now() - start);
        sendJson(res, 200, out);
      } catch (e) {
        const [st, body] = errorPayload(e);
        metrics.record('POST', '/v1/messages', modelRaw, 'sync', st, 0, Date.now() - start, null, e.message);
        sendJson(res, st, body);
      }
      return;
    }
    sseHead(res);
    const translator = new AnthropicStreamTranslator(modelRaw, (event, data) => {
      if (!res.destroyed) res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    });
    let usage = null, ttft = null;
    try {
      await gateway.streamChat(oaiReq, convId, line => {
        if (res.destroyed) return false;
        const t = line.trim();
        if (t.startsWith('data: ') && t !== 'data: [DONE]') {
          try {
            const chunk = JSON.parse(t.slice(6));
            if (chunk.usage && typeof chunk.usage === 'object') usage = chunk.usage;
            if (ttft === null && hasDelta(chunk)) ttft = Date.now() - start;
            translator.onChunk(chunk);
          } catch (e) { /* 非 JSON 帧忽略 */ }
        }
        return true;
      }, { signal });
      translator.finish();
      metrics.record('POST', '/v1/messages', modelRaw, 'stream', 200, usageFromOpenAi(usage), Date.now() - start, ttft);
    } catch (e) {
      const [st, body] = errorPayload(e);
      metrics.record('POST', '/v1/messages', modelRaw, 'stream', st, 0, Date.now() - start, null, e.message);
      try { translator.abort(body); } catch (e2) { /* ignore */ }
    } finally {
      if (!res.writableEnded) res.end();
    }
  }

  /** 引擎状态：Linux 版两个引擎同进程常驻 */
  function engineState() {
    return {
      supported: true, enabled: true, state: 'READY', port,
      default_engine: settings.get('default_engine') === 'ag' ? 'ag' : 'wb',
      standalone: false, dual: true, auth: authEnabled(),
    };
  }

  const routes = {
    overview: () => {
      const accounts = vault.getAccounts();
      return {
        healthy: accounts.filter(a => !a.disabled).length,
        total: accounts.length,
        accounts,
        today_requests: metrics.getTodayRequests(),
        today_tokens: metrics.getTodayTokens(),
        auth_required: authEnabled(),
        version: VERSION,
      };
    },
    logs: () => ({ ok: true, logs: metrics.getLogsJson(), today_requests: metrics.getTodayRequests(), today_tokens: metrics.getTodayTokens() }),
    stats: () => metrics.statsJson(),
    'stats/reset': () => { metrics.resetStats(); return { ok: true }; },
    'logs/clear': () => { metrics.clearLogs(); return { ok: true }; },
    'tokens/export': () => vault.exportTokensJson(),
    'tokens/import': ({ body, raw }) => {
      const input = typeof body.raw === 'string' ? body.raw : raw;
      const [ok, msg] = vault.importToken(input);
      return { ok, msg };
    },
    'accounts/delete': ({ body }) => ({ ok: body.uid ? vault.deleteAccount(String(body.uid)) : false }),
    'engine/state': () => engineState(),
    'engine/toggle': () => ({ ok: true, enabled: true, msg: 'Linux / 源码版的 AG 引擎随进程常驻' }),
    'engine/restart': () => ({ ok: true, msg: 'Linux / 源码版的 AG 引擎随进程常驻，无需重启' }),
    'engine/default': ({ body }) => {
      const e = body.engine === 'ag' ? 'ag' : 'wb';
      settings.set('default_engine', e);
      return { ok: true, engine: body.engine === undefined ? 'wb' : body.engine };
    },
    pool: () => ({ ok: true, accounts: scheduler.poolStatus(), selected_uid: scheduler.getSelectedUid() }),
    'pool/select': ({ body }) => {
      const uid = body.uid ? String(body.uid) : '';
      if (!uid) return { ok: false, msg: 'uid 不能为空' };
      scheduler.setSelectedUid(uid);
      return { ok: true, uid };
    },
    'pool/clear-cooldown': () => { scheduler.clearAllCooldowns(); return { ok: true }; },
    'pool/toggle': ({ body }) => {
      const uid = body.uid ? String(body.uid) : '';
      if (uid) vault.setDisabled(uid, body.disabled === true);
      return { ok: Boolean(uid) };
    },
    'tokens/refresh': () => {
      tokenKeeper.refreshAll().catch(() => {});
      return { ok: true, msg: '已在后台刷新' };
    },
    'settings/port': ({ method }) => (method === 'POST'
      ? { ok: false, port, msg: `Linux / 源码版的端口由 PORT 环境变量决定（当前 ${port}），修改后重启生效` }
      : { ok: true, port, default_port: 8790 }),
    'settings/gateway': ({ method, body }) => {
      if (method !== 'POST') return { ok: true, enabled: settings.get('gateway_enabled') !== false };
      const on = body.enabled !== false;
      settings.set('gateway_enabled', on);
      return { ok: true, enabled: on, msg: on ? '网关已开启' : '网关已关闭' };
    },
    'accounts/export-one': ({ body }) => {
      const uid = body.uid ? String(body.uid) : '';
      if (!uid) return { ok: false, msg: 'uid 不能为空' };
      const one = vault.exportOneAccount(uid);
      return one ? { ok: true, account: one } : { ok: false, msg: '未找到该账号' };
    },
    'accounts/test': ({ body }) => runConnectivityTest({ vault, scheduler, fetchImpl }, body.uid ? String(body.uid) : '', body.model || DEFAULT_MODEL),
    'login/start': async ({ body }) => {
      try { return await gateway.startLogin(body.realm || 'global'); } catch (e) { return { ok: false, error: e.message }; }
    },
    'login/poll': ({ url }) => gateway.pollLogin(url.searchParams.get('state') || ''),
    'models/wb': () => ({ object: 'list', data: wbModels() }),
  };
  routes['auth/start'] = routes['login/start']; // /m/api/auth/start
  routes['auth/poll'] = routes['login/poll'];

  /** @returns {Promise<boolean>} 是否已处理 */
  async function handlePanel(req, res, url, raw) {
    const m = url.pathname.match(/^\/(?:panel|m)\/api\/(.+)$/);
    if (!m) return false;
    const fn = routes[m[1]];
    if (!fn) { sendJson(res, 404, { ok: false, error: 'Endpoint not found', path: url.pathname }); return true; }
    try {
      const out = await fn({ method: req.method, body: parseJson(raw), raw: raw || '', url, req });
      sendJson(res, 200, out);
    } catch (e) {
      log.error('[WB panel]', url.pathname, e);
      sendJson(res, 500, { ok: false, error: e.message });
    }
    return true;
  }

  return {
    settings, vault, scheduler, metrics, gateway, tokenKeeper,
    handlePanel, handleChat, handleMessages, engineState,
    models: wbModels,
    defaultEngine: () => (settings.get('default_engine') === 'ag' ? 'ag' : 'wb'),
    gatewayEnabled: () => settings.get('gateway_enabled') !== false,
    start: () => tokenKeeper.start(),
    flush: () => { metrics.flush(); tokenKeeper.stop(); },
  };
}
