/**
 * Multi-Tenant Usage & Telemetry Stats Tracker (按账号隔离统计 + 24h/7d 趋势)
 *
 * 记账口径（见 usage.mjs）：
 *   input_tokens   未命中缓存的输入 token（Gemini prompt + toolUse - cached）
 *   cached_tokens  命中缓存的输入 token（= Anthropic cache_read_input_tokens）
 *   output_tokens  输出 token，含思考 token（thoughts_tokens 单独再记一份明细）
 *   total_tokens   = input + cached + output（不重复计算）
 *   cache_hit_rate = cached / (input + cached)，分母为 0 时为 null
 *   avg_latency_ms = 成功请求（2xx）的总耗时均值（latency_sum_ms / latency_count）
 *   avg_ttft_ms    = 成功流式请求的首 token 耗时均值
 *
 * 时间桶一律使用 UTC key（hourly: 'YYYY-MM-DDTHH'，daily: 'YYYY-MM-DD'），
 * 前端按浏览器本地时区渲染；日志带毫秒 timestamp。
 *
 * 持久化：内存为准，2 秒防抖写盘（原子写 tmp + rename），进程退出 / SIGTERM / SIGINT 时同步刷盘。
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { cacheHitRate } from './usage.mjs';

export const STATS_SCHEMA = 2;
const HOURLY_KEEP_MS = 48 * 3600 * 1000;
const DAILY_KEEP_DAYS = 35;
const SAVE_DEBOUNCE_MS = 2000;

const pad = v => String(v).padStart(2, '0');
export const utcHourKey = d => `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}T${pad(d.getUTCHours())}`;
export const utcDayKey = d => `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
const hourKeyToMs = k => Date.parse(k.replace(' ', 'T') + ':00:00Z');
const num = v => (Number.isFinite(Number(v)) ? Number(v) : 0);
const isOk = s => s >= 200 && s < 300;

function emptyBucket() {
  return {
    schema: STATS_SCHEMA,
    total_requests: 0,
    success_requests: 0,
    error_requests: 0,
    input_tokens: 0,
    cached_tokens: 0,
    output_tokens: 0,
    thoughts_tokens: 0,
    total_tokens: 0,
    latency_sum_ms: 0,
    latency_count: 0,
    avg_latency_ms: 0,
    ttft_sum_ms: 0,
    ttft_count: 0,
    avg_ttft_ms: 0,
    logs: [],
    downgrades: [], // PR1：最近 48h 的降级记录 { ts, from, to, reason }
    hourly: {}, // { 'YYYY-MM-DDTHH' (UTC): {requests, errors, input, cached, output, tokens} }
    daily: {},  // { 'YYYY-MM-DD'  (UTC): 同上 }
  };
}

function emptySlot() { return { requests: 0, errors: 0, input: 0, cached: 0, output: 0, tokens: 0, thoughts: 0, lat_sum: 0, lat_n: 0, ttft_sum: 0, ttft_n: 0 }; }

/** 旧版 user_stats.json → schema 2（就地迁移，幂等） */
export function migrateBucket(b) {
  if (!b || typeof b !== 'object') return emptyBucket();
  const wasCurrent = b.schema === STATS_SCHEMA;
  const base = emptyBucket();
  for (const k of Object.keys(base)) if (b[k] === undefined) b[k] = base[k];
  if (!Array.isArray(b.logs)) b.logs = [];
  if (wasCurrent) return b;

  // 旧版 total_tokens = input + output，漏算了缓存 token
  b.input_tokens = num(b.input_tokens);
  b.cached_tokens = num(b.cached_tokens);
  b.output_tokens = num(b.output_tokens);
  b.total_tokens = b.input_tokens + b.cached_tokens + b.output_tokens;

  // 旧版 avg_latency_ms 实为"最后一次请求的延迟"；用仍保留的日志重建真实均值
  let lsum = 0, lcnt = 0, errs = 0;
  for (const l of b.logs) {
    if (!isOk(num(l.status))) { errs++; continue; }
    if (num(l.latency_ms) > 0) { lsum += num(l.latency_ms); lcnt++; }
    if (l.tokens && l.tokens.total === undefined) {
      l.tokens.total = num(l.tokens.input) + num(l.tokens.cached) + num(l.tokens.output);
    }
    if (l.cache_hit_rate === undefined && l.tokens) l.cache_hit_rate = cacheHitRate(num(l.tokens.input), num(l.tokens.cached));
  }
  b.latency_sum_ms = lsum; b.latency_count = lcnt;
  b.avg_latency_ms = lcnt ? Math.round(lsum / lcnt) : 0;
  // 旧版不区分成败，只能从保留日志里估计错误数
  b.error_requests = Math.min(errs, num(b.total_requests));
  b.success_requests = num(b.total_requests) - b.error_requests;

  // 旧版小时 key 'YYYY-MM-DD HH' 为服务器本地时间（云端容器通常即 UTC），按 UTC 解释
  const hourly = {};
  for (const [k, v] of Object.entries(b.hourly || {})) {
    hourly[k.replace(' ', 'T')] = { ...emptySlot(), ...v };
  }
  b.hourly = hourly;
  for (const [k, v] of Object.entries(b.daily || {})) b.daily[k] = { ...emptySlot(), ...v };
  b.schema = STATS_SCHEMA;
  b.migrated_from_v1 = true; // 迁移前的 output 不含思考 token，hourly/daily tokens 不含缓存 token
  return b;
}

