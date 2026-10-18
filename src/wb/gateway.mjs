/**
 * 腾讯 WorkBuddy 上游（翻译自 TencentGateway.kt）。
 *
 * 流式重试三层：
 *  1. 端点回退：/v2 → /console（404 / 5xx / 渠道校验 11128 / WAF）
 *  2. 账号轮换：429 / 14003 给账号打短冷却，换下一个账号（最多 3 个）
 *  3. 全部繁忙：清冷却后退避重试 2 轮
 * 一旦向客户端吐过字就绝不重试（否则重复输出）。
 *
 * 与安卓的差异（均为修正，不改变成功路径）：
 *  - 第 3 层改成有限轮次（Kotlin 递归调用自身，持续限流时会无限递归）
 *  - 401 刷新 token 后，下一个端点用的是新 token（Kotlin 拿的是旧对象副本）
 */
import crypto from 'crypto';
import {
  UPSTREAM_GLOBAL, UPSTREAM_CN, ORIGIN_CN, CLIENT_UA, DEFAULT_SYSTEM_PROMPT, DEFAULT_MODEL, MODEL_ALIASES,
} from './constants.mjs';

const MAX_ACCOUNT_ATTEMPTS = 3;
const RETRY_BACKOFF_MS = 1200;
const FINAL_BACKOFF_ROUNDS = 2;
const READ_IDLE_MS = 180_000;
const CONNECT_MS = 15_000;

export class UpstreamError extends Error {
  constructor(status, code, endpoint, snippet) {
    super(`upstream HTTP ${status} code=${code ?? null} @ ${endpoint}: ${snippet}`);
    this.name = 'UpstreamError';
    this.status = status;
    this.code = code ?? null;
    this.endpoint = endpoint;
    this.snippet = snippet;
  }
}

const hex32 = () => crypto.randomUUID().replace(/-/g, '');
export const sha256Prefix = t => crypto.createHash('sha256').update(t, 'utf-8').digest('hex').slice(0, 36);
const sleep = ms => new Promise(r => setTimeout(r, ms));

export function upstreamCode(line) {
  const s = String(line).replace(/^data:/, '').trim();
  if (!s.startsWith('{')) return null;
  try {
    const o = JSON.parse(s);
    if (o && Object.prototype.hasOwnProperty.call(o, 'code')) { const c = parseInt(o.code, 10); return Number.isFinite(c) ? c : 0; }
  } catch (e) { /* 非 JSON */ }
  return null;
}

export function isChannelCheck(code, body) {
  if (code === 11128 || body.includes('11128') || body.includes('11-128')) {
    const lower = body.toLowerCase();
    return body.includes('渠道校验') || lower.includes('channel verification') || lower.includes('official client');
  }
  return false;
}

export const isWafBlocked = (status, body) =>
  status === 403 && (body.includes('WAF Block Page') || body.includes('myqcloud.com') || !body.includes('"code":'));

export const shouldTryNext = (status, code, body) =>
  status === 404 || status >= 500 || isChannelCheck(code, body) || isWafBlocked(status, body);

export function isRateLimited(status, code, body) {
  if (status === 429 || code === 14003) return true;
  const lower = body.toLowerCase();
  return lower.includes('too many requests') || lower.includes('model busy') || lower.includes('模型繁忙') || lower.includes('saturated');
}

export function isAuthExpired(status, body) {
  if (status === 401) return true;
  if (status === 403 && !isWafBlocked(status, body)) {
    const lower = body.toLowerCase();
    return ['unauthorized', 'token expired', 'invalid token', '登录', 'expired'].some(k => lower.includes(k));
  }
  return false;
}

export function resolveModel(modelRaw) {
  const lower = String(modelRaw || DEFAULT_MODEL).toLowerCase();
  const realm = lower.startsWith('cn:') ? 'cn' : 'global';
  let clean = lower.replace(/^global:/, '').replace(/^cn:/, '');
  clean = MODEL_ALIASES[clean] || clean;
  return { realm, clean };
}

