/**
 * PR3 前置：三个 Cloud Code 集群测速（daily / autopush / prod）
 *
 * 用当前账号、真实主模型 payload（buildCloudCodePayload，思考配置与正式请求完全一致），
 * 把同一个提示词按轮次交替发给每个集群（每轮 daily→autopush→prod 依次一次，减少时段偏差），
 * 记录：响应头时间、首个思考块、首个正文、总耗时、输出 token，并算出真实生成速度。
 *
 * 只做测量，不改变正式请求的路由。后台异步执行，前端轮询 GET /api/bench/hosts 取结果。
 */

import { buildAntigravityHeaders, buildCloudCodePayload, SAFETY_BLOCK_NONE } from './cloudcode.mjs';
import { ANTIGRAVITY_ENDPOINTS } from './constants.mjs';
import { normalizeGeminiUsage, mergeRawUsage } from './usage.mjs';
import { upstreamFetch } from './upstream-fetch.mjs';
import { takePayload, replayInfo } from './replay-store.mjs';
import crypto from 'crypto';

export const REPLAY_MAX_OUTPUT_TOKENS = 256;


const TOPICS = ['城市里的夜跑', '一座老火车站', '雨季的菜市场', '深夜的便利店', '山里的气象站', '旧书店的猫'];
const PER_REQUEST_TIMEOUT_MS = 120000;

