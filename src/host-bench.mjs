/**
 * PR3 前置：三个 Cloud Code 集群测速（daily / autopush / prod）
 *
 * 用当前账号、真实主模型 payload（buildCloudCodePayload，思考配置与正式请求完全一致），
 * 把同一个提示词按轮次交替发给每个集群（每轮 daily→autopush→prod 依次一次，减少时段偏差），
 * 记录：响应头时间、首个思考块、首个正文、总耗时、输出 token，并算出真实生成速度。
 *
 * 只做测量，不改变正式请求的路由。后台异步执行，前端轮询 GET /api/bench/hosts 取结果。
 */

import { buildAntigravityHeaders, buildCloudCodePayload } from './cloudcode.mjs';
import { ANTIGRAVITY_ENDPOINTS } from './constants.mjs';
import { normalizeGeminiUsage, mergeRawUsage } from './usage.mjs';
import { upstreamFetch } from './upstream-fetch.mjs';

const TOPICS = ['城市里的夜跑', '一座老火车站', '雨季的菜市场', '深夜的便利店', '山里的气象站', '旧书店的猫'];
const PER_REQUEST_TIMEOUT_MS = 120000;

export function hostLabel(host) {
  try {
    const h = new URL(host).hostname;
    if (h.startsWith('daily-')) return 'daily';
    if (h.startsWith('autopush-')) return 'autopush';
    return 'prod';
  } catch { return String(host); }
}

const median = (arr) => {
  const a = arr.filter(v => Number.isFinite(v)).sort((x, y) => x - y);
  if (!a.length) return null;
  const m = Math.floor(a.length / 2);
  return a.length % 2 ? a[m] : Math.round((a[m - 1] + a[m]) / 2);
};

/** 单次流式请求测量（fetchImpl 可注入，便于测试） */
export async function measureOnce({ host, payload, accessToken, fetchImpl = upstreamFetch, timeoutMs = PER_REQUEST_TIMEOUT_MS }) {
  const url = `${host}/v1internal:streamGenerateContent?alt=sse`;
  const t0 = Date.now();
  const out = { host: hostLabel(host), ok: false, status: null, t_headers: null, t_first_chunk: null, t_first_thought: null, t_first_text: null, total_ms: null, output_tokens: 0, thoughts_tokens: 0, text_tokens: 0, gen_tps: null, text_tps: null, error: null };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const r = await fetchImpl(url, { method: 'POST', headers: buildAntigravityHeaders(accessToken), body: JSON.stringify(payload), signal: controller.signal });
    out.t_headers = Date.now() - t0;
    out.status = r.status;
    if (!r.ok) {
      const txt = await r.text().catch(() => '');
      out.error = txt.replace(/\s+/g, ' ').slice(0, 160);
      out.total_ms = Date.now() - t0;
      return out;
    }
    let rawUsage = null;
    let buf = '';
    const decoder = new TextDecoder();
    const handleLine = (line) => {
      if (!line.startsWith('data:')) return;
      const s = line.slice(5).trim();
      if (!s || s === '[DONE]') return;
      let j; try { j = JSON.parse(s); } catch { return; }
      const resp = j.response || j;
      rawUsage = mergeRawUsage(rawUsage, resp.usageMetadata);
      const parts = resp.candidates?.[0]?.content?.parts || [];
      const now = Date.now() - t0;
      for (const p of parts) {
        if (out.t_first_chunk === null && (p.text || p.functionCall)) out.t_first_chunk = now;
        if (p.thought && out.t_first_thought === null) out.t_first_thought = now;
        if (!p.thought && typeof p.text === 'string' && p.text.length && out.t_first_text === null) out.t_first_text = now;
      }
    };
    const reader = r.body.getReader();
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        handleLine(buf.slice(0, i).replace(/\r$/, ''));
        buf = buf.slice(i + 1);
      }
    }
    if (buf) handleLine(buf);
    out.total_ms = Date.now() - t0;
    const u = normalizeGeminiUsage(rawUsage);
    out.output_tokens = u.output_tokens;
    out.thoughts_tokens = u.thoughts_tokens;
    out.text_tokens = u.output_tokens - u.thoughts_tokens;
    if (out.t_first_chunk !== null && out.total_ms > out.t_first_chunk && u.output_tokens) {
      out.gen_tps = Math.round(u.output_tokens / ((out.total_ms - out.t_first_chunk) / 1000));
    }
    if (out.t_first_text !== null && out.total_ms > out.t_first_text && out.text_tokens) {
      out.text_tps = Math.round(out.text_tokens / ((out.total_ms - out.t_first_text) / 1000));
    }
    out.ok = out.t_first_chunk !== null;
    if (!out.ok) out.error = '200 但没有收到内容';
  } catch (e) {
    out.total_ms = Date.now() - t0;
    out.error = e.name === 'AbortError' ? `超时 ${Math.round(timeoutMs / 1000)}s` : String(e.message || e).slice(0, 160);
  } finally {
    clearTimeout(timer);
  }
  return out;
}

