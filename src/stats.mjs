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
const MINUTELY_KEEP_MS = 120 * 60 * 1000;
const HOURLY_KEEP_MS = 48 * 3600 * 1000;
const DAILY_KEEP_DAYS = 92;
const SAVE_DEBOUNCE_MS = 2000;

const pad = v => String(v).padStart(2, '0');
export const utcMinuteKey = d => `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}T${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
export const utcHourKey = d => `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}T${pad(d.getUTCHours())}`;
export const utcDayKey = d => `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
const minuteKeyToMs = k => Date.parse(k.replace(' ', 'T') + ':00Z');
const hourKeyToMs = k => Date.parse(k.replace(' ', 'T') + ':00:00Z');
const num = v => (Number.isFinite(Number(v)) ? Number(v) : 0);
const isOk = s => s >= 200 && s < 300;
const SLOT_FIELDS = ['requests', 'errors', 'input', 'cached', 'output', 'tokens', 'thoughts', 'lat_sum', 'lat_n', 'ttft_sum', 'ttft_n'];

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
    minutely: {}, // 新增分钟桶（key 'YYYY-MM-DDTHH:MM' UTC），只保留最近 120 分钟
    hourly: {}, // { 'YYYY-MM-DDTHH' (UTC): {requests, errors, input, cached, output, tokens} }
    daily: {},  // { 'YYYY-MM-DD'  (UTC): 同上 }
  };
}

function emptySlot() { return { requests: 0, errors: 0, input: 0, cached: 0, output: 0, tokens: 0, thoughts: 0, lat_sum: 0, lat_n: 0, ttft_sum: 0, ttft_n: 0, models: {} }; }