export function hostLabel(host) {
  try {
    const h = new URL(host).hostname;
    if (h.startsWith('daily-cloudcode-pa.')) return 'daily';
    if (h.startsWith('autopush-cloudcode-pa.')) return 'autopush';
    if (h === 'cloudcode-pa.googleapis.com') return 'prod';
    return h; // 自定义完整 URL：直接显示主机名，不再一律标成 prod
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
  const out = { host: hostLabel(host), ok: false, status: null, t_headers: null, t_upload: null, t_first_chunk: null, t_first_thought: null, t_first_text: null, total_ms: null, output_tokens: 0, thoughts_tokens: 0, text_tokens: 0, input_tokens: 0, cached_tokens: 0, cache_hit_rate: null, gen_tps: null, text_tps: null, error: null };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const r = await fetchImpl(url, { method: 'POST', headers: buildAntigravityHeaders(accessToken), body: JSON.stringify(payload), signal: controller.signal });
    out.t_headers = Date.now() - t0;
    out.t_upload = r._gwUploadMs ?? null;
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
    out.input_tokens = u.input_tokens;
    out.cached_tokens = u.cached_tokens;
    out.cache_hit_rate = u.input_tokens + u.cached_tokens > 0 ? Math.round((u.cached_tokens / (u.input_tokens + u.cached_tokens)) * 1000) / 1000 : null;
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

/**
 * 回放变体：从最近一次正式请求派生测速 payload。
 *  - 只改 requestId（顶层，本来就随机）、maxOutputTokens（≤256）、以及显式选择的 level / safety 变体；
 *  - sessionId、contents、systemInstruction、tools 原样保留，才能测到真实的缓存命中。
 *  - level / safety 为 null 表示「原样」。
 */
export function buildReplayPayload(base, { level = null, safety = null } = {}) {
  const p = JSON.parse(JSON.stringify(base));
  p.requestId = 'agent-' + crypto.randomUUID();
  const req = p.request || (p.request = {});
  const gc = req.generationConfig || (req.generationConfig = {});
  gc.maxOutputTokens = Math.min(REPLAY_MAX_OUTPUT_TOKENS, Number(gc.maxOutputTokens) || REPLAY_MAX_OUTPUT_TOKENS);
  if (level) {
    const tc = gc.thinkingConfig || {};
    const next = { ...tc, thinkingLevel: level };
    delete next.thinkingBudget;
    if (level === 'low' && /flash/.test(String(p.model || ''))) next.thinkingBudget = 0; // 与正式请求 low 档一致
    if (next.includeThoughts === undefined) next.includeThoughts = true;
    // 保持 canonical 键序
    gc.thinkingConfig = Object.fromEntries(Object.keys(next).sort().map(k => [k, next[k]]));
  }
  if (safety === 'on') req.safetySettings = SAFETY_BLOCK_NONE.map(x => ({ ...x }));
  else if (safety === 'off') delete req.safetySettings;
  p.request = Object.fromEntries(Object.keys(req).sort().map(k => [k, req[k]]));
  return p;
}

const parseList = (v, allowed) => {
  const arr = (Array.isArray(v) ? v : String(v ?? '').split(',')).map(x => String(x).trim().toLowerCase()).filter(x => allowed.includes(x));
  return arr.length ? [...new Set(arr)] : [null];
};
export const parseLevels = v => parseList(v, ['low', 'medium', 'high']);
export const parseSafety = v => parseList(v, ['on', 'off']);

/** 回放汇总：host × level × safety 每个组合的中位数 */
export function summarizeReplay(runs) {
  const by = {};
  for (const r of runs) (by[`${r.host}|${r.level || '原样'}|${r.safety || '原样'}`] ||= []).push(r);
  return Object.entries(by).map(([k, rs]) => {
    const [host, level, safety] = k.split('|');
    const ok = rs.filter(r => r.ok);
    return {
      host, level, safety, ok: ok.length, total: rs.length,
      statuses: [...new Set(rs.map(r => r.status ?? 'ERR'))].join(','),
      t_headers: median(ok.map(r => r.t_headers)),
      t_upload: median(ok.map(r => r.t_upload)),
      t_first_thought: median(ok.map(r => r.t_first_thought)),
      t_first_text: median(ok.map(r => r.t_first_text)),
      cache_hit_rate: (() => { const v = ok.map(r => r.cache_hit_rate).filter(x => Number.isFinite(x)).sort((a, b) => a - b); return v.length ? v[Math.floor(v.length / 2)] : null; })(),
      error: ok.length ? null : (rs.find(r => r.error)?.error || null),
    };
  });
}

class HostBench {
  constructor() { this.state = { mode: 'short', running: false, started_at: null, finished_at: null, account: null, model: null, rounds: 0, progress: '', runs: [], summary: [] }; }

  status() {
    const replay = this.state.mode === 'replay';
    return { ...this.state, runs: this.state.runs.slice(), summary: replay ? summarizeReplay(this.state.runs) : summarize(this.state.runs), replay_info: replayInfo() };
  }

  /**
   * fix/ttft：长上下文回放测速。用最近一次正式请求的 payload（同账号、同 sessionId），
   * 每轮按 hosts 顺序（daily→autopush→prod）交替发，每个 level×safety 组合各 rounds 轮。
   * getManager(email) 返回该账号的 TokenManager；账号已不在池里时拒绝（不换号，换号就测不到缓存）。
   */
  startReplay(getManager, { rounds = 2, levels = null, safety = null, hosts = ANTIGRAVITY_ENDPOINTS, fetchImpl = upstreamFetch } = {}) {
    if (this.state.running) return { ok: false, error: '已有测速在进行' };
    const base = takePayload();
    if (!base) return { ok: false, error: '还没有正式 AG 请求可回放，先用客户端发一轮对话' };
    const mgr = getManager(base.email);
    if (!mgr) return { ok: false, error: `原账号 ${base.email} 不在账号池里` };
    rounds = Math.max(1, Math.min(3, Number(rounds) || 2));
    const lv = parseLevels(levels), sf = parseSafety(safety);
    this.state = { mode: 'replay', running: true, started_at: Date.now(), finished_at: null, account: base.email, model: base.payload.model, rounds,
      variants: { levels: lv, safety: sf }, planned: rounds * lv.length * sf.length * hosts.length, progress: '准备中', runs: [], summary: [] };
    this._runReplay(mgr, base.payload, { rounds, lv, sf, hosts, fetchImpl }).catch(e => { this.state.progress = '出错：' + e.message; }).finally(() => {
      this.state.running = false;
      this.state.finished_at = Date.now();
    });
    return { ok: true };
  }

  async _runReplay(mgr, base, { rounds, lv, sf, hosts, fetchImpl }) {
    let n = 0;
    const total = rounds * lv.length * sf.length * hosts.length;
    for (let round = 0; round < rounds; round++) {
      for (const level of lv) {
        for (const safety of sf) {
          for (const host of hosts) {
            n++;
            this.state.progress = `${n}/${total} · ${hostLabel(host)}${level ? ' · ' + level : ''}${safety ? ' · safety ' + safety : ''}`;
            const token = await mgr.getValidAccessToken();
            if (!token) { this.state.runs.push({ host: hostLabel(host), round: round + 1, level, safety, ok: false, status: null, error: 'token 刷新失败' }); continue; }
            const payload = buildReplayPayload(base, { level, safety });
            const r = await measureOnce({ host, payload, accessToken: token, fetchImpl });
            this.state.runs.push({ ...r, round: round + 1, level, safety });
          }
        }
      }
    }
    this.state.progress = '完成';
  }

  /** 启动后台测速；已有任务在跑时返回 false */
  start(mgr, { rounds = 2, model = 'gemini-3.8-flash-high', hosts = ANTIGRAVITY_ENDPOINTS, fetchImpl = upstreamFetch } = {}) {
    if (this.state.running) return false;
    rounds = Math.max(1, Math.min(3, Number(rounds) || 2));
    this.state = { mode: 'short', running: true, started_at: Date.now(), finished_at: null, account: mgr?.tokenData?.email || null, model, rounds, progress: '准备中', runs: [], summary: [] };
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
