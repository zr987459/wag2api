/**
 * Account Health & Connectivity Test Runner
 */

import { buildAntigravityHeaders, buildCloudCodePayload } from './cloudcode.mjs';
import { ANTIGRAVITY_ENDPOINT_DAILY } from './constants.mjs';
import { upstreamFetch } from './upstream-fetch.mjs';
import { classifyFailure, extractValidationUrl } from './upstream-policy.mjs';

/**
 * 针对单个账号发起轻量连通性测试（强制使用该账号，绕过调度、冷却、封禁标记）
 */
export async function testAccount({
  email,
  model = 'gemini-3.8-flash',
  accountPool,
  cooldowns = null,
  fetchImpl = upstreamFetch,
  timeoutMs = 30000,
} = {}) {
  const cleanEmail = String(email || '').trim();
  const targetModel = String(model || 'gemini-3.8-flash').trim();

  if (!cleanEmail) {
    return {
      ok: false,
      email: '',
      model: targetModel,
      status: 400,
      latency_ms: 0,
      error: '缺少 email 参数',
    };
  }

  if (!accountPool) {
    return {
      ok: false,
      email: cleanEmail,
      model: targetModel,
      status: 500,
      latency_ms: 0,
      error: '账号池未初始化',
    };
  }

  const mgr = accountPool.getManager(cleanEmail);
  if (!mgr) {
    return {
      ok: false,
      email: cleanEmail,
      model: targetModel,
      status: 404,
      latency_ms: 0,
      error: `账号 ${cleanEmail} 不存在`,
    };
  }

  const startTime = Date.now();

  let tok;
  try {
    tok = await mgr.getValidAccessToken();
    if (!tok) {
      throw new Error('Google 凭据刷新失败 (未获取到 valid access_token)');
    }
    if (!mgr.tokenData?.projectId && typeof mgr.ensureProjectId === 'function') {
      await mgr.ensureProjectId().catch(() => '');
    }
  } catch (err) {
    const latency_ms = Date.now() - startTime;
    const errMsg = String(err?.message || err).slice(0, 300);
    const kind = classifyFailure({ error: err });
    const validation_url = extractValidationUrl(errMsg);
    if (kind === 'validation') {
      accountPool.markValidationBlocked(cleanEmail, errMsg, validation_url);
    }
    const out = {
      ok: false,
      email: cleanEmail,
      model: targetModel,
      status: 401,
      latency_ms,
      error: errMsg,
      kind,
    };
    if (validation_url) out.validation_url = validation_url;
    return out;
  }

  const anthropicReq = {
    model: targetModel,
    messages: [{ role: 'user', content: 'ping' }],
    max_tokens: 16,
    temperature: 0.1,
  };

  const payload = buildCloudCodePayload(anthropicReq, mgr.tokenData?.projectId || '');
  if (payload?.generationConfig) {
    payload.generationConfig.maxOutputTokens = 16;
    payload.generationConfig.thinkingConfig = { includeThoughts: false, thinkingBudget: 0 };
  }

  const ac = new AbortController();
  const timer = setTimeout(() => {
    const e = new Error(`上游请求超时 (${timeoutMs}ms)`);
    e.name = 'TimeoutError';
    ac.abort(e);
  }, timeoutMs);

  const targetUrl = `${ANTIGRAVITY_ENDPOINT_DAILY}/v1internal:generateContent`;

  try {
    const res = await fetchImpl(targetUrl, {
      method: 'POST',
      headers: buildAntigravityHeaders(tok),
      body: JSON.stringify(payload),
      signal: ac.signal,
    });
    clearTimeout(timer);

    const latency_ms = Date.now() - startTime;
    const status = res ? res.status : 0;
    const bodyText = res ? await res.text().catch(() => '') : '';

    if (res && res.ok) {
      accountPool.clearValidationBlocked(cleanEmail);
      accountPool.clearCooldown(cleanEmail);
      if (cooldowns && typeof cooldowns.clearAccount === 'function') {
        cooldowns.clearAccount(cleanEmail);
      }

      let reply = 'pong';
      try {
        const j = JSON.parse(bodyText);
        const cand = j?.response?.candidates?.[0] || j?.candidates?.[0];
        const parts = cand?.content?.parts || [];
        const part = parts.find(p => p.text && !p.thought) || parts.find(p => p.text) || parts[0];
        if (part && typeof part.text === 'string') {
          reply = part.text.trim();
        }
      } catch (_) {
        if (bodyText) reply = bodyText.trim();
      }

      return {
        ok: true,
        email: cleanEmail,
        model: targetModel,
        status,
        latency_ms,
        reply: reply.slice(0, 80),
      };
    } else {
      const kind = classifyFailure({ status, body: bodyText });
      const validation_url = extractValidationUrl(bodyText);
      const errorMsg = String(bodyText || `HTTP ${status}`).slice(0, 300);
      if (kind === 'validation') {
        accountPool.markValidationBlocked(cleanEmail, errorMsg, validation_url);
      }
      const out = {
        ok: false,
        email: cleanEmail,
        model: targetModel,
        status,
        latency_ms,
        error: errorMsg,
        kind,
      };
      if (validation_url) out.validation_url = validation_url;
      return out;
    }
  } catch (err) {
    clearTimeout(timer);
    const latency_ms = Date.now() - startTime;
    const errMsg = String(err?.message || err).slice(0, 300);
    const kind = classifyFailure({ error: err });
    const validation_url = extractValidationUrl(errMsg);
    if (kind === 'validation') {
      accountPool.markValidationBlocked(cleanEmail, errMsg, validation_url);
    }
    const out = {
      ok: false,
      email: cleanEmail,
      model: targetModel,
      status: 0,
      latency_ms,
      error: errMsg,
      kind,
    };
    if (validation_url) out.validation_url = validation_url;
    return out;
  }
}

/**
 * 并发测试号池内所有账号（默认并发 3）
 */
export async function testAllAccounts({
  model = 'gemini-3.8-flash',
  accountPool,
  cooldowns = null,
  fetchImpl = upstreamFetch,
  concurrency = 3,
  timeoutMs = 30000,
} = {}) {
  if (!accountPool) {
    return { results: [] };
  }

  const emails = Array.from(accountPool.managers.keys());
  if (emails.length === 0) {
    return { results: [] };
  }

  const results = new Array(emails.length);
  let nextIdx = 0;
  const workerCount = Math.min(concurrency, emails.length);

  const workers = Array.from({ length: workerCount }, async () => {
    while (nextIdx < emails.length) {
      const cur = nextIdx++;
      results[cur] = await testAccount({
        email: emails[cur],
        model,
        accountPool,
        cooldowns,
        fetchImpl,
        timeoutMs,
      });
    }
  });

  await Promise.all(workers);
  return { results };
}