export function upstreamHeaders({ token, uid, realm, base, convId, accept = 'application/json, text/event-stream' }) {
  const h = {
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json',
    Accept: accept,
    'Accept-Language': realm === 'global' ? 'en-US' : 'zh-CN',
    'X-Requested-With': 'XMLHttpRequest',
    'X-CodeBuddy-Request': '1',
    'User-Agent': CLIENT_UA,
    Origin: base,
    Referer: `${base}/`,
    'X-User-Id': uid,
    'X-Product': 'WorkBuddy',
    'X-Agent-Purpose': 'conversation',
    'X-IDE-Name': 'WorkBuddy',
    'X-IDE-Type': 'WorkBuddy',
    'X-IDE-Version': '5.5.4',
    'X-Machine-ID': sha256Prefix(`wb2a:machine:${uid}`),
    'X-Session-ID': sha256Prefix(`wb2a:session:${uid}`),
    'X-Conversation-ID': convId,
    'X-Conversation-Request-ID': hex32(),
    'X-Conversation-Message-ID': hex32(),
    'X-Root-Request-ID': hex32(),
    'X-Trace-ID': hex32(),
    'X-No-Enterprise-Id': '1',
  };
  if (realm === 'global') h['X-Domain'] = 'www.workbuddy.ai';
  else h['X-No-Department-Info'] = '1';
  return h;
}

/** 规范化上游请求体：model 映射、强制流式、首条 system、当前轮 assistant 补回思考内容 */
export function buildUpstreamPayload(payload, clean, reasoningLookup) {
  const up = JSON.parse(JSON.stringify(payload));
  up.model = clean;
  up.stream = true;
  up.stream_options = { include_usage: true };
  const src = Array.isArray(up.messages) ? up.messages : [];
  const norm = [];
  let hasSystem = false;
  if (src.length && src[0] && typeof src[0] === 'object') {
    if (src[0].role === 'system') hasSystem = true;
    else if (src[0].role === 'developer') { src[0].role = 'system'; hasSystem = true; }
  }
  if (!hasSystem) norm.push({ role: 'system', content: DEFAULT_SYSTEM_PROMPT });
  norm.push(...src);
  up.messages = norm;

  // 真正的新一轮 user（排除紧跟在 role:tool 后的拆分片段）
  let lastUserIdx = -1;
  norm.forEach((m, i) => {
    if (m && m.role === 'user' && !(i > 0 && norm[i - 1] && norm[i - 1].role === 'tool')) lastUserIdx = i;
  });
  if (lastUserIdx >= 0) {
    for (let i = lastUserIdx + 1; i < norm.length; i++) {
      const m = norm[i];
      if (!m || m.role !== 'assistant' || m.reasoning_content) continue;
      for (const c of Array.isArray(m.tool_calls) ? m.tool_calls : []) {
        const cached = c && c.id ? reasoningLookup(c.id) : null;
        if (cached) { m.reasoning_content = cached; break; }
      }
    }
  }
  return up;
}

/** 按行读取 fetch 响应体（\n 分隔，去掉 \r），空闲超时自动中止 */
async function* readLines(resp, ctl) {
  const reader = resp.body.getReader();
  const dec = new TextDecoder('utf-8');
  let buf = '';
  let idle = setTimeout(() => ctl.abort(new Error('upstream read timeout')), READ_IDLE_MS);
  try {
    for (;;) {
      const { value, done } = await reader.read();
      clearTimeout(idle);
      if (done) break;
      idle = setTimeout(() => ctl.abort(new Error('upstream read timeout')), READ_IDLE_MS);
      buf += dec.decode(value, { stream: true });
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        yield buf.slice(0, i).replace(/\r$/, '');
        buf = buf.slice(i + 1);
      }
    }
    buf += dec.decode();
    if (buf) yield buf.replace(/\r$/, '');
  } finally {
    clearTimeout(idle);
    try { reader.releaseLock(); } catch (e) { /* ignore */ }
  }
}

export class TencentGateway {
  constructor({ vault, scheduler, tokenKeeper, fetchImpl = (...a) => fetch(...a), log = console, backoffMs = RETRY_BACKOFF_MS }) {
    this.vault = vault;
    this.scheduler = scheduler;
    this.tokenKeeper = tokenKeeper;
    this.fetch = fetchImpl;
    this.log = log;
    this.backoffMs = backoffMs;
    this.reasoningCache = new Map(); // `${uid}:${toolCallId}` -> reasoning，LRU 100
  }