/** 旧版 user_stats.json → schema 2（就地迁移，幂等） */
export function migrateBucket(b) {
  if (!b || typeof b !== 'object') return emptyBucket();
  const wasCurrent = b.schema === STATS_SCHEMA;
  const base = emptyBucket();
  for (const k of Object.keys(base)) if (b[k] === undefined) b[k] = base[k];
  if (!Array.isArray(b.logs)) b.logs = [];
  if (!b.minutely || typeof b.minutely !== 'object') b.minutely = {};
  if (!b.hourly || typeof b.hourly !== 'object') b.hourly = {};
  if (!b.daily || typeof b.daily !== 'object') b.daily = {};

  for (const map of [b.minutely, b.hourly, b.daily]) {
    for (const slot of Object.values(map)) {
      if (slot && typeof slot === 'object' && (!slot.models || typeof slot.models !== 'object')) {
        slot.models = {};
      }
    }
  }

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

    const targetModel = String(model_used || model || 'unknown');
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
      if (!s.models || typeof s.models !== 'object') s.models = {};
      const m = s.models[targetModel] || { requests: 0, errors: 0, input: 0, cached: 0, output: 0, thoughts: 0, tokens: 0 };
      m.requests++;
      if (!ok) m.errors++;
      m.input += inp;
      m.cached += cac;
      m.output += out;
      m.thoughts += thk;
      m.tokens += tot;
      s.models[targetModel] = m;
      map[key] = s;
    };
    if (!bucket.minutely) bucket.minutely = {};
    addSlot(bucket.minutely, utcMinuteKey(now));
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

  /** 按时间而非个数修剪：分钟桶保留 120m，小时桶保留 48h，日桶保留 92 天 */
  prune(bucket, now = new Date()) {
    const mCut = now.getTime() - MINUTELY_KEEP_MS;
    if (bucket.minutely) {
      for (const k of Object.keys(bucket.minutely)) {
        const t = minuteKeyToMs(k);
        if (!Number.isFinite(t) || t < mCut) delete bucket.minutely[k];
      }
    }
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
      if (hourKeyToMs(k) + 3600 * 1000 > cut) for (const f of SLOT_FIELDS) last24[f] += num(v[f]);
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
        for (const f of SLOT_FIELDS) s[f] += num(v[f]);
        if (v.models && typeof v.models === 'object') {
          for (const [mName, mData] of Object.entries(v.models)) {
            const ms = s.models[mName] || { requests: 0, errors: 0, input: 0, cached: 0, output: 0, thoughts: 0, tokens: 0 };
            for (const mf of ['requests', 'errors', 'input', 'cached', 'output', 'thoughts', 'tokens']) {
              ms[mf] += num(mData[mf]);
            }
            s.models[mName] = ms;
          }
        }
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
        for (const f of SLOT_FIELDS) t[f] += num(v[f]);
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
        if (v) for (const f of SLOT_FIELDS) p[f] += num(v[f]);
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
   * Token 消费统计：按时间粒度、按模型、按账号聚合，峰值时段，91 天活跃热力图
   */
  getTokenStats({ range = 'day', now = new Date() } = {}) {
    const validRanges = ['hour', 'day', 'week', 'month', 'all'];
    const r = validRanges.includes(range) ? range : 'day';
    const nowDate = (now instanceof Date && !isNaN(now.getTime())) ? now : new Date(now);
    const safeNow = isNaN(nowDate.getTime()) ? new Date() : nowDate;
    const nowMs = safeNow.getTime();

    // 1. 生成 91 天全账号日热力图（包含今天，旧日补 0）
    const heatmap = [];
    const todayMid = Date.parse(utcDayKey(safeNow) + 'T00:00:00Z');
    for (let i = 90; i >= 0; i--) {
      const dayKey = utcDayKey(new Date(todayMid - i * 86400000));
      let dayTokens = 0;
      let dayRequests = 0;
      for (const b of Object.values(this.userStats)) {
        const slot = b.daily?.[dayKey];
        if (slot) {
          dayTokens += num(slot.tokens);
          dayRequests += num(slot.requests);
        }
      }
      heatmap.push({ day: dayKey, tokens: dayTokens, requests: dayRequests });
    }

    // 2. 根据 range 确定 series 桶与对应槽数据源
    let intervals = [];
    if (r === 'hour') {
      const current5mStart = Math.floor(nowMs / 300000) * 300000;
      for (let i = 11; i >= 0; i--) {
        const ts = current5mStart - i * 300000;
        const keys = [];
        for (let m = 0; m < 5; m++) {
          keys.push(utcMinuteKey(new Date(ts + m * 60000)));
        }
        intervals.push({ ts, keys, mapName: 'minutely' });
      }
    } else if (r === 'day') {
      const currentHourStart = Math.floor(nowMs / 3600000) * 3600000;
      for (let i = 23; i >= 0; i--) {
        const ts = currentHourStart - i * 3600000;
        intervals.push({ ts, keys: [utcHourKey(new Date(ts))], mapName: 'hourly' });
      }
    } else if (r === 'week') {
      const todayStart = Date.parse(utcDayKey(safeNow) + 'T00:00:00Z');
      for (let i = 6; i >= 0; i--) {
        const ts = todayStart - i * 86400000;
        intervals.push({ ts, keys: [utcDayKey(new Date(ts))], mapName: 'daily' });
      }
    } else if (r === 'month') {
      const todayStart = Date.parse(utcDayKey(safeNow) + 'T00:00:00Z');
      for (let i = 29; i >= 0; i--) {
        const ts = todayStart - i * 86400000;
        intervals.push({ ts, keys: [utcDayKey(new Date(ts))], mapName: 'daily' });
      }
    } else if (r === 'all') {
      const daySet = new Set();
      for (const b of Object.values(this.userStats)) {
        if (b.daily) {
          for (const k of Object.keys(b.daily)) daySet.add(k);
        }
      }
      const allDays = Array.from(daySet).sort().slice(-92);
      intervals = allDays.map(k => ({
        ts: Date.parse(k + 'T00:00:00Z'),
        keys: [k],
        mapName: 'daily',
      }));
    }

    // 3. 构建 series 骨架
    const series = intervals.map(iv => ({
      ts: iv.ts,
      requests: 0,
      errors: 0,
      input: 0,
      cached: 0,
      output: 0,
      thoughts: 0,
      tokens: 0,
    }));

    // 4. 聚合账号、模型、series、时延
    const allModels = {};
    const accountsMap = {};
    let windowLatSum = 0, windowLatN = 0;
    let windowTtftSum = 0, windowTtftN = 0;

    for (const [email, b] of Object.entries(this.userStats)) {
      migrateBucket(b);
      const acc = {
        email,
        requests: 0,
        errors: 0,
        input: 0,
        cached: 0,
        output: 0,
        thoughts: 0,
        tokens: 0,
        accModels: {},
      };

      for (let idx = 0; idx < intervals.length; idx++) {
        const iv = intervals[idx];
        const point = series[idx];
        const map = b[iv.mapName] || {};
        for (const k of iv.keys) {
          const slot = map[k];
          if (!slot) continue;

          const reqs = num(slot.requests);
          const errs = num(slot.errors);
          const inp = num(slot.input);
          const cac = num(slot.cached);
          const out = num(slot.output);
          const thk = num(slot.thoughts);
          const tok = num(slot.tokens) || (inp + cac + out);

          acc.requests += reqs;
          acc.errors += errs;
          acc.input += inp;
          acc.cached += cac;
          acc.output += out;
          acc.thoughts += thk;
          acc.tokens += tok;

          point.requests += reqs;
          point.errors += errs;
          point.input += inp;
          point.cached += cac;
          point.output += out;
          point.thoughts += thk;
          point.tokens += tok;

          if (num(slot.lat_n) > 0) {
            windowLatSum += num(slot.lat_sum);
            windowLatN += num(slot.lat_n);
          }
          if (num(slot.ttft_n) > 0) {
            windowTtftSum += num(slot.ttft_sum);
            windowTtftN += num(slot.ttft_n);
          }

          if (slot.models && typeof slot.models === 'object') {
            for (const [mName, mData] of Object.entries(slot.models)) {
              if (!mData) continue;
              const am = acc.accModels[mName] || { requests: 0, errors: 0, input: 0, cached: 0, output: 0, thoughts: 0, tokens: 0 };
              am.requests += num(mData.requests);
              am.errors += num(mData.errors);
              am.input += num(mData.input);
              am.cached += num(mData.cached);
              am.output += num(mData.output);
              am.thoughts += num(mData.thoughts);
              am.tokens += num(mData.tokens);
              acc.accModels[mName] = am;

              const gm = allModels[mName] || { requests: 0, errors: 0, input: 0, cached: 0, output: 0, thoughts: 0, tokens: 0 };
              gm.requests += num(mData.requests);
              gm.errors += num(mData.errors);
              gm.input += num(mData.input);
              gm.cached += num(mData.cached);
              gm.output += num(mData.output);
              gm.thoughts += num(mData.thoughts);
              gm.tokens += num(mData.tokens);
              allModels[mName] = gm;
            }
          }
        }
      }

      if (r === 'all') {
        // all 的账号汇总使用账号桶累计总数
        acc.requests = num(b.total_requests);
        acc.errors = num(b.error_requests);
        acc.input = num(b.input_tokens);
        acc.cached = num(b.cached_tokens);
        acc.output = num(b.output_tokens);
        acc.thoughts = num(b.thoughts_tokens);
        acc.tokens = num(b.total_tokens) || (acc.input + acc.cached + acc.output);
      }

      accountsMap[email] = acc;
    }

    // 5. 汇总 summary
    let summary;
    if (r === 'all') {
      let totalReqs = 0, totalSucc = 0, totalErrs = 0;
      let totalInp = 0, totalCac = 0, totalOut = 0, totalThk = 0, totalTok = 0;
      let totalLatSum = 0, totalLatN = 0, totalTtftSum = 0, totalTtftN = 0;
      for (const b of Object.values(this.userStats)) {
        totalReqs += num(b.total_requests);
        totalSucc += num(b.success_requests);
        totalErrs += num(b.error_requests);
        totalInp += num(b.input_tokens);
        totalCac += num(b.cached_tokens);
        totalOut += num(b.output_tokens);
        totalThk += num(b.thoughts_tokens);
        totalTok += num(b.total_tokens) || (num(b.input_tokens) + num(b.cached_tokens) + num(b.output_tokens));
        totalLatSum += num(b.latency_sum_ms);
        totalLatN += num(b.latency_count);
        totalTtftSum += num(b.ttft_sum_ms);
        totalTtftN += num(b.ttft_count);
      }
      summary = {
        requests: totalReqs,
        success: totalSucc,
        errors: totalErrs,
        input: totalInp,
        cached: totalCac,
        output: totalOut,
        thoughts: totalThk,
        tokens: totalTok,
        cache_hit_rate: cacheHitRate(totalInp, totalCac),
        avg_latency_ms: totalLatN ? Math.round(totalLatSum / totalLatN) : 0,
        avg_ttft_ms: totalTtftN ? Math.round(totalTtftSum / totalTtftN) : null,
      };
    } else {
      let winReqs = 0, winErrs = 0, winInp = 0, winCac = 0, winOut = 0, winThk = 0, winTok = 0;
      for (const p of series) {
        winReqs += p.requests;
        winErrs += p.errors;
        winInp += p.input;
        winCac += p.cached;
        winOut += p.output;
        winThk += p.thoughts;
        winTok += p.tokens;
      }
      summary = {
        requests: winReqs,
        success: Math.max(0, winReqs - winErrs),
        errors: winErrs,
        input: winInp,
        cached: winCac,
        output: winOut,
        thoughts: winThk,
        tokens: winTok,
        cache_hit_rate: cacheHitRate(winInp, winCac),
        avg_latency_ms: windowLatN ? Math.round(windowLatSum / windowLatN) : 0,
        avg_ttft_ms: windowTtftN ? Math.round(windowTtftSum / windowTtftN) : null,
      };
    }

    // 6. 模型列表（按 tokens 降序）
    const totalTokens = summary.tokens;
    const modelsList = [];
    for (const [model, m] of Object.entries(allModels)) {
      if (m.requests <= 0 && m.tokens <= 0) continue;
      modelsList.push({
        model,
        requests: m.requests,
        errors: m.errors,
        input: m.input,
        cached: m.cached,
        output: m.output,
        thoughts: m.thoughts,
        tokens: m.tokens,
        share: totalTokens > 0 ? Math.round((m.tokens / totalTokens) * 10000) / 10000 : 0,
      });
    }
    modelsList.sort((a, b) => b.tokens - a.tokens || b.requests - a.requests);

    // 7. 账号列表（按 tokens 降序）
    const accountsList = [];
    for (const acc of Object.values(accountsMap)) {
      if (acc.requests <= 0 && acc.tokens <= 0) continue;
      let topModel = null;
      let maxTokens = -1;
      let maxReqs = -1;
      for (const [mName, mData] of Object.entries(acc.accModels)) {
        const mTok = num(mData.tokens);
        const mReq = num(mData.requests);
        if (mTok > maxTokens || (mTok === maxTokens && mReq > maxReqs)) {
          maxTokens = mTok;
          maxReqs = mReq;
          topModel = mName;
        }
      }

      accountsList.push({
        email: acc.email,
        requests: acc.requests,
        errors: acc.errors,
        input: acc.input,
        cached: acc.cached,
        output: acc.output,
        thoughts: acc.thoughts,
        tokens: acc.tokens,
        share: totalTokens > 0 ? Math.round((acc.tokens / totalTokens) * 10000) / 10000 : 0,
        cache_hit_rate: cacheHitRate(acc.input, acc.cached),
        top_model: topModel,
      });
    }
    accountsList.sort((a, b) => b.tokens - a.tokens || b.requests - a.requests);

    summary.active_accounts = accountsList.length;
    summary.active_models = modelsList.length;

    // 8. 峰值时段 (peak)
    let peak = null;
    for (const p of series) {
      if (p.tokens > 0 || p.requests > 0) {
        if (!peak || p.tokens > peak.tokens || (p.tokens === peak.tokens && p.requests > peak.requests)) {
          peak = { ts: p.ts, tokens: p.tokens, requests: p.requests };
        }
      }
    }

    return {
      range: r,
      timezone: 'UTC',
      generated_at: nowMs,
      summary,
      series,
      models: modelsList,
      accounts: accountsList,
      peak,
      heatmap,
    };
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