export function summarize(runs) {
  const byHost = {};
  for (const r of runs) (byHost[r.host] ||= []).push(r);
  return Object.entries(byHost).map(([host, rs]) => {
    const ok = rs.filter(r => r.ok);
    return {
      host,
      ok: ok.length,
      total: rs.length,
      statuses: [...new Set(rs.map(r => r.status ?? 'ERR'))].join(','),
      t_first_chunk: median(ok.map(r => r.t_first_chunk)),
      t_first_text: median(ok.map(r => r.t_first_text)),
      total_ms: median(ok.map(r => r.total_ms)),
      gen_tps: median(ok.map(r => r.gen_tps)),
      text_tps: median(ok.map(r => r.text_tps)),
      error: ok.length ? null : (rs.find(r => r.error)?.error || null),
    };
  });
}

class HostBench {
  constructor() { this.state = { running: false, started_at: null, finished_at: null, account: null, model: null, rounds: 0, progress: '', runs: [], summary: [] }; }

  status() { return { ...this.state, runs: this.state.runs.slice(), summary: summarize(this.state.runs) }; }

  /** 启动后台测速；已有任务在跑时返回 false */
  start(mgr, { rounds = 2, model = 'gemini-3.8-flash-high', hosts = ANTIGRAVITY_ENDPOINTS, fetchImpl = upstreamFetch } = {}) {
    if (this.state.running) return false;
    rounds = Math.max(1, Math.min(3, Number(rounds) || 2));
    this.state = { running: true, started_at: Date.now(), finished_at: null, account: mgr?.tokenData?.email || null, model, rounds, progress: '准备中', runs: [], summary: [] };
    this._run(mgr, { rounds, model, hosts, fetchImpl }).catch(e => { this.state.progress = '出错：' + e.message; }).finally(() => {
      this.state.running = false;
      this.state.finished_at = Date.now();
    });
    return true;
  }

  async _run(mgr, { rounds, model, hosts, fetchImpl }) {
    const nonce = Math.random().toString(36).slice(2, 8);
    const total = rounds * hosts.length;
    let n = 0;
    for (let round = 0; round < rounds; round++) {
      const topic = TOPICS[(round + nonce.charCodeAt(0)) % TOPICS.length];
      for (const host of hosts) {
        n++;
        this.state.progress = `${n}/${total} · ${hostLabel(host)}`;
        const token = await mgr.getValidAccessToken();
        if (!token) { this.state.runs.push({ host: hostLabel(host), round: round + 1, ok: false, status: null, error: 'token 刷新失败' }); continue; }
        if (!mgr.tokenData.projectId && typeof mgr.ensureProjectId === 'function') await mgr.ensureProjectId().catch(() => '');
        const req = {
          model,
          max_tokens: 4096,
          stream: true,
          // 每次测速一个随机标记，保证三个集群都是冷请求、互不命中缓存
          messages: [{ role: 'user', content: `[bench ${nonce}-${round}-${hostLabel(host)}] 用中文写一篇约 800 字的短文，主题：${topic}。直接写正文，不要标题和列表。` }],
          _gwEmail: mgr.tokenData.email,
        };
        const payload = buildCloudCodePayload(req, mgr.tokenData.projectId);
        const r = await measureOnce({ host, payload, accessToken: token, fetchImpl });
        this.state.runs.push({ ...r, round: round + 1 });
      }
    }
    this.state.progress = '完成';
  }
}

export const hostBench = new HostBench();