  recordReasoning(key, content) {
    if (!key || !content) return;
    this.reasoningCache.delete(key);
    this.reasoningCache.set(key, content);
    while (this.reasoningCache.size > 100) this.reasoningCache.delete(this.reasoningCache.keys().next().value);
  }

  getReasoningByToolId(id) {
    if (!id) return null;
    const suffix = `:${id}`;
    for (const [k, v] of this.reasoningCache) if (k.endsWith(suffix)) return v;
    return null;
  }

  async startLogin(realm = 'global') {
    const base = realm === 'global' ? UPSTREAM_GLOBAL : UPSTREAM_CN;
    const origin = realm === 'global' ? UPSTREAM_GLOBAL : ORIGIN_CN;
    const r = await this.fetch(`${base}/v2/plugin/auth/state?platform=CLI`, {
      method: 'POST',
      headers: { Origin: origin, Referer: `${origin}/`, 'User-Agent': CLIENT_UA, 'Content-Type': 'application/json; charset=utf-8' },
      body: '{}',
      signal: AbortSignal.timeout(30_000),
    });
    const json = JSON.parse(await r.text());
    if (json.code === 0 && json.data) {
      return { ok: true, state: json.data.state || '', url: json.data.authUrl || '', realm };
    }
    return { ok: false, error: json.msg || '未知错误' };
  }

  async pollLogin(state) {
    for (const [base, origin, realm] of [[UPSTREAM_GLOBAL, UPSTREAM_GLOBAL, 'global'], [UPSTREAM_CN, ORIGIN_CN, 'cn']]) {
      try {
        const hdr = { Origin: origin, Referer: `${origin}/`, 'User-Agent': CLIENT_UA };
        const r = await this.fetch(`${base}/v2/plugin/auth/token?state=${encodeURIComponent(state)}`, { headers: hdr, signal: AbortSignal.timeout(30_000) });
        const json = JSON.parse(await r.text());
        if (json.code !== 0 || !json.data || !json.data.accessToken) continue;
        const tok = json.data;
        let uid = `user_${Date.now()}`;
        let nickname = 'WorkBuddy用户';
        try {
          const ar = await this.fetch(`${base}/v2/plugin/login/account?state=${encodeURIComponent(state)}`, {
            headers: { ...hdr, Authorization: `Bearer ${tok.accessToken}` }, signal: AbortSignal.timeout(30_000),
          });
          const aj = JSON.parse(await ar.text()).data;
          if (aj && aj.uid) { uid = String(aj.uid); nickname = aj.nickname || nickname; }
        } catch (e) { /* 拿不到账号信息就用占位 */ }
        this.vault.saveAccount(uid, nickname, realm, tok.accessToken, tok.refreshToken || '');
        return { ok: true, done: true, uid, nickname, realm };
      } catch (e) { /* 这个 realm 不行，试下一个 */ }
    }
    return { ok: true, done: false, message: 'waiting for login' };
  }

  /**
   * 流式调用。onLine(lineWithBlankLine) 返回 false 表示客户端已断开。
   * @param opts.signal 客户端断开时中止上游
   */
  async streamChat(payload, convId, onLine, opts = {}) {
    const { realm, clean } = resolveModel(payload.model);
    const base = realm === 'global' ? UPSTREAM_GLOBAL : UPSTREAM_CN;
    const up = buildUpstreamPayload(payload, clean, id => this.getReasoningByToolId(id));
    const ctx = { realm, base, body: JSON.stringify(up), convId: convId || hex32(), onLine, signal: opts.signal, emittedAny: false };

    try {
      return await this._rotate(ctx, new Set());
    } catch (e) {
      if (!(e && e._exhausted)) throw e;
      if (ctx.emittedAny) throw e.lastErr;
      let lastErr = e.lastErr;
      // 所有账号都被限流：清冷却后退避重试（有限轮次）
      for (let round = 1; round <= FINAL_BACKOFF_ROUNDS; round++) {
        if (!this.scheduler.pick(realm) && !this.vault.getActiveAccount(realm)) break;
        this.log.log(`[WB] 全部账号繁忙，退避第 ${round} 轮重试`);
        await sleep(this.backoffMs * round);
        if (opts.signal && opts.signal.aborted) break;
        this.scheduler.clearAllCooldowns();
        try {
          return await this._rotate(ctx, new Set());
        } catch (e2) {
          lastErr = e2 && e2._exhausted ? e2.lastErr : e2;
          if (ctx.emittedAny || !(e2 && e2._exhausted)) throw lastErr;
        }
      }
      if (lastErr) throw lastErr;
    }
  }

