/**
 * Real-time Google Antigravity Quota Telemetry Fetcher (v3 - enhanced)
 *
 * 核心原则：宁可显示 '--'，也绝不伪造 100%。
 * 1. 遍历全部模型条目，收集所有能识别到的真实配额数据（兼容多种字段形态）；
 * 2. 从 {limit, usage} / {remaining, total} / remainingFraction 精确计算百分比；
 * 3. Protobuf JSON 省略值为 0 的字段：有 resetTime 缺 remainingFraction 时视为 0；
 * 4. retrieveUserQuotaSummary 拿到第一个 2xx 即返回；
 * 5. 分组识别：argon -> 'argon', claude/gpt/3p -> 'claude', gemini -> 'gemini'；
 * 6. 动态 buckets 列表只含真实有数据的桶，并按 gemini, claude, argon (5h 在前) 排序；
 * 7. loadCodeAssist 查询订阅等级 (ULTRA/PRO/FREE)，按 email 缓存 6 小时。
 */

import fs from 'fs';
import path from 'path';
import { DATA_DIR } from './paths.mjs';

export function parseResetTime(resetTimeStr) {
  if (!resetTimeStr) return null;
  try {
    const target = new Date(resetTimeStr).getTime();
    if (Number.isNaN(target)) return null;
    const diff = target - Date.now();
    if (diff <= 0) return '已重置';
    const hours = Math.floor(diff / (1000 * 60 * 60));
    const mins = Math.floor((diff % (1000 * 60 * 60)) / (1000 * 60));
    if (hours > 24) {
      const days = Math.floor(hours / 24);
      return `${days}天${hours % 24}小时后`;
    }
    return `${hours}小时${mins}分后`;
  } catch (e) {
    return null;
  }
}

const WEEKLY_THRESHOLD_HOURS = 6;

export function hoursUntil(resetTimeStr) {
  if (!resetTimeStr) return -1;
  const t = new Date(resetTimeStr).getTime();
  return Number.isNaN(t) ? -1 : (t - Date.now()) / 3600000;
}

const OBSERVED_FILE = path.join(DATA_DIR, 'quota_observed.json');

let observedLoaded = false;
// email -> Map<bucketKey, { fraction, reset, observed_at }>
const observedStore = new Map();
let saveTimer = null;
let isDirty = false;

function getObservedFilePath() {
  return OBSERVED_FILE;
}

export function loadObservedQuotas() {
  if (observedLoaded) return;
  observedLoaded = true;
  try {
    const filePath = getObservedFilePath();
    if (fs.existsSync(filePath)) {
      const content = fs.readFileSync(filePath, 'utf-8');
      const data = JSON.parse(content);
      if (data && typeof data === 'object') {
        for (const [rawEmail, buckets] of Object.entries(data)) {
          if (!buckets || typeof buckets !== 'object') continue;
          const email = String(rawEmail).trim().toLowerCase();
          let bucketMap = observedStore.get(email);
          if (!bucketMap) {
            bucketMap = new Map();
            observedStore.set(email, bucketMap);
          }
          for (const [bKey, val] of Object.entries(buckets)) {
            if (val && typeof val.fraction === 'number') {
              bucketMap.set(bKey, {
                fraction: val.fraction,
                reset: val.reset || null,
                observed_at: typeof val.observed_at === 'number' ? val.observed_at : Date.now(),
              });
            }
          }
        }
      }
    }
  } catch (e) {
    // 读容错
  }
}

export function flushObservedQuotasSync() {
  if (saveTimer) {
    clearTimeout(saveTimer);
    saveTimer = null;
  }
  if (!isDirty) return;
  try {
    const filePath = getObservedFilePath();
    const dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    const obj = {};
    for (const [email, bucketMap] of observedStore.entries()) {
      const emailObj = {};
      for (const [bKey, val] of bucketMap.entries()) {
        emailObj[bKey] = {
          fraction: val.fraction,
          reset: val.reset,
          observed_at: val.observed_at,
        };
      }
      obj[email] = emailObj;
    }
    fs.writeFileSync(filePath, JSON.stringify(obj, null, 2), 'utf-8');
    isDirty = false;
  } catch (e) {
    // 写容错
  }
}