// PR2 分段打点字段（相对请求开始的毫秒数）
export const TIMING_MS_FIELDS = ['t_token', 't_payload', 't_tls', 't_headers', 't_first_thought', 't_first_text'];

function cleanTiming(t) {
  const o = {};
  for (const f of TIMING_MS_FIELDS) o[f] = t[f] === null || t[f] === undefined || !Number.isFinite(Number(t[f])) ? null : Math.max(0, Math.round(Number(t[f])));
  o.host = t.host ? String(t.host).slice(0, 80) : null;
  o.attempts = Math.max(0, Math.round(num(t.attempts)));
  o.switched_account = Boolean(t.switched_account);
  o.switched_host = Boolean(t.switched_host);
  o.conn_reused = t.conn_reused === true ? true : t.conn_reused === false ? false : null;
  return o;
}

/** 中位数：忽略 null / 非数值；空集返回 null */
export function median(values) {
  const a = values.filter(v => v !== null && v !== undefined && Number.isFinite(Number(v))).map(Number).sort((x, y) => x - y);
  if (!a.length) return null;
  const m = a.length >> 1;
  return a.length % 2 ? a[m] : Math.round(((a[m - 1] + a[m]) / 2) * 1000) / 1000;
}

export class StatsTracker {
  constructor(storageDir, { autoFlushOnExit = true } = {}) {
    this.storageDir = storageDir;
    this.dataFile = path.join(storageDir, 'user_stats.json');
    this.userStats = {};
    this.maxLogsPerUser = 100;
    this.saveTimer = null;
    this.dirty = false;
    this.ensureStorage();
    this.load();
    if (autoFlushOnExit) this.installExitHooks();
  }

  ensureStorage() {
    if (!fs.existsSync(this.storageDir)) fs.mkdirSync(this.storageDir, { recursive: true });
  }

  load() {
    try {
      if (fs.existsSync(this.dataFile)) {
        const raw = JSON.parse(fs.readFileSync(this.dataFile, 'utf-8')) || {};
        for (const [k, b] of Object.entries(raw)) raw[k] = migrateBucket(b);
        this.userStats = raw;
      }
    } catch (e) {
      console.error('[Stats] 读取 user_stats.json 失败，已从空白开始:', e.message);
      this.userStats = {};
    }
  }

  /** 防抖写盘：高并发下不会每个请求都同步写一次大 JSON */
  save() {
    this.dirty = true;
    if (this.saveTimer) return;
    this.saveTimer = setTimeout(() => { this.saveTimer = null; this.flush(); }, SAVE_DEBOUNCE_MS);
    this.saveTimer.unref?.();
  }

