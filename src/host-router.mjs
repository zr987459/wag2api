/**
 * fix/ttft：host 选择 = AG_ENDPOINTS 顺序 + 会话 host 粘滞 + （可选）健康度降权。
 *
 *  - 粘滞：会话 key → host，TTL 与账号亲和相同（AG_SESSION_TTL_MS）。上游缓存可能按 host 隔离，
 *    同一会话不在 host 之间来回跳；只有成功换 host（首块超时切换 / 5xx 换 host）后才重新绑定。
 *  - 健康度（AG_HOST_HEALTH=1）：每个 host 记最近 10 次 wait_headers_ms，按请求体大小分档
 *    （<256KB / <1MB / ≥1MB）比较，因为等待时间主要由上下文长度决定，跨档比较没有意义。
 *    某 host 在某档的中位数持续 > 其他 host 同档中位数 2 倍（各 ≥3 个样本）时，降权 10 分钟。
 *    降权只影响「还没粘到 host 的新会话」；已粘滞的会话不受影响（缓存比排队更重要）。
 *  - 这里不碰 request 的任何字段，不影响前缀缓存。
 */
import { configuredEndpoints, tuning } from './ag-tuning.mjs';
import { AG_SESSION_TTL_MS } from './account-pool.mjs';

const MAX_STICKY = 1000;
const SAMPLES = 10;
const MIN_SAMPLES = 3;
export const DEMOTE_MS = 10 * 60 * 1000;

export const sizeBucket = bytes => (bytes < 256 * 1024 ? 's' : bytes < 1024 * 1024 ? 'm' : 'l');
const median = a => { const s = a.slice().sort((x, y) => x - y); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };

export class HostRouter {
  constructor({ now = () => Date.now(), endpoints = configuredEndpoints, healthEnabled = () => tuning('AG_HOST_HEALTH') === '1', ttlMs = AG_SESSION_TTL_MS } = {}) {
    this.now = now;
    this.endpoints = endpoints;
    this.healthEnabled = healthEnabled;
    this.ttlMs = ttlMs;
    this.sticky = new Map();   // sessionKey -> { host, expireAt }
    this.samples = new Map();  // host -> [{ ms, b }]
    this.demoted = new Map();  // host -> until
  }

  /** 本次请求的 host 顺序：粘滞 host 在前；否则配置顺序（降权的排到后面） */
  orderFor(sessionKey = '') {
    let list = this.endpoints().slice();
    const now = this.now();
    if (this.healthEnabled()) {
      const bad = list.filter(h => (this.demoted.get(h) || 0) > now);
      if (bad.length && bad.length < list.length) list = [...list.filter(h => !bad.includes(h)), ...bad];
    }
    if (sessionKey) {
      const s = this.sticky.get(sessionKey);
      if (s && s.expireAt > now && list.includes(s.host)) {
        s.expireAt = now + this.ttlMs;
        list = [s.host, ...list.filter(h => h !== s.host)];
      } else if (s) this.sticky.delete(sessionKey);
    }
    return list;
  }

  stickyHost(sessionKey) {
    const s = sessionKey && this.sticky.get(sessionKey);
    return s && s.expireAt > this.now() ? s.host : null;
  }

  bind(sessionKey, host) {
    if (!sessionKey || !host) return;
    this.sticky.delete(sessionKey);
    while (this.sticky.size >= MAX_STICKY) this.sticky.delete(this.sticky.keys().next().value);
    this.sticky.set(sessionKey, { host, expireAt: this.now() + this.ttlMs });
  }

  /** 成功拿到响应头后记一次等待时间 */
  record(host, waitMs, bodyBytes = 0) {
    if (!host || !Number.isFinite(waitMs)) return;
    const arr = this.samples.get(host) || [];
    arr.push({ ms: waitMs, b: sizeBucket(bodyBytes || 0) });
    while (arr.length > SAMPLES) arr.shift();
    this.samples.set(host, arr);
    if (this.healthEnabled()) this._evaluate(host, sizeBucket(bodyBytes || 0));
  }

  _bucketMedian(host, b) {
    const v = (this.samples.get(host) || []).filter(x => x.b === b).map(x => x.ms);
    return v.length >= MIN_SAMPLES ? median(v) : null;
  }

  _evaluate(host, b) {
    const mine = this._bucketMedian(host, b);
    if (mine === null) return;
    const others = [...this.samples.keys()].filter(h => h !== host).map(h => this._bucketMedian(h, b)).filter(v => v !== null);
    if (!others.length) return;
    const best = Math.min(...others);
    if (best > 0 && mine > 2 * best) this.demoted.set(host, this.now() + DEMOTE_MS);
    else if (mine <= 2 * best) this.demoted.delete(host);
  }

  health() {
    const now = this.now();
    const out = {};
    for (const h of new Set([...this.endpoints(), ...this.samples.keys()])) {
      const arr = this.samples.get(h) || [];
      out[h] = { samples: arr.length, median_wait_ms: arr.length ? Math.round(median(arr.map(x => x.ms))) : null, demoted_until: (this.demoted.get(h) || 0) > now ? this.demoted.get(h) : null };
    }
    return { sticky_sessions: this.sticky.size, hosts: out };
  }
}

export const hostRouter = new HostRouter();