function scheduleSaveObservedQuotas() {
  isDirty = true;
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    flushObservedQuotasSync();
  }, 1000);
  if (typeof saveTimer.unref === 'function') {
    saveTimer.unref();
  }
}

if (typeof process !== 'undefined' && typeof process.on === 'function') {
  process.on('beforeExit', () => {
    flushObservedQuotasSync();
  });
}

export function setObservedQuota(email, bucketKey, record) {
  loadObservedQuotas();
  const normEmail = String(email || 'default').trim().toLowerCase();
  let bucketMap = observedStore.get(normEmail);
  if (!bucketMap) {
    bucketMap = new Map();
    observedStore.set(normEmail, bucketMap);
  }
  bucketMap.set(bucketKey, {
    fraction: record.fraction,
    reset: record.reset || null,
    observed_at: typeof record.observed_at === 'number' ? record.observed_at : Date.now(),
  });
  scheduleSaveObservedQuotas();
}

export function getObservedQuotas(email) {
  loadObservedQuotas();
  const normEmail = String(email || 'default').trim().toLowerCase();
  const bucketMap = observedStore.get(normEmail);
  if (!bucketMap) return {};
  const res = {};
  for (const [k, v] of bucketMap.entries()) {
    res[k] = { ...v };
  }
  return res;
}

export function clearObservedQuotas() {
  observedStore.clear();
  observedLoaded = true;
  isDirty = true;
  flushObservedQuotasSync();
}

/**
 * 合并新旧观测记录：
 * 1. 对 summary 真实出现的桶，更新观测记录（observed_at=now，同一桶取 observed_at 更新者）
 * 2. 对 summary 缺失但有观测记录的桶：
 *    - reset 在未来：使用记录值，source:'observed'，带 observed_at
 *    - reset 已过：视为已刷新，fraction=1，source:'observed-reset'，inferred:true，reset 置空
 *    - 无记录：保持 missing
 */
export function applyObservedFallback(email, summary = {}, now = Date.now()) {
  loadObservedQuotas();
  const normEmail = String(email || 'default').trim().toLowerCase();
  let bucketMap = observedStore.get(normEmail);
  if (!bucketMap) {
    bucketMap = new Map();
    observedStore.set(normEmail, bucketMap);
  }

  const effective = {};

  for (const [bKey, item] of Object.entries(summary || {})) {
    if (!item || typeof item.fraction !== 'number') continue;
    const itemObservedAt = (typeof item.observed_at === 'number') ? item.observed_at : now;
    const existing = bucketMap.get(bKey);

    if (existing && existing.observed_at > itemObservedAt) {
      // 已有记录更新，沿用已有记录
      let isExpired = false;
      if (existing.reset) {
        const resetMs = new Date(existing.reset).getTime();
        if (!Number.isNaN(resetMs) && resetMs <= now) isExpired = true;
      }
      if (isExpired) {
        effective[bKey] = {
          fraction: 1,
          reset: null,
          source: 'observed-reset',
          inferred: true,
          observed_at: existing.observed_at,
        };
      } else {
        effective[bKey] = {
          fraction: existing.fraction,
          reset: existing.reset,
          source: 'observed',
          inferred: false,
          observed_at: existing.observed_at,
        };
      }
    } else {
      // 新观测更新或并列，更新记录
      const updated = {
        fraction: item.fraction,
        reset: item.reset || null,
        observed_at: itemObservedAt,
      };
      bucketMap.set(bKey, updated);
      scheduleSaveObservedQuotas();

      effective[bKey] = {
        ...item,
        observed_at: itemObservedAt,
        source: item.source || 'summary',
      };
    }
  }

  // 对 summary 缺失但有观测记录的桶
  for (const [bKey, rec] of bucketMap.entries()) {
    if (effective[bKey]) continue;

    let isExpired = false;
    if (rec.reset) {
      const resetMs = new Date(rec.reset).getTime();
      if (!Number.isNaN(resetMs) && resetMs <= now) isExpired = true;
    }

    if (isExpired) {
      effective[bKey] = {
        fraction: 1,
        reset: null,
        source: 'observed-reset',
        inferred: true,
        observed_at: rec.observed_at,
      };
    } else {
      effective[bKey] = {
        fraction: rec.fraction,
        reset: rec.reset,
        source: 'observed',
        inferred: false,
        observed_at: rec.observed_at,
      };
    }
  }

  return effective;
}

