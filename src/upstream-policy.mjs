/**
 * PR1：上游失败处理策略（降级可见 + 少降级 + 重试收敛）
 *
 * 顺序（降级是最后手段）：
 *  1. 400 类：不换号、不降级，直接返回（上下文超长仍走 bumpSessionOnOverflow 换一代 sessionId 重试一次）。
 *  2. 429 / RESOURCE_EXHAUSTED：retryDelay ≤ 5s 时等待后原账号重试 1 次；否则给「账号 + 上游模型」记冷却
 *     （retryDelay，缺省 60s），同模型换下一个未冷却的账号。429 不换 host。
 *  3. 5xx / 网络错误 / 响应头超时：同模型换 host 重试 1 次，再换账号重试 1 次。
 *  4. 以上都失败才降级；降级链每个模型只试 1 次。ALLOW_DOWNGRADE=0 时直接返回真实错误。
 *  5. 缓存亲和：优先用当前活跃账号；只有它在冷却或本次失败时才换号，换到哪个由配额数据决定。
 *     换号只对本次请求生效，不改 activeEmail。降级不粘住：每个新请求都先试主模型。
 *
 * 本模块不做网络请求，send / buildPayload 等由调用方注入，方便单测。
 */
import crypto from 'crypto';
import { FALLBACK_THOUGHT_SIGNATURE } from './signature-cache.mjs';
import { resolveSessionId } from './session-router.mjs';
import { getModelFamily } from './quota-fetcher.mjs';

export const SAME_ACCOUNT_RETRY_MAX_MS = 5000;
export const DEFAULT_COOLDOWN_MS = 60000;
export const MAX_QUOTA_COOLDOWN_MS = 5 * 60 * 60 * 1000; // 5 小时上限

// ---------- 错误分类 ----------

/** 判断是否为人工验证封禁 */
export function isValidationRequired(body) {
  const text = typeof body === 'string' ? body : (body ? JSON.stringify(body) : '');
  if (!text) return false;
  return /Verify your account|further action is required|validation_url|appeal_url|VALIDATION_REQUIRED/i.test(text);
}

/**
 * 提取人工验证 URL（优先 details metadata validation_url/appeal_url，其次 links[0].url，最后正则匹配 https URL，把 \u0026 还原为 &）
 */