  /** 第 1、2 层：账号轮换 × 端点回退。全部失败时抛出带 _exhausted 的包装错误 */
  async _rotate(ctx, triedUids) {
    const endpoints = [`${ctx.base}/v2/chat/completions`, `${ctx.base}/console/chat/completions`];
    let lastErr = null;
    for (let attempt = 1; attempt <= MAX_ACCOUNT_ATTEMPTS; attempt++) {
      const acc = this.scheduler.pick(ctx.realm, triedUids) || this.vault.getActiveAccount(ctx.realm);
      if (!acc) throw new Error('未登录账号，请先在面板添加账号');
      const uid = acc.uid || 'user_default';
      triedUids.add(uid);
      let rateLimited = false;

      for (let i = 0; i < endpoints.length; i++) {
        const url = endpoints[i];
        const isLast = i === endpoints.length - 1;
        const r = await this._tryEndpoint(ctx, acc, uid, url, isLast, rateLimited);
        if (r.done) return;
        if (r.rateLimited) rateLimited = true;
        lastErr = r.err;
      }
      if (ctx.emittedAny) { if (lastErr) throw lastErr; return; }
      if (!rateLimited && !lastErr) break;
      if (attempt < MAX_ACCOUNT_ATTEMPTS && rateLimited) await sleep(this.backoffMs);
    }
    const wrap = new Error('all accounts exhausted');
    wrap._exhausted = true;
    wrap.lastErr = lastErr;
    throw wrap;
  }

  /** 单个账号 × 单个端点。返回 {done} 成功；{err, rateLimited} 交给上层决定；不可重试的错误直接抛出 */
  async _tryEndpoint(ctx, acc, uid, url, isLast, limitedBefore = false) {
    const ctl = new AbortController();
    const onClientAbort = () => ctl.abort(new Error('client closed'));
    if (ctx.signal) {
      if (ctx.signal.aborted) return { done: true };
      ctx.signal.addEventListener('abort', onClientAbort, { once: true });
    }
    const connectTimer = setTimeout(() => ctl.abort(new Error('upstream connect timeout')), CONNECT_MS + READ_IDLE_MS);
    try {
      let resp;
      try {
        resp = await this.fetch(url, {
          method: 'POST',
          headers: upstreamHeaders({ token: acc.accessToken, uid, realm: ctx.realm, base: ctx.base, convId: ctx.convId }),
          body: ctx.body,
          signal: ctl.signal,
        });
      } catch (e) {
        if (ctx.signal && ctx.signal.aborted) return { done: true };
        this.log.warn(`[WB] network error @ ${url}: ${e.message}`);
        if (ctx.emittedAny) throw e;
        return { err: e };
      } finally {
        clearTimeout(connectTimer);
      }

      if (!resp.ok) {
        const body = await resp.text().catch(() => '');
        const code = upstreamCode(body);
        const snippet = isWafBlocked(resp.status, body) ? 'Tencent Cloud WAF blocked request (pattern in prompt)' : body.slice(0, 300);
        const err = new UpstreamError(resp.status, code, url, snippet);
        this.log.warn('[WB]', err.message);
        if (isRateLimited(resp.status, code, body)) { this.scheduler.markCooling(uid); return { err, rateLimited: true }; }
        if (isAuthExpired(resp.status, body)) { await this.tokenKeeper.refreshIfPossible(uid); return { err }; }
        if (!isLast || limitedBefore) return { err }; // 首个端点的任何失败都换 /console 再试；本账号已限流则换号
        throw err;
      }

      if (!resp.body) {
        const e = new Error(`empty upstream body @ ${url}`);
        if (ctx.emittedAny) throw e;
        return { err: e };
      }

      let reasoning = '';
      const toolIds = [];
      try {
        for await (const line of readLines(resp, ctl)) {
          if (!line) continue;
          // 每一帧都查错误码：上游可能在 200 的流中途插入 {"code":14003}
          const code = upstreamCode(line);
          if (code !== null && code !== 0) {
            const err = new UpstreamError(resp.status, code, url, line.slice(0, 500));
            const limited = isRateLimited(resp.status, code, line);
            if (limited) this.scheduler.markCooling(uid);
            if (ctx.emittedAny) throw err;
            if (limited) return { err, rateLimited: true };
            if (!isLast || limitedBefore) return { err };
            throw err;
          }
          if (line.startsWith('data: ')) {
            const s = line.slice(6).trim();
            if (s.startsWith('{')) {
              try {
                const d = JSON.parse(s).choices?.[0]?.delta;
                if (d && d.reasoning_content) reasoning += d.reasoning_content;
                if (d && Array.isArray(d.tool_calls)) for (const tc of d.tool_calls) if (tc && tc.id) toolIds.push(tc.id);
              } catch (e) { /* 非 JSON 帧照样透传 */ }
            }
          }
          ctx.emittedAny = true;
          if (ctx.onLine(`${line}\n\n`) === false) { ctl.abort(new Error('client closed')); break; }
        }
      } catch (e) {
        if (ctx.signal && ctx.signal.aborted) return { done: true };
        if (e instanceof UpstreamError) throw e;
        this.log.warn(`[WB] stream error @ ${url}: ${e.message}`);
        if (ctx.emittedAny) throw e; // 中途断网也不能换端点重来
        return { err: e };
      }
      if (reasoning) for (const tid of toolIds) this.recordReasoning(`${uid}:${tid}`, reasoning);
      this.scheduler.touch(uid);
      return { done: true };
    } finally {
      if (ctx.signal) ctx.signal.removeEventListener('abort', onClientAbort);
    }
  }