export function formatHHMM(ts) {
  if (!ts) return '';
  const d = (ts instanceof Date) ? ts : new Date(ts);
  if (Number.isNaN(d.getTime())) return '';
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  return `${hh}:${mm}`;
}

/** 从一个 quota 条目里抽取数值。支持三种形态，找不到返回 null */
export function extractFromEntry(entry) {
  if (!entry || typeof entry !== 'object') return null;
  // 形态 A: remainingFraction
  if (typeof entry.remainingFraction === 'number' && entry.remainingFraction >= 0) {
    return { fraction: entry.remainingFraction, reset: entry.resetTime || entry.reset_time || null, source: 'remainingFraction' };
  }
  // 缺 remainingFraction 但有 resetTime 时视为 0（Protobuf JSON 耗尽时省略 0）
  const reset = entry.resetTime || entry.reset_time || null;
  if (reset && (entry.remainingFraction === undefined || entry.remainingFraction === null)) {
    return { fraction: 0, reset, source: 'remainingFraction' };
  }
  // 形态 B: limit/usage
  const limit = entry.limit ?? entry.quotaLimit ?? entry.max;
  const usage = entry.usage ?? entry.consumed ?? entry.used;
  if (typeof limit === 'number' && limit > 0) {
    const u = typeof usage === 'number' ? usage : 0;
    return { fraction: Math.max(0, Math.min(1, 1 - u / limit)), reset, source: 'limit-usage' };
  }
  // 形态 C: remaining/total
  const total = entry.total ?? entry.quotaTotal;
  const remaining = entry.remaining ?? entry.remainingQuota;
  if (typeof total === 'number' && total > 0 && typeof remaining === 'number') {
    return { fraction: Math.max(0, Math.min(1, remaining / total)), reset, source: 'remaining-total' };
  }
  return null;
}

/** 判断一个 limit 条目属于周窗口还是短窗口 */
export function isWeeklyEntry(entry) {
  const text = JSON.stringify({
    name: entry?.name, type: entry?.type, window: entry?.window,
    period: entry?.period, interval: entry?.interval, id: entry?.id,
  }).toLowerCase();
  return /weekly|week|7d|seven/.test(text);
}

/** 收集一个模型条目下所有真实配额 */
export function collectModelQuotas(model, family) {
  const out = {
    [`${family}_5h`]: null,
    [`${family}_7d`]: null,
  };
  const consider = (entry, forcedWeekly) => {
    if (!entry) return;
    const r = extractFromEntry(entry);
    if (!r) return;
    let weekly = forcedWeekly ?? (entry && typeof entry === 'object' ? isWeeklyEntry(entry) : false);
    // 推算：短窗口最长 5 小时，若 resetTime 超过 6 小时，说明触发了周限额，按周窗口处理
    if (!weekly && hoursUntil(r.reset) > WEEKLY_THRESHOLD_HOURS) weekly = true;
    const key = `${family}_${weekly ? '7d' : '5h'}`;
    // 同桶多窗口取"最紧"的 (remaining 最小的)，防止高估
    if (!out[key] || r.fraction < out[key].fraction) out[key] = r;
  };

  consider(model.quotaInfo, false);
  consider(model.weeklyQuotaInfo, true);
  // limits / rateLimits / quota 数组形态
  for (const arrName of ['limits', 'rateLimits', 'quota']) {
    if (Array.isArray(model[arrName])) model[arrName].forEach(e => consider(e, null));
  }
  return out;
}