export function extractValidationUrl(body) {
  if (!body) return '';
  const unescapeUrl = u => {
    if (!u || typeof u !== 'string') return '';
    return u.replace(/\\u0026/g, '&').replace(/&amp;/g, '&');
  };

  let parsed = null;
  const rawText = typeof body === 'string' ? body : JSON.stringify(body);
  if (typeof body === 'object') {
    parsed = body;
  } else {
    try { parsed = JSON.parse(body); } catch (e) {}
  }

  if (parsed && typeof parsed === 'object') {
    const details = parsed?.error?.details || parsed?.details;
    if (Array.isArray(details)) {
      for (const d of details) {
        const u = d?.metadata?.validation_url || d?.metadata?.appeal_url || d?.validation_url || d?.appeal_url;
        if (u) return unescapeUrl(u);
      }
      for (const d of details) {
        if (Array.isArray(d?.links) && d.links[0]?.url) return unescapeUrl(d.links[0].url);
      }
    }
    if (Array.isArray(parsed?.links) && parsed.links[0]?.url) return unescapeUrl(parsed.links[0].url);
  }

  const text = rawText.replace(/\\u0026/g, '&');
  const m = text.match(/https:\/\/[^\s"'\\<>{}]*/);
  if (m) {
    return unescapeUrl(m[0]);
  }
  return '';
}

/** 返回 'bad_request' | 'quota' | 'auth' | 'validation' | 'server' | 'network' | 'timeout' */
export function classifyFailure({ status = 0, body = '', error = null } = {}) {
  if (error) {
    const name = String(error.name || '');
    const msg = String(error.message || error);
    if (name === 'AbortError' || name === 'TimeoutError' || /header timeout|aborted|timed? ?out/i.test(msg)) return 'timeout';
    return 'network';
  }
  const text = String(body || '');
  if (isValidationRequired(text)) return 'validation';
  if (status === 429 || /RESOURCE_EXHAUSTED/.test(text)) return 'quota';
  if (status === 401 || status === 403) return /RESOURCE_EXHAUSTED|quota/i.test(text) ? 'quota' : 'auth';
  if (status >= 500) return 'server';
  if (status === 408) return 'timeout';
  return 'bad_request';
}

/** 从 Google 错误体的 RetryInfo.retryDelay（"35s" / "3.5s"）或 Retry-After 头取等待毫秒数；取不到返回 null */
export function parseRetryDelayMs(body = '', headers = null) {
  const ra = headers && (typeof headers.get === 'function' ? headers.get('retry-after') : headers['retry-after']);
  if (ra !== null && ra !== undefined && ra !== '') {
    const s = Number(ra);
    if (Number.isFinite(s)) return Math.max(0, Math.round(s * 1000));
    const mHeader = String(ra).trim().match(/^([\d.]+)\s*s?$/i);
    if (mHeader) return Math.max(0, Math.round(parseFloat(mHeader[1]) * 1000));
    const t = Date.parse(ra);
    if (Number.isFinite(t)) return Math.max(0, t - Date.now());
  }

  const text = typeof body === 'string' ? body : (body ? JSON.stringify(body) : '');
  const m = text.match(/"retryDelay"\s*:\s*"([\d.]+)s?"/i) || text.match(/"retryDelay"\s*:\s*([\d.]+)/i);
  if (m) return Math.round(parseFloat(m[1]) * 1000);

  return null;
}

/**
 * 解析 429 冷却时长：
 * 1. 如果 body/headers 带 retry-after 或 retryDelay（如 "35s"），按它冷却；
 * 2. 若带 quota 重置时间且额度耗尽，冷却到重置时间（上限 5 小时）；
 * 3. 否则沿用现有默认冷却 (DEFAULT_COOLDOWN_MS)。
 */
export function calculateCooldownMs(body = '', headers = null, now = Date.now) {
  const currentNow = typeof now === 'function' ? now() : now;

  // 1. 显式 retry-after 或 retryDelay
  const delay = parseRetryDelayMs(body, headers);
  if (delay !== null) {
    return Math.max(1000, delay);
  }

  const text = typeof body === 'string' ? body : (body ? JSON.stringify(body) : '');

  // 2. 检查配额重置时间（当额度耗尽 / 429 时）
  const isQuotaExhausted = /RESOURCE_EXHAUSTED|QUOTA_EXHAUSTED|quota exceeded|quota limit hit|out of quota|quota.*exhausted/i.test(text);

  let resetMs = null;

  // 检查 metadata 或字段中的 quotaResetDelay
  const mResetDelay = text.match(/"quotaResetDelay"\s*:\s*"([\d.]+)\s*(s|sec|m|min|h|hours?)?"/i) || text.match(/"quotaResetDelay"\s*:\s*([\d.]+)/i);
  if (mResetDelay) {
    const val = parseFloat(mResetDelay[1]);
    const unit = (mResetDelay[2] || 's').toLowerCase();
    if (unit.startsWith('h')) resetMs = Math.round(val * 3600 * 1000);
    else if (unit.startsWith('m')) resetMs = Math.round(val * 60 * 1000);
    else resetMs = Math.round(val * 1000);
  }

  // 检查 resetTime / quotaResetTime / reset_time
  if (resetMs === null) {
    const mResetTime = text.match(/"(?:quotaResetTime|resetTime|reset_time)"\s*:\s*"([^"]+)"/i);
    if (mResetTime) {
      const parsed = Date.parse(mResetTime[1]);
      if (Number.isFinite(parsed) && parsed > currentNow) {
        resetMs = parsed - currentNow;
      }
    }
  }

  // 检查自然语言文本中的重置时间（如 "resets in 1h19m" 或 "quota will reset in 300 seconds"）
  if (resetMs === null) {
    const mTextSec = text.match(/quota will reset in (\d+)\s*sec/i);
    if (mTextSec) {
      resetMs = parseInt(mTextSec[1], 10) * 1000;
    } else {
      const mTextIn = text.match(/resets? in ([\d.]+)\s*(s|sec|seconds?|m|min|minutes?|h|hours?)\b/i);
      if (mTextIn) {
        const val = parseFloat(mTextIn[1]);
        const unit = mTextIn[2].toLowerCase();
        if (unit.startsWith('h')) resetMs = Math.round(val * 3600 * 1000);
        else if (unit.startsWith('m')) resetMs = Math.round(val * 60 * 1000);
        else resetMs = Math.round(val * 1000);
      }
    }
  }

  if (resetMs !== null && (isQuotaExhausted || resetMs > 0)) {
    // 冷却到重置时间（上限 5 小时）
    return Math.min(Math.max(1000, resetMs), MAX_QUOTA_COOLDOWN_MS);
  }

  // 3. 默认冷却
  return DEFAULT_COOLDOWN_MS;
}

// ---------- 冷却表（账号 + 上游模型） ----------

export class Cooldowns {
  constructor(now = () => Date.now()) { this.map = new Map(); this.now = now; }
  key(email, model) { return `${email}\u0000${model}`; }
  set(email, model, ms) {
    const until = this.now() + Math.max(1000, ms || DEFAULT_COOLDOWN_MS);
    const k = this.key(email, model);
    if ((this.map.get(k) || 0) < until) this.map.set(k, until);
  }
  isCooling(email, model) {
    const k = this.key(email, model);
    const until = this.map.get(k);
    if (!until) return false;
    if (until <= this.now()) { this.map.delete(k); return false; }
    return true;
  }
  remainingMs(email, model) { const u = this.map.get(this.key(email, model)) || 0; return Math.max(0, u - this.now()); }
  clearAccount(email) {
    const clean = (email || '').trim();
    for (const k of this.map.keys()) {
      if (k.startsWith(`${clean}\u0000`)) this.map.delete(k);
    }
  }
  clear() { this.map.clear(); }
  list() {
    const out = [];
    for (const [k, until] of this.map) {
      const [email, model] = k.split('\u0000');
      const ms = until - this.now();
      if (ms > 0) out.push({ email, model, remaining_ms: ms });
    }
    return out;
  }
}

// 降级提示行在 downgrade-notice.mjs（content-converter 也要用，单独成模块避免循环引用）
export { DOWNGRADE_NOTICE_PREFIX, DOWNGRADE_REASON_LABELS, buildDowngradeNotice, stripDowngradeNotice, shouldInsertNotice } from './downgrade-notice.mjs';

// ---------- payload 改写（不重建） ----------

/** 换号重试：复用已转换的 payload，只替换 sessionId / project / requestId。结果与对该账号全新构建一致（requestId 除外）。 */
export function swapAccountInPayload(payload, anthropicReq, email, projectId) {
  anthropicReq._gwEmail = email;
  payload.requestId = 'agent-' + crypto.randomUUID();
  payload.request.sessionId = resolveSessionId(anthropicReq, email || '');
  if (projectId && projectId !== 'pending_detection') payload.project = projectId;
  else delete payload.project;
  return payload;
}

/** 降级 payload：历史里的 thoughtSignature 属于主模型，换成通用签名，避免降级模型校验失败。只用于降级请求。 */
export function stripSignaturesForDowngrade(payload) {
  for (const c of payload?.request?.contents || []) {
    for (const p of c.parts || []) {
      if (p && p.thoughtSignature) p.thoughtSignature = FALLBACK_THOUGHT_SIGNATURE;
    }
  }
  return payload;
}

// ---------- 主流程 ----------

/**
 * ctx:
 *  model                请求的客户端模型名
 *  upstreamOf(model)    客户端模型名 → 上游模型名（冷却按上游模型记）
 *  accounts()           账号池顺序的 manager 数组（manager.tokenData.email / projectId）
 *  activeEmail          当前活跃账号
 *  quotaOf(email)       该账号 Gemini 剩余配额比例（0~1），未知返回 null
 *  cooldowns            Cooldowns 实例
 *  buildPayload(model, mgr)            构建完整 payload
 *  prepare(mgr)                        可选：取 token / projectId，返回 false 表示该账号不可用
 *  send(payload, mgr, host, timeoutMs) 返回 Response；网络错误/超时抛异常
 *  onBadRequest(body, mgr)             可选：返回 true 表示已换一代 sessionId，重建后重试一次
 *  hosts                [主 host, 备用 host]
 *  chain                降级模型（客户端模型名）
 *  allowDowngrade       默认 true
 *  headerTimeoutMs      首次尝试的响应头超时
 *  deadlineMs           之后的重试不再超过的总截止（从 startedAt 起）
 *  minAttemptTimeoutMs  截止前剩余时间过短时，重试至少给这么久
 *  now / sleep / log
 *
 * 返回 { ok, response, mgr, modelUsed, downgraded, reason, switchedAccount, attempts, error: {kind, status, body} }
 */
export async function runWithPolicy(ctx) {
  const now = ctx.now || (() => Date.now());
  const sleep = ctx.sleep || (ms => new Promise(r => setTimeout(r, ms)));
  const log = ctx.log || (() => {});
  const startedAt = ctx.startedAt ?? now();
  const hosts = ctx.hosts;
  const deadlineMs = ctx.deadlineMs ?? 45000;
  const headerTimeoutMs = ctx.headerTimeoutMs ?? 60000;
  const minAttemptMs = ctx.minAttemptTimeoutMs ?? 5000;
  const allowDowngrade = ctx.allowDowngrade !== false;
  const upMain = ctx.upstreamOf(ctx.model);

  let attempts = 0;
  let lastError = null;
  let switchedAccount = false;
  const kinds = new Set();

  const timeoutFor = () => headerTimeoutMs;
  const pastDeadline = () => attempts > 0 && now() - startedAt >= deadlineMs;

  const order = (upModel, exclude) => {
    const all = ctx.accounts().filter(m => {
      const email = m?.tokenData?.email;
      if (!email) return false;
      if (exclude.has(email)) return false;
      if (ctx.isBlocked && ctx.isBlocked(email)) return false;
      return true;
    });
    const free = all.filter(m => !ctx.cooldowns.isCooling(m.tokenData.email, upModel));
    const active = free.find(m => m.tokenData.email === ctx.activeEmail);

    const family = getModelFamily(ctx.model);
    const getQuota = (m) => {
      const v = ctx.quotaOf ? ctx.quotaOf(m.tokenData.email, family) : null;
      return typeof v === 'number' ? v : null;
    };

    const isProtected = (m) => {
      const q = getQuota(m);
      return q !== null && q <= 0.02;
    };

    const isLow = (m) => {
      const q = getQuota(m);
      return q !== null && q < 0.05;
    };

    const qScore = (m) => {
      const q = getQuota(m);
      return q !== null ? q : 0.5; // 未知 (null) 当作中性 0.5
    };

    // 配额保护：已知额度 <= 2% 的号直接跳过；若所有号都被保护，则仍选额度最高的那个
    const nonProtected = free.filter(m => !isProtected(m));
    const candidateFree = nonProtected.length > 0 ? nonProtected : free;

    const hasNonLow = candidateFree.some(m => !isLow(m));

    const sortFn = (a, b) => {
      if (hasNonLow) {
        const lowA = isLow(a.m) ? 1 : 0;
        const lowB = isLow(b.m) ? 1 : 0;
        if (lowA !== lowB) return lowA - lowB;
      }
      return qScore(b.m) - qScore(a.m) || a.i - b.i;
    };

    // 如果 active 号本身额度 <5% 且号池中有其他可用正常号，则 active 号不可优先占用首位，一并参与重排
    if (active && candidateFree.includes(active) && (!hasNonLow || !isLow(active))) {
      const rest = candidateFree.filter(m => m !== active).map((m, i) => ({ m, i })).sort(sortFn).map(x => x.m);
      return [active, ...rest];
    }

    return candidateFree.map((m, i) => ({ m, i })).sort(sortFn).map(x => x.m);
  };

  const attempt = async (payload, mgr, host) => {
    const timeoutMs = timeoutFor();
    attempts++;
    const attemptStart = now();
    try {
      const r = await ctx.send(payload, mgr, host, timeoutMs);
      const latencyMs = now() - attemptStart;
      try { ctx.recordPerf?.(mgr.tokenData.email, Boolean(r && r.ok), latencyMs); } catch (e) {}
      if (r && r.ok) return { ok: true, response: r };
      const body = r ? await r.text().catch(() => '') : '';
      const status = r ? r.status : 0;
      return { ok: false, status, body, headers: r?.headers || null, kind: classifyFailure({ status, body }) };
    } catch (error) {
      const latencyMs = now() - attemptStart;
      try { ctx.recordPerf?.(mgr.tokenData.email, false, latencyMs); } catch (e) {}
      return { ok: false, status: 0, body: String(error?.message || error), kind: classifyFailure({ error }) };
    }
  };

  const success = (response, mgr, modelUsed, reason) => ({
    ok: true, response, mgr, modelUsed, downgraded: modelUsed !== ctx.model, reason: modelUsed !== ctx.model ? reason : null,
    switchedAccount, attempts, error: null,
  });

  // ---------- 主模型 ----------
  const tried = new Set();
  const authFailed = new Set(); // 凭据失效的账号：降级也不用它
  let mgr = order(upMain, tried)[0] || null;
  const allCoolingAtStart = !mgr;
  let payload = null;
  let sameAccountRetried = false;
  let hostSwitched = false;
  let serverAccountSwitched = false;
  let badRequestRetried = false;
  let host = hosts[0];

  const nextAccount = () => {
    tried.add(mgr.tokenData.email);
    const n = order(upMain, tried)[0] || null;
    if (n) switchedAccount = true;
    mgr = n;
    sameAccountRetried = false;
    host = hosts[0];
  };

  while (mgr && !pastDeadline()) {
    if (ctx.prepare && (await ctx.prepare(mgr)) === false) {
      lastError = { kind: 'auth', status: 401, body: `账号 ${mgr.tokenData.email} 凭据失效` };
      kinds.add('auth');
      authFailed.add(mgr.tokenData.email);
      nextAccount();
      continue;
    }
    payload = payload ? swapAccountInPayload(payload, ctx.anthropicReq || {}, mgr.tokenData.email, mgr.tokenData.projectId) : ctx.buildPayload(ctx.model, mgr);
    const r = await attempt(payload, mgr, host);
    if (r.ok) return success(r.response, mgr, ctx.model, null);
    lastError = { kind: r.kind, status: r.status, body: r.body };
    kinds.add(r.kind);

    if (r.kind === 'bad_request') {
      if (!badRequestRetried && ctx.onBadRequest && ctx.onBadRequest(r.body, mgr)) {
        badRequestRetried = true;
        payload = ctx.buildPayload(ctx.model, mgr);
        continue;
      }
      return { ok: false, mgr, modelUsed: ctx.model, downgraded: false, reason: null, switchedAccount, attempts, error: lastError };
    }
    if (r.kind === 'quota') {
      const explicitDelay = parseRetryDelayMs(r.body, r.headers);
      if (explicitDelay !== null && explicitDelay <= SAME_ACCOUNT_RETRY_MAX_MS && !sameAccountRetried) {
        sameAccountRetried = true;
        log(`[Policy] ${mgr.tokenData.email} 429，${explicitDelay}ms 后原账号重试`);
        await sleep(explicitDelay);
        continue;
      }
      const delay = calculateCooldownMs(r.body, r.headers, now);
      ctx.cooldowns.set(mgr.tokenData.email, upMain, delay);
      try { ctx.onCooldown?.(mgr.tokenData.email, delay, upMain); } catch (e) {}
      log(`[Policy] ${mgr.tokenData.email} × ${upMain} 冷却 ${Math.round(delay / 1000)}s，换号`);
      nextAccount();
      continue;
    }
    if (r.kind === 'validation') {
      authFailed.add(mgr.tokenData.email);
      try { ctx.onValidationRequired?.(mgr, r.body); } catch (e) {}
      log(`[Policy] ${mgr.tokenData.email} 触发人工验证封禁，换号`);
      nextAccount();
      continue;
    }
    if (r.kind === 'auth') { authFailed.add(mgr.tokenData.email); nextAccount(); continue; }
    // server / network / timeout：换 host 一次，再换账号一次
    if (!hostSwitched && hosts.length > 1) {
      hostSwitched = true;
      host = hosts[1];
      log(`[Policy] ${r.kind}(${r.status})，换 host 重试`);
      continue;
    }
    if (!serverAccountSwitched) {
      serverAccountSwitched = true;
      log(`[Policy] ${r.kind}(${r.status})，换账号重试`);
      nextAccount();
      continue;
    }
    break;
  }

  // ---------- 降级 ----------
  const reason = (allCoolingAtStart || (kinds.has('quota') && !order(upMain, new Set()).length)) ? 'quota_all_accounts'
    : kinds.has('timeout') ? 'timeout'
      : kinds.has('server') ? 'upstream_5xx'
        : kinds.has('network') ? 'network'
          : kinds.has('quota') ? 'quota'
            : kinds.has('validation') ? 'validation'
              : kinds.has('auth') ? 'auth' : 'unknown';
  if (allCoolingAtStart && !lastError) lastError = { kind: 'quota', status: 429, body: '所有账号对该模型都在冷却中' };

  // 只是凭据或验证问题时换模型没用，不降级
  const onlyAuthOrValidation = kinds.size > 0 && [...kinds].every(k => k === 'auth' || k === 'validation');
  if (allowDowngrade && !onlyAuthOrValidation && !pastDeadline()) {
    for (const dm of ctx.chain || []) {
      if (pastDeadline()) break;
      const up = ctx.upstreamOf(dm);
      const m = order(up, authFailed)[0] || null;
      if (!m) continue;
      if (ctx.prepare && (await ctx.prepare(m)) === false) continue;
      const p = stripSignaturesForDowngrade(ctx.buildPayload(dm, m));
      const r = await attempt(p, m, hosts[0]);
      if (r.ok) {
        if (m.tokenData.email !== ctx.activeEmail) switchedAccount = true;
        return success(r.response, m, dm, reason);
      }
      if (r.kind === 'quota') {
        const delay = calculateCooldownMs(r.body, r.headers, now);
        ctx.cooldowns.set(m.tokenData.email, up, delay);
        try { ctx.onCooldown?.(m.tokenData.email, delay, up); } catch (e) {}
      }
      log(`[Policy] 降级模型 ${dm} 失败：${r.kind}(${r.status})`);
    }
  }

  return { ok: false, mgr, modelUsed: ctx.model, downgraded: false, reason, switchedAccount, attempts, error: lastError || { kind: 'unknown', status: 502, body: 'Google 集群无响应' } };
}
