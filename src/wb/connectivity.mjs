/** 连通性测试（翻译自 ConnectivityTest.kt）：真实发一次最小流式请求，读到首个内容帧即判定通过 */
import crypto from 'crypto';
import { UPSTREAM_CN, UPSTREAM_GLOBAL, DEFAULT_SYSTEM_PROMPT, MODEL_ALIASES } from './constants.mjs';
import { upstreamHeaders } from './gateway.mjs';

const TIMEOUT_MS = 25_000;

export async function runConnectivityTest({ vault, scheduler, fetchImpl = (...a) => fetch(...a) }, uid, model) {
  const started = Date.now();
  const elapsed = () => Date.now() - started;
  const fail = (msg, u = '', status = 0, endpoint = null) => {
    const o = { ok: false, partial: false, uid: u, elapsed_ms: elapsed(), status, msg };
    if (endpoint) o.endpoint = endpoint;
    return o;
  };

  const acc = uid ? vault.find(uid) : (scheduler.pick('global') || vault.getActiveAccount('global'));
  if (!acc) return fail('未找到可用账号，请先添加账号');
  const accUid = acc.uid || 'unknown';
  if (!acc.accessToken) return fail('该账号没有 accessToken，请重新授权', accUid);

  const realm = acc.realm || 'global';
  const base = realm === 'cn' ? UPSTREAM_CN : UPSTREAM_GLOBAL;
  const cleanModel = MODEL_ALIASES[model] || model;
  const body = JSON.stringify({
    model: cleanModel, stream: true, max_tokens: 8,
    messages: [{ role: 'system', content: DEFAULT_SYSTEM_PROMPT }, { role: 'user', content: 'ping' }],
  });
  const convId = crypto.randomUUID().replace(/-/g, '');
  let lastError = '未知错误';
  let lastStatus = 0;

  for (const url of [`${base}/v2/chat/completions`, `${base}/console/chat/completions`]) {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
    try {
      const resp = await fetchImpl(url, {
        method: 'POST',
        headers: upstreamHeaders({ token: acc.accessToken, uid: accUid, realm, base, convId, accept: 'application/json' }),
        body,
        signal: ctl.signal,
      });
      lastStatus = resp.status;
      let text = '';
      if (resp.ok) {
        let hasContent = false;
        if (resp.body) {
          const reader = resp.body.getReader();
          const dec = new TextDecoder();
          let buf = '', lines = 0;
          outer: for (;;) {
            const { value, done } = await reader.read();
            if (done) break;
            buf += dec.decode(value, { stream: true });
            let i;
            while ((i = buf.indexOf('\n')) >= 0) {
              const line = buf.slice(0, i).replace(/\r$/, '');
              buf = buf.slice(i + 1);
              if (++lines > 30) break outer;
              if (line.startsWith('data:') && (line.includes('"choices"') || line.includes('"delta"') || line.includes('"content"'))) { hasContent = true; break outer; }
            }
          }
          try { await reader.cancel(); } catch (e) { /* ignore */ }
        }
        if (hasContent) {
          return { ok: true, uid: accUid, model: cleanModel, realm, endpoint: url, elapsed_ms: elapsed(), status: 200, msg: '连通正常' };
        }
        lastError = '上游响应 200 但未返回内容帧';
      } else {
        text = await resp.text().catch(() => '');
      }
      let code = 0;
      try { code = parseInt(JSON.parse(text).code, 10) || 0; } catch (e) { /* 非 JSON */ }
      const st = resp.status;
      if (!resp.ok) {
        lastError = st === 401 ? 'Token 已失效，请点「Token 保活」或重新授权'
          : st === 403 ? '上游拒绝 (403)，可能是账号受限或渠道校验'
          : (st === 429 || code === 14003) ? '模型繁忙 (429)，账号健康有效'
          : code === 11102 ? '模型服务不可用 (11102)'
          : code === 11128 ? '渠道校验异常 (11128)'
          : st >= 500 ? `上游服务波动 (${st})`
          : `HTTP ${st}: ${text.slice(0, 120)}`;
        if (st === 429 || code === 14003) {
          return { ok: false, partial: true, uid: accUid, model: cleanModel, realm, endpoint: url, elapsed_ms: elapsed(), status: st, msg: lastError };
        }
      }
    } catch (e) {
      lastError = `网络异常：${e.message}`;
    } finally {
      clearTimeout(timer);
    }
  }
  return fail(lastError, accUid, lastStatus);
}