/** 将模型列表中的 quota 合并，忽略 chat_xxx、tab_xxx 等内部条目 */
export function mergeModelQuotas(models) {
  const merged = {
    gemini_5h: null, gemini_7d: null,
    claude_5h: null, claude_7d: null,
    argon_5h: null, argon_7d: null,
  };
  if (!models || typeof models !== 'object') return merged;

  const entries = Array.isArray(models) ? models.entries() : Object.entries(models);
  for (const [modelKey, model] of entries) {
    if (!model || typeof model !== 'object') continue;
    const name = String(model?.name || modelKey || '').toLowerCase();
    // 忽略 chat_xxx、tab_xxx 内部条目
    if (/^(chat_|tab_)/.test(name)) continue;

    let family = null;
    if (name.includes('argon')) family = 'argon';
    else if (/claude|gpt|3p/.test(name)) family = 'claude';
    else if (name.includes('gemini')) family = 'gemini';
    if (!family) continue;

    const found = collectModelQuotas(model, family);
    for (const key of Object.keys(merged)) {
      if (found[key]) {
        if (!merged[key] || found[key].fraction < merged[key].fraction) merged[key] = found[key];
      }
    }
  }
  return merged;
}

/** 解析 retrieveUserQuotaSummary 响应 */
export function parseSummary(body) {
  const d = body?.response || body || {};
  const out = {};
  const buckets = [];
  for (const g of d?.groups || []) {
    for (const b of g?.buckets || []) {
      buckets.push({ ...b, _group: String(g.displayName || '').toLowerCase() });
    }
  }
  for (const b of d?.buckets || []) {
    buckets.push(b);
  }
  for (const b of buckets) {
    const id = String(b.bucketId || b.bucket_id || '').toLowerCase();
    const groupName = String(b._group || '').toLowerCase();
    const combined = `${groupName} ${id}`;

    // 分组识别：组名/bucketId 含 argon → 'argon'；含 claude|gpt|3p → 'claude'；否则含 gemini 或其它 → 'gemini'
    let family = 'gemini';
    if (combined.includes('argon')) {
      family = 'argon';
    } else if (/claude|gpt|3p/.test(combined)) {
      family = 'claude';
    } else {
      family = 'gemini';
    }

    const win = String(b.window || id.split('-').pop() || '').toLowerCase();
    let per = /week|7d|168h|wk/.test(win) ? '7d' : /5h|five|300m/.test(win) ? '5h' : null;
    const reset = b.resetTime || b.reset_time || null;
    if (!per && reset) {
      const hrs = hoursUntil(reset);
      if (hrs > WEEKLY_THRESHOLD_HOURS) per = '7d';
      else if (hrs >= 0) per = '5h';
    }
    if (!per) continue;

    // 有 resetTime 但缺 remainingFraction 时视为 0
    let frac = b.remainingFraction ?? b.remaining_fraction ?? b.remaining?.remainingFraction;
    if (frac === undefined || frac === null) {
      if (reset) {
        frac = 0;
      }
    }
    if (typeof frac !== 'number') continue;

    const fraction = Math.max(0, Math.min(1, frac));
    const key = `${family}_${per}`;
    // 保留最紧配额，避免单端点缺失被空值覆盖
    if (!out[key] || (out[key].fraction !== null && fraction < out[key].fraction)) {
      out[key] = { fraction, reset, source: 'summary' };
    }
  }
  return out;
}

export function toPublic(r) {
  if (!r) return null;
  const observedAt = (typeof r.observed_at === 'number') ? r.observed_at : (r.observed_at ?? null);
  return {
    remaining_fraction: r.fraction,
    percentage: typeof r.fraction === 'number' ? Math.round(r.fraction * 100) : null,
    inferred: !r.inferred ? false : true,
    reset_time: r.reset || null,
    reset_text: parseResetTime(r.reset) || '',
    source: r.source || null,
    observed_at: observedAt,
  };
}