  /** 非流式：内部仍走流式，聚合正文 / 思考 / tool_calls / usage */
  async chatSync(payload, convId, opts = {}) {
    const { realm } = resolveModel(payload.model);
    let text = '', reasoning = '', upstreamError = null, lastUsage = null;
    let promptTokens = 20, compTokens = 20;
    const tools = new Map();
    await this.streamChat(payload, convId, line => {
      const t = line.trim();
      if (!t.startsWith('data: ') || t === 'data: [DONE]') return true;
      try {
        const chunk = JSON.parse(t.slice(6));
        if (chunk.error !== undefined) upstreamError = typeof chunk.error === 'string' ? chunk.error : JSON.stringify(chunk.error);
        const delta = chunk.choices?.[0]?.delta || {};
        if (delta.content) text += delta.content;
        if (delta.reasoning_content) reasoning += delta.reasoning_content;
        if (Array.isArray(delta.tool_calls)) delta.tool_calls.forEach((tc, i) => {
          if (!tc) return;
          const idx = Number.isInteger(tc.index) ? tc.index : i;
          if (!tools.has(idx)) tools.set(idx, { id: tc.id || `call_${crypto.randomUUID().slice(0, 8)}`, type: 'function', function: { name: '', arguments: '' } });
          const slot = tools.get(idx);
          if (tc.function) {
            if (tc.function.name) slot.function.name += tc.function.name;
            if (tc.function.arguments) slot.function.arguments += tc.function.arguments;
          }
        });
        if (chunk.usage && typeof chunk.usage === 'object') {
          lastUsage = chunk.usage;
          if (Number.isFinite(chunk.usage.prompt_tokens)) promptTokens = chunk.usage.prompt_tokens;
          if (Number.isFinite(chunk.usage.completion_tokens)) compTokens = chunk.usage.completion_tokens;
        }
      } catch (e) { /* ignore */ }
      return true;
    }, opts);

    if (upstreamError !== null) throw new Error(`Upstream error: ${upstreamError}`);
    if (!text && !tools.size) throw new Error('Upstream returned empty completion');
    const toolCalls = [...tools.entries()].sort((a, b) => a[0] - b[0]).map(e => e[1]);
    if (reasoning) {
      const uid = (this.vault.getActiveAccount(realm) || {}).uid || 'user_default';
      for (const tc of toolCalls) if (tc.id) this.recordReasoning(`${uid}:${tc.id}`, reasoning);
    }
    const out = {
      content: text,
      reasoning_content: reasoning,
      prompt_tokens: promptTokens,
      completion_tokens: Math.max(compTokens, Math.floor((text.length + reasoning.length) / 2)),
    };
    if (toolCalls.length) out.tool_calls = toolCalls;
    if (lastUsage) out.usage = lastUsage;
    return out;
  }
}
