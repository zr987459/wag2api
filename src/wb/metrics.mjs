/**
 * WB 统计（翻译自 GatewayMetrics.kt，口径与 AG stats.mjs 一致）：
 *   input = prompt - cached；cached；output（含思考）；thoughts 明细；total = input + cached + output
 * 小时桶以 UTC 整点毫秒为 key 保留 48 小时；「今日」按本机本地日期滚动；日志只在内存保留 150 条。
 */
import path from 'path';
import crypto from 'crypto';
import { atomicWrite, readJson } from './store.mjs';

const MAX_LOGS = 150;
const HOUR_MS = 3_600_000;
const KEEP_HOURS = 48;
const pad = v => String(v).padStart(2, '0');
const localDate = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const localTime = d => `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
const n = v => (Number.isFinite(Number(v)) ? Number(v) : 0);

/** OpenAI 风格 usage → {input,cached,output,thoughts}；prompt 含 cached，这里拆开 */
export function usageFromOpenAi(u) {
  if (!u || typeof u !== 'object') return null;
  const prompt = Number.isFinite(u.prompt_tokens) ? u.prompt_tokens : -1;
  const comp = Number.isFinite(u.completion_tokens) ? u.completion_tokens : -1;
  if (prompt < 0 && comp < 0) return null;
  const detailCached = n(u.prompt_tokens_details && u.prompt_tokens_details.cached_tokens);
  const cached = detailCached > 0 ? detailCached : n(u.prompt_cache_hit_tokens);
  const thoughts = n(u.completion_tokens_details && u.completion_tokens_details.reasoning_tokens);
  const p = Math.max(0, prompt);
  const c = Math.min(Math.max(0, cached), p);
  return { input: p - c, cached: c, output: Math.max(0, comp), thoughts: Math.max(0, thoughts) };
}

export const usageTotal = u => u.input + u.cached + u.output;

class Bucket {
  constructor(j) {
    const o = j || {};
    for (const k of ['requests', 'success', 'errors', 'input', 'cached', 'output', 'thoughts', 'latSum', 'latCount', 'ttftSum', 'ttftCount']) this[k] = n(o[k]);
  }
  add(ok, u, lat, ttft) {
    this.requests++;
    ok ? this.success++ : this.errors++;
    this.input += u.input; this.cached += u.cached; this.output += u.output; this.thoughts += u.thoughts;
    if (ok && lat > 0) { this.latSum += lat; this.latCount++; }
    if (ok && ttft !== null && ttft !== undefined && ttft >= 0) { this.ttftSum += ttft; this.ttftCount++; }
  }
  toJson() { return { ...this }; }
  summary() {
    const den = this.input + this.cached;
    return {
      total_requests: this.requests, success_requests: this.success, error_requests: this.errors,
      input_tokens: this.input, cached_tokens: this.cached, output_tokens: this.output, thoughts_tokens: this.thoughts,
      total_tokens: this.input + this.cached + this.output, prompt_tokens: den,
      cache_hit_rate: den > 0 ? this.cached / den : null,
      avg_latency_ms: this.latCount > 0 ? Math.floor(this.latSum / this.latCount) : 0,
      avg_ttft_ms: this.ttftCount > 0 ? Math.floor(this.ttftSum / this.ttftCount) : null,
    };
  }
}

export class GatewayMetrics {
  constructor(dir, { now = () => Date.now() } = {}) {
    this.file = dir ? path.join(dir, 'metrics.json') : null;
    this.now = now;
    this.logs = [];
    this.timer = null;
    const saved = this.file ? readJson(this.file, {}) : {};
    const today = localDate(new Date(this.now()));
    this.lastDate = saved.last_date || today;
    this.today = saved.last_date === today ? new Bucket(saved.today) : new Bucket();
    this.lastDate = today;
    this.total = new Bucket(saved.total);
    this.hourly = new Map(Object.entries(saved.hourly || {}).map(([k, v]) => [Number(k), { r: n(v.r), e: n(v.e), i: n(v.i), c: n(v.c), o: n(v.o) }]));
  }

  checkDateRollover() {
    const td = localDate(new Date(this.now()));
    if (td !== this.lastDate) { this.today = new Bucket(); this.lastDate = td; this.schedule(); }
  }

  getTodayRequests() { this.checkDateRollover(); return this.today.requests; }
  getTodayTokens() { this.checkDateRollover(); return this.today.input + this.today.cached + this.today.output; }

  /**
   * @param usage {input,cached,output,thoughts} | number（旧调用：只有总数时按输出计）| null
   * @param account {uid,nickname} 最终实际处理这次请求的账号（没选到账号时为空）
   */
  record(method, pth, model, endpoint, status, usage, latencyMs, ttftMs = null, note = null, account = null) {
    this.checkDateRollover();
    const u = typeof usage === 'number' ? { input: 0, cached: 0, output: Math.max(0, usage), thoughts: 0 }
      : (usage || { input: 0, cached: 0, output: 0, thoughts: 0 });
    const ok = status >= 200 && status <= 299;
    this.today.add(ok, u, latencyMs, ttftMs);
    this.total.add(ok, u, latencyMs, ttftMs);

    const nowMs = this.now();
    const hk = nowMs - (nowMs % HOUR_MS);
    const s = this.hourly.get(hk) || { r: 0, e: 0, i: 0, c: 0, o: 0 };
    s.r++; if (!ok) s.e++;
    s.i += u.input; s.c += u.cached; s.o += u.output;
    this.hourly.set(hk, s);
    for (const k of [...this.hourly.keys()]) if (k < hk - KEEP_HOURS * HOUR_MS) this.hourly.delete(k);

    const den = u.input + u.cached;
    const item = {
      id: `log_${nowMs}_${crypto.randomUUID().slice(0, 6)}`,
      time: localTime(new Date(nowMs)),
      timestamp: nowMs,
      method, path: pth, model,
      uid: (account && account.uid) || '',
      nickname: (account && account.nickname) || '',
      endpoint,
      is_stream: endpoint === 'stream',
      status,
      tokens: usageTotal(u),
      usage: { input: u.input, cached: u.cached, output: u.output, thoughts: u.thoughts, total: usageTotal(u) },
      cache_hit_rate: den > 0 ? u.cached / den : null,
      latency_ms: latencyMs,
    };
    if (ttftMs !== null && ttftMs !== undefined) item.ttft_ms = ttftMs;
    if (note && String(note).trim()) item.note = String(note);
    this.logs.unshift(item);
    if (this.logs.length > MAX_LOGS) this.logs.length = MAX_LOGS;
    this.schedule();
  }

  statsJson() {
    this.checkDateRollover();
    const nowMs = this.now();
    const cur = nowMs - (nowMs % HOUR_MS);
    const points = [];
    const l = { r: 0, e: 0, i: 0, c: 0, o: 0 };
    for (let i = 23; i >= 0; i--) {
      const k = cur - i * HOUR_MS;
      const s = this.hourly.get(k) || { r: 0, e: 0, i: 0, c: 0, o: 0 };
      l.r += s.r; l.e += s.e; l.i += s.i; l.c += s.c; l.o += s.o;
      points.push({ ts: k, requests: s.r, errors: s.e, input: s.i, cached: s.c, output: s.o, tokens: s.i + s.c + s.o });
    }
    const den = l.i + l.c;
    return {
      ...this.total.summary(),
      ok: true,
      engine: 'wb',
      today: this.today.summary(),
      last_24h: { requests: l.r, errors: l.e, input: l.i, cached: l.c, output: l.o, tokens: l.i + l.c + l.o, cache_hit_rate: den > 0 ? l.c / den : null },
      trend: { mode: '24h', points },
    };
  }

  resetStats() {
    this.today = new Bucket(); this.total = new Bucket(); this.hourly.clear(); this.logs = [];
    this.flush();
  }

  getLogsJson() { return this.logs; }
  clearLogs() { this.logs = []; }

  schedule() {
    if (!this.file || this.timer) return;
    this.timer = setTimeout(() => { this.timer = null; this.flush(); }, 2000);
    if (this.timer.unref) this.timer.unref();
  }

  flush() {
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    if (!this.file) return;
    const hourly = {};
    for (const [k, v] of this.hourly) hourly[k] = v;
    try {
      atomicWrite(this.file, JSON.stringify({ last_date: this.lastDate, today: this.today.toJson(), total: this.total.toJson(), hourly }));
    } catch (e) { console.error('[WB] 统计写盘失败:', e.message); }
  }
}