export const BUCKET_SPECS = [
  { key: 'gemini_5h', group: 'gemini', label: 'Gemini', window: '5h', core: true },
  { key: 'gemini_7d', group: 'gemini', label: 'Gemini', window: '7d', core: true },
  { key: 'claude_5h', group: 'claude', label: 'Claude / GPT', window: '5h', core: true },
  { key: 'claude_7d', group: 'claude', label: 'Claude / GPT', window: '7d', core: true },
  { key: 'argon_5h',  group: 'argon',  label: 'Argon', window: '5h', core: false },
  { key: 'argon_7d',  group: 'argon',  label: 'Argon', window: '7d', core: false },
];

/** 识别模型名称归属家族：'gemini' | 'claude' | 'argon' */
export function getModelFamily(name = '') {
  const m = String(name || '').toLowerCase();
  if (m.includes('argon')) return 'argon';
  if (/claude|gpt|3p/.test(m)) return 'claude';
  return 'gemini';
}

/** 提取指定家族的更小已知额度比例（取 5h 与 7d 的 min，单个已知取该值，均未知取 null） */
export function extractFamilyFraction(quotaObj, family) {
  if (!quotaObj || typeof quotaObj !== 'object') return null;
  const f5hObj = quotaObj[`${family}_5h`];
  const f7dObj = quotaObj[`${family}_7d`];
  const f5h = typeof f5hObj === 'number' ? f5hObj : (f5hObj?.remaining_fraction ?? f5hObj?.fraction ?? null);
  const f7d = typeof f7dObj === 'number' ? f7dObj : (f7dObj?.remaining_fraction ?? f7dObj?.fraction ?? null);

  const has5h = typeof f5h === 'number';
  const has7d = typeof f7d === 'number';
  if (has5h && has7d) return Math.min(f5h, f7d);
  if (has5h) return f5h;
  if (has7d) return f7d;
  return null;
}

/** 将完整 quota 结果汇总为三个家族的有效配额 (0~1 或 null) */
export function computeAccountQuotas(quotaData) {
  return {
    gemini: extractFamilyFraction(quotaData, 'gemini'),
    claude: extractFamilyFraction(quotaData, 'claude'),
    argon: extractFamilyFraction(quotaData, 'argon'),
  };
}

/** 构建动态 buckets 列表：Gemini/Claude 4个核心桶总是出现（没数据 missing:true），Argon 只在有数据时出现 */
export function buildBuckets(merged) {
  const safeMerged = (merged && typeof merged === 'object') ? merged : {};
  const buckets = [];

  for (const spec of BUCKET_SPECS) {
    const item = safeMerged[spec.key];
    const fraction = item?.remaining_fraction !== undefined ? item.remaining_fraction : item?.fraction;
    const hasData = typeof fraction === 'number';

    if (hasData) {
      const percentage = item.percentage !== undefined
        ? item.percentage
        : Math.round(fraction * 100);
      const resetTime = item.reset_time !== undefined ? item.reset_time : (item.reset || null);
      const resetText = item.reset_text !== undefined ? item.reset_text : (parseResetTime(resetTime) || '');
      const source = item.source || null;
      const inferred = Boolean(item.inferred);
      const observedAt = item.observed_at !== undefined ? item.observed_at : (item.observedAt ?? null);

      let note = item.note || undefined;
      if (source === 'observed') {
        note = observedAt ? `上次观测于 ${formatHHMM(observedAt)}` : '上次观测';
      } else if (source === 'observed-reset') {
        note = '已过重置时间，按满额估计';
      }

      const b = {
        group: spec.group,
        label: spec.label,
        window: spec.window,
        percentage,
        remaining_fraction: fraction,
        reset_time: resetTime,
        reset_text: resetText,
        source,
        observed_at: observedAt,
        inferred,
        missing: false,
      };
      if (note !== undefined) {
        b.note = note;
      }

      buckets.push(b);
    } else if (spec.core) {
      buckets.push({
        group: spec.group,
        label: spec.label,
        window: spec.window,
        percentage: null,
        remaining_fraction: null,
        reset_time: null,
        reset_text: '',
        source: null,
        observed_at: null,
        inferred: false,
        missing: true,
        note: spec.key === 'gemini_7d'
          ? '接口未返回（Pro 号通常没有 Gemini 周额度）'
          : '接口未返回',
      });
    }
  }

  return buckets;
}