  flush() {
    if (this.saveTimer) { clearTimeout(this.saveTimer); this.saveTimer = null; }
    if (!this.dirty) return;
    try {
      const tmp = this.dataFile + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(this.userStats), 'utf-8');
      fs.renameSync(tmp, this.dataFile);
      this.dirty = false;
    } catch (e) {
      console.error('[Stats] 写盘失败:', e.message);
    }
  }

  installExitHooks() {
    process.on('exit', () => this.flush());
    // SIGTERM / SIGINT 的集中处理在 server.mjs 里，这里不再抢注册，
    // 否则 process.exit(0) 会提前杀掉进程，server.close() 来不及 drain。
  }

  getUserBucket(email) {
    const key = (email || 'anonymous').trim().toLowerCase();
    if (!this.userStats[key]) this.userStats[key] = emptyBucket();
    return { key, bucket: migrateBucket(this.userStats[key]) };
  }

  /**
   * 每个请求恰好调用一次（成功 / 上游错误 / 客户端断开 都要记）
   * input_tokens 为【未命中缓存】的输入；cached_tokens 为命中缓存的输入；output_tokens 已含思考 token。
   */
  recordRequest({
    email,
    model,
    latency_ms,
    status = 200,
    input_tokens = 0,
    output_tokens = 0,
    cached_tokens = 0,
    thoughts_tokens = 0,
    ttft_ms = null,
    is_stream = false,
    error = null,
    timing = null,
    model_used = null,
    downgraded = false,
    downgrade_reason = null,
    now = new Date(),
  }) {
    const { bucket } = this.getUserBucket(email);
    const inp = Math.max(0, num(input_tokens));
    const cac = Math.max(0, num(cached_tokens));
    const out = Math.max(0, num(output_tokens));
    const thk = Math.max(0, num(thoughts_tokens));
    const tot = inp + cac + out;
    const ok = isOk(status);
    const lat = Math.max(0, Math.round(num(latency_ms)));

    bucket.total_requests++;
    if (ok) bucket.success_requests++; else bucket.error_requests++;
    bucket.input_tokens += inp;
    bucket.cached_tokens += cac;
    bucket.output_tokens += out;
    bucket.thoughts_tokens += thk;
    bucket.total_tokens = bucket.input_tokens + bucket.cached_tokens + bucket.output_tokens;

    if (ok && lat > 0) {
      bucket.latency_sum_ms += lat;
      bucket.latency_count++;
      bucket.avg_latency_ms = Math.round(bucket.latency_sum_ms / bucket.latency_count);
    }
    if (ok && ttft_ms !== null && ttft_ms !== undefined && num(ttft_ms) >= 0) {
      bucket.ttft_sum_ms += Math.round(num(ttft_ms));
      bucket.ttft_count++;
      bucket.avg_ttft_ms = Math.round(bucket.ttft_sum_ms / bucket.ttft_count);
    }

    const addSlot = (map, key) => {
      const s = map[key] || emptySlot();
      s.requests++;
      if (!ok) s.errors++;
      s.input += inp; s.cached += cac; s.output += out; s.tokens += tot;
      s.thoughts = num(s.thoughts) + thk;
      if (ok && lat > 0) { s.lat_sum = num(s.lat_sum) + lat; s.lat_n = num(s.lat_n) + 1; }
      if (ok && ttft_ms !== null && ttft_ms !== undefined && num(ttft_ms) >= 0) {
        s.ttft_sum = num(s.ttft_sum) + Math.round(num(ttft_ms)); s.ttft_n = num(s.ttft_n) + 1;
      }
      map[key] = s;
    };
    addSlot(bucket.hourly, utcHourKey(now));
    addSlot(bucket.daily, utcDayKey(now));
    this.prune(bucket, now);

    const ts = now.getTime();
    bucket.logs.unshift({
      id: ts + '_' + Math.random().toString(36).substring(2, 6),
      time: now.toISOString(), // 兼容旧字段；前端用 timestamp 按本地时区显示
      timestamp: ts,
      model,
      latency_ms: lat,
      ttft_ms: ttft_ms === null || ttft_ms === undefined ? null : Math.round(num(ttft_ms)),
      status,
      tokens: { input: inp, cached: cac, output: out, thoughts: thk, total: tot },
      cache_hit_rate: cacheHitRate(inp, cac),
      is_stream,
      error,
      ...(timing ? { timing: cleanTiming(timing) } : {}),
      ...(model_used ? { model_used: String(model_used).slice(0, 80) } : {}),
      ...(downgraded ? { downgraded: true, downgrade_reason: downgrade_reason ? String(downgrade_reason).slice(0, 40) : null } : {}),
    });
    if (downgraded) {
      if (!Array.isArray(bucket.downgrades)) bucket.downgrades = [];
      bucket.downgrades.push({ ts, from: model, to: model_used, reason: downgrade_reason || 'unknown' });
    }
    if (bucket.logs.length > this.maxLogsPerUser) bucket.logs.length = this.maxLogsPerUser;

    this.save();
  }

  /** 按时间而非个数修剪：小时桶保留 48h，日桶保留 35 天 */
  prune(bucket, now = new Date()) {
    const hCut = now.getTime() - HOURLY_KEEP_MS;
    for (const k of Object.keys(bucket.hourly)) {
      const t = hourKeyToMs(k);
      if (!Number.isFinite(t) || t < hCut) delete bucket.hourly[k];
    }
    if (Array.isArray(bucket.downgrades)) {
      bucket.downgrades = bucket.downgrades.filter(d => d.ts >= hCut);
      if (bucket.downgrades.length > 1000) bucket.downgrades = bucket.downgrades.slice(-1000);
    }
    const dCut = utcDayKey(new Date(now.getTime() - DAILY_KEEP_DAYS * 86400000));
    for (const k of Object.keys(bucket.daily)) if (k < dCut) delete bucket.daily[k];
  }

  summarize(b, now = new Date()) {
    const last24 = emptySlot();
    const cut = now.getTime() - 24 * 3600 * 1000;
    for (const [k, v] of Object.entries(b.hourly || {})) {
      if (hourKeyToMs(k) + 3600 * 1000 > cut) for (const f of Object.keys(last24)) last24[f] += num(v[f]);
    }
    last24.cache_hit_rate = cacheHitRate(last24.input, last24.cached);
    return {
      total_requests: num(b.total_requests),
      success_requests: num(b.success_requests),
      error_requests: num(b.error_requests),
      total_tokens: num(b.input_tokens) + num(b.cached_tokens) + num(b.output_tokens),
      input_tokens: num(b.input_tokens),
      cached_tokens: num(b.cached_tokens),
      output_tokens: num(b.output_tokens),
      thoughts_tokens: num(b.thoughts_tokens),
      prompt_tokens: num(b.input_tokens) + num(b.cached_tokens),
      cache_hit_rate: cacheHitRate(num(b.input_tokens), num(b.cached_tokens)),
      avg_latency_ms: b.latency_count ? Math.round(b.latency_sum_ms / b.latency_count) : 0,
      avg_ttft_ms: b.ttft_count ? Math.round(b.ttft_sum_ms / b.ttft_count) : null,
      latency_count: num(b.latency_count),
      ttft_count: num(b.ttft_count),
      last_24h: last24,
    };
  }

  /** 总览 = 各账号桶逐项求和（比率与均值由求和后的分子分母重新计算，而不是平均各账号的比率） */
  getStats(email = null) {
    if (email) return this.getUserStats(email);
    const agg = emptyBucket();
    const accounts = [];
    for (const [key, b] of Object.entries(this.userStats)) {
      migrateBucket(b);
      for (const f of ['total_requests', 'success_requests', 'error_requests', 'input_tokens', 'cached_tokens', 'output_tokens', 'thoughts_tokens', 'latency_sum_ms', 'latency_count', 'ttft_sum_ms', 'ttft_count']) agg[f] += num(b[f]);
      for (const [k, v] of Object.entries(b.hourly || {})) {
        const s = agg.hourly[k] || emptySlot();
        for (const f of Object.keys(s)) s[f] += num(v[f]);
        agg.hourly[k] = s;
      }
      accounts.push({ email: key, ...this.summarize(b) });
    }
    accounts.sort((a, b) => b.total_tokens - a.total_tokens || b.total_requests - a.total_requests);
    return {
      ...this.summarize(agg),
      today: this.todaySummary(),
      timing_recent: this.getTimingSummary(20),
      downgrade_24h: this.getDowngradeSummary(agg),
      accounts,
      schema: STATS_SCHEMA,
      legacy_data: Object.values(this.userStats).some(b => b.migrated_from_v1),
    };
  }

  getUserStats(email) {
    const { key, bucket } = this.getUserBucket(email);
    return { email: key, ...this.summarize(bucket) };
  }

  /**
   * 趋势数据（按账号隔离）。返回每个桶的起始 UTC 毫秒 ts，前端自行按本地时区格式化标签。
   */
  getTrendData(email, mode = '24h') {
    const { bucket } = this.getUserBucket(email);
    const now = new Date();
    const points = [];
    if (mode === '7d') {
      for (let i = 6; i >= 0; i--) {
        const t = new Date(now.getTime() - i * 86400000);
        const k = utcDayKey(t);
        points.push({ key: k, ts: Date.parse(k + 'T00:00:00Z'), ...emptySlot(), ...(bucket.daily?.[k] || {}) });
      }
    } else {
      for (let i = 23; i >= 0; i--) {
        const k = utcHourKey(new Date(now.getTime() - i * 3600000));
        points.push({ key: k, ts: hourKeyToMs(k), ...emptySlot(), ...(bucket.hourly?.[k] || {}) });
      }
    }
    return {
      mode,
      timezone: 'UTC',
      points,
      labels: points.map(p => p.key),
      tokens: points.map(p => p.tokens),
      requests: points.map(p => p.requests),
    };
  }

  /** 手机本地日 0 点至今（按小时桶累加，与 WB 引擎"今日"口径一致） */
  todaySummary(now = new Date()) {
    const mid = new Date(now); mid.setHours(0, 0, 0, 0);
    const t = emptySlot();
    for (const b of Object.values(this.userStats)) {
      for (const [k, v] of Object.entries(b.hourly || {})) {
        if (hourKeyToMs(k) + 3600 * 1000 <= mid.getTime()) continue;
        for (const f of Object.keys(t)) t[f] += num(v[f]);
      }
    }
    return {
      total_requests: t.requests,
      success_requests: t.requests - t.errors,
      error_requests: t.errors,
      input_tokens: t.input,
      cached_tokens: t.cached,
      output_tokens: t.output,
      thoughts_tokens: t.thoughts,
      total_tokens: t.input + t.cached + t.output,
      cache_hit_rate: cacheHitRate(t.input, t.cached),
      avg_latency_ms: t.lat_n ? Math.round(t.lat_sum / t.lat_n) : 0,
      avg_ttft_ms: t.ttft_n ? Math.round(t.ttft_sum / t.ttft_n) : null,
    };
  }

  /** 所有账号合计的 24 小时趋势（UTC 整点，ts 为毫秒） */
  getAggregateTrend() {
    const now = new Date();
    const points = [];
    for (let i = 23; i >= 0; i--) {
      const k = utcHourKey(new Date(now.getTime() - i * 3600000));
      const p = { key: k, ts: hourKeyToMs(k), ...emptySlot() };
      for (const b of Object.values(this.userStats)) {
        const v = b.hourly?.[k];
        if (v) for (const f of Object.keys(emptySlot())) p[f] += num(v[f]);
      }
      points.push(p);
    }
    return { mode: '24h', timezone: 'UTC', points };
  }

  /** 近 7 天用量（UTC 日） */
  getUserWeekUsage(email) {
    const { bucket } = this.getUserBucket(email);
    const now = new Date();
    let requests = 0, tokens = 0;
    for (let i = 0; i < 7; i++) {
      const d = bucket.daily?.[utcDayKey(new Date(now.getTime() - i * 86400000))];
      if (d) { requests += num(d.requests); tokens += num(d.tokens); }
    }
    const today = bucket.daily?.[utcDayKey(now)];
    return { requests_7d: requests, tokens_7d: tokens, requests_today: today?.requests || 0, tokens_today: today?.tokens || 0 };
  }

  /**
   * PR2：最近 n 条（默认 20）成功请求的分段耗时中位数，全账号合并。
   * 只统计带 timing 的日志；ms 字段取中位数，host 给出分布，换号/换 host 给出次数。
   */
  getTimingSummary(n = 20) {
    const logs = this.getAllLogs(Infinity).filter(l => l.timing && isOk(num(l.status))).slice(0, Math.max(1, Math.min(100, n)));
    const out = { n: logs.length };
    for (const f of TIMING_MS_FIELDS) out[f] = median(logs.map(l => l.timing[f]));
    out.ttft_ms = median(logs.map(l => l.ttft_ms));
    out.latency_ms = median(logs.map(l => l.latency_ms));
    out.attempts = median(logs.map(l => l.timing.attempts));
    out.cached_tokens = median(logs.map(l => l.tokens?.cached));
    out.input_tokens = median(logs.map(l => l.tokens?.input));
    out.cache_hit_rate = median(logs.map(l => l.cache_hit_rate));
    out.hosts = {};
    for (const l of logs) if (l.timing.host) out.hosts[l.timing.host] = (out.hosts[l.timing.host] || 0) + 1;
    out.switched_account = logs.filter(l => l.timing.switched_account).length;
    out.switched_host = logs.filter(l => l.timing.switched_host).length;
    out.conn_reused = logs.filter(l => l.timing.conn_reused === true).length;
    out.conn_new = logs.filter(l => l.timing.conn_reused === false).length;
    return out;
  }

  /** PR1：最近 24 小时降级次数、降级率（占同期请求）、原因分布、降到了哪些模型 */
  getDowngradeSummary(agg = null, now = new Date()) {
    const cut = now.getTime() - 24 * 3600 * 1000;
    const out = { count: 0, requests: 0, rate: null, reasons: {}, models: {} };
    for (const b of Object.values(this.userStats)) {
      for (const d of b.downgrades || []) {
        if (d.ts < cut) continue;
        out.count++;
        out.reasons[d.reason] = (out.reasons[d.reason] || 0) + 1;
        if (d.to) out.models[d.to] = (out.models[d.to] || 0) + 1;
      }
    }
    const hourly = agg ? agg.hourly : null;
    if (hourly) {
      for (const [k, v] of Object.entries(hourly)) if (hourKeyToMs(k) + 3600 * 1000 > cut) out.requests += num(v.requests);
    }
    out.rate = out.requests ? Math.round((out.count / out.requests) * 10000) / 10000 : null;
    return out;
  }

  getUserLogs(email) {
    return this.getUserBucket(email).bucket.logs;
  }

  getAllLogs(limit = 100) {
    const all = [];
    for (const [email, b] of Object.entries(this.userStats)) for (const l of b.logs || []) all.push({ ...l, email });
    return all.sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0)).slice(0, limit);
  }

  clearAllLogs() {
    for (const b of Object.values(this.userStats)) b.logs = [];
    this.save();
  }

  /** 彻底重置所有用量统计与历史数据（清零分母，便于重置大盘命中率） */
  resetStats() {
    this.userStats = {};
    this.dirty = true;
    this.flush();
  }

  clearUserLogs(email) {
    this.getUserBucket(email).bucket.logs = [];
    this.save();
  }
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
import { DATA_DIR } from './paths.mjs';
export const statsTracker = new StatsTracker(DATA_DIR);