/** 归一化订阅等级：ULTRA | PRO | FREE | null */
export function normalizeTier(id) {
  if (!id || typeof id !== 'string') return null;
  const s = id.toLowerCase();
  if (s.includes('ultra')) return 'ULTRA';
  if (s.includes('pro')) return 'PRO';
  if (s.includes('free') || s.includes('standard') || s.includes('legacy')) return 'FREE';
  return null;
}

const TIER_CACHE_TTL_MS = 6 * 60 * 60 * 1000;
export const tierCache = new Map(); // email -> { tier, expireAt }

export async function fetchSubscriptionTier(accessToken, email) {
  if (!accessToken) return null;
  if (email && tierCache.has(email)) {
    const cached = tierCache.get(email);
    if (cached && cached.expireAt > Date.now()) return cached.tier;
  }
  const bases = [
    'https://cloudcode-pa.googleapis.com',
    'https://daily-cloudcode-pa.googleapis.com',
  ];
  for (const base of bases) {
    try {
      const res = await fetch(`${base}/v1internal:loadCodeAssist`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
          'User-Agent': 'antigravity/4.3.0 linux/arm64',
        },
        body: JSON.stringify({ metadata: { ideType: 'ANTIGRAVITY' } }),
        signal: AbortSignal.timeout(10000),
      });
      if (!res.ok) continue;
      const d = await res.json();
      const body = d?.response || d;
      const rawId = body?.paidTier?.id || body?.currentTier?.id || body?.tier?.id || '';
      const tier = normalizeTier(rawId);
      if (email) {
        tierCache.set(email, { tier, expireAt: Date.now() + TIER_CACHE_TTL_MS });
      }
      return tier;
    } catch (e) {}
  }
  return null;
}

/** 官方 /usage 用的分组配额（含周额度）：groups[].buckets[] */
export async function fetchQuotaSummary(accessToken, project) {
  // 端点顺序：daily → prod → sandbox；拿到第一个 2xx 即返回
  const bases = [
    'https://daily-cloudcode-pa.googleapis.com',
    'https://cloudcode-pa.googleapis.com',
    'https://daily-cloudcode-pa.sandbox.googleapis.com',
  ];
  for (const base of bases) {
    try {
      const res = await fetch(`${base}/v1internal:retrieveUserQuotaSummary`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
          'User-Agent': 'antigravity/4.3.0 linux/arm64',
        },
        body: JSON.stringify(project ? { project } : {}),
        signal: AbortSignal.timeout(15000),
      });
      if (!res.ok) continue;
      const d = await res.json();
      const summary = parseSummary(d);
      return Object.keys(summary).length ? summary : null;
    } catch (e) {}
  }
  return null;
}

export async function fetchRealQuota(tokenManager) {
  if (!tokenManager || !tokenManager.tokenData?.refreshToken) {
    return {
      ok: false,
      message: '尚未配置 Google 账号',
      email: '未登录',
      tier: null,
      gemini_5h: null, gemini_7d: null,
      claude_5h: null, claude_7d: null,
      argon_5h: null, argon_7d: null,
      buckets: [],
      updated_time: new Date().toLocaleTimeString(),
    };
  }

  const accessToken = await tokenManager.getValidAccessToken();
  if (!accessToken) {
    return {
      ok: false,
      message: 'Google 凭据失效',
      email: tokenManager.tokenData.email,
      tier: null,
      gemini_5h: null, gemini_7d: null,
      claude_5h: null, claude_7d: null,
      argon_5h: null, argon_7d: null,
      buckets: [],
      updated_time: new Date().toLocaleTimeString(),
    };
  }

  try {
    const { CLOUDCODE_API_ENDPOINT, ANTIGRAVITY_ENDPOINT_DAILY } = await import('./constants.mjs');
    let project = tokenManager.tokenData.projectId || '';
    if (!project && typeof tokenManager.ensureProjectId === 'function') {
      project = await tokenManager.ensureProjectId().catch(() => '');
    }
    const validProj = (project && project !== 'pending_detection') ? project : '';

    // 先试 DAILY(配额字段更全)，失败回退 PROD
    const endpoints = [ANTIGRAVITY_ENDPOINT_DAILY, CLOUDCODE_API_ENDPOINT];
    let data = null;
    let lastErr = null;
    for (const base of endpoints) {
      try {
        const res = await fetch(`${base}/v1internal:fetchAvailableModels`, {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${accessToken}`,
            'Content-Type': 'application/json',
            'User-Agent': 'antigravity/4.3.0 linux/arm64',
          },
          body: JSON.stringify(validProj ? { project: validProj } : {}),
          signal: AbortSignal.timeout(15000),
        });
        if (res.ok) { data = await res.json(); break; }
        lastErr = new Error(`Google HTTP ${res.status}`);
      } catch (e) { lastErr = e; }
    }
    if (!data) throw lastErr || new Error('all quota endpoints unreachable');

    const models = data?.models || data || {};
    const merged = mergeModelQuotas(models);
    const email = tokenManager.tokenData.email || 'default';
    const now = Date.now();

    const hasModelsGemini5h = Boolean(merged.gemini_5h && typeof merged.gemini_5h.fraction === 'number');
    if (hasModelsGemini5h && merged.gemini_5h.observed_at === undefined) {
      merged.gemini_5h.observed_at = now;
    }

    // 周额度 / 5 小时额度以官方分组接口为准（fetchAvailableModels 不带周额度）
    let sum = null;
    try {
      sum = await fetchQuotaSummary(accessToken, validProj);
    } catch (e) {}

    const effectiveSummary = applyObservedFallback(email, sum || {}, now);
    for (const k of Object.keys(effectiveSummary)) {
      if (!effectiveSummary[k]) continue;
      if (k === 'gemini_5h' && hasModelsGemini5h) {
        // Gemini 5h 仍然优先用 fetchAvailableModels 的实时值（如果有）
        continue;
      }
      merged[k] = effectiveSummary[k];
    }

    // 订阅等级：异步非阻塞，失败不影响额度
    let tier = null;
    try {
      tier = await fetchSubscriptionTier(accessToken, email);
    } catch (e) {}

    const result = {
      ok: true,
      email: tokenManager.tokenData.email,
      tier,
      gemini_5h: toPublic(merged.gemini_5h),
      gemini_7d: toPublic(merged.gemini_7d),
      claude_5h: toPublic(merged.claude_5h),
      claude_7d: toPublic(merged.claude_7d),
      argon_5h: toPublic(merged.argon_5h),
      argon_7d: toPublic(merged.argon_7d),
      buckets: buildBuckets(merged),
      updated_unix: Math.floor(Date.now() / 1000),
      updated_time: new Date().toLocaleTimeString(),
    };
    // 老界面字段兼容 —— 无数据时传 null 而非 100
    result.five_hour = { percentage: result.gemini_5h?.percentage ?? null, reset_time: result.gemini_5h?.reset_time || null };
    result.claude_five_hour = { percentage: result.claude_5h?.percentage ?? null, reset_time: result.claude_5h?.reset_time || null };
    result.weekly = { percentage: result.gemini_7d?.percentage ?? null };
    return result;
  } catch (err) {
    console.error('[Quota Fetch Error]:', err.message);
    return {
      ok: false,
      message: err.message,
      email: tokenManager.tokenData.email,
      tier: null,
      gemini_5h: null, gemini_7d: null,
      claude_5h: null, claude_7d: null,
      argon_5h: null, argon_7d: null,
      buckets: [],
      five_hour: { percentage: null, reset_time: null },
      claude_five_hour: { percentage: null, reset_time: null },
      weekly: { percentage: null },
      updated_time: new Date().toLocaleTimeString(),
    };
  }
}
