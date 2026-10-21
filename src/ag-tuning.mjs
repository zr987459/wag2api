/**
 * fix/ttft：AG 引擎调优开关。
 *
 * 取值优先级：控制台设置（DATA_DIR/ag-tuning.json）> 环境变量 > 默认值。
 * 安卓上没法设环境变量，所以控制台可以覆盖；清空控制台里的值即回到环境变量 / 默认值。
 * 每次读取都是现取（不缓存），改完立即对下一个请求生效。
 */
import fs from 'fs';
import path from 'path';

export const TUNING_DEFS = {
  AG_ENDPOINTS: {
    def: 'daily,autopush,prod',
    doc: 'Cloud Code 集群顺序，逗号分隔：daily / autopush / prod 或完整 https URL。正式请求先走第 1 个，失败或首块超时换第 2 个',
    validate: v => parseEndpoints(v).length > 0,
  },
  AG_FIRST_CHUNK_FAILOVER_MS: {
    def: '0',
    doc: '流式请求在这么多毫秒内没收到响应头就中止并换下一个 host 重发（只换一次，不换号、不降级、不改 sessionId）。0 = 关闭',
    validate: v => /^\d+$/.test(String(v)),
  },
  AG_HOST_HEALTH: {
    def: '0',
    doc: 'host 健康度：某 host 最近 10 次等待头中位数（同体积档）持续 > 其他 host 2 倍时，新会话把它排到后面 10 分钟。1 = 开',
    validate: v => ['0', '1'].includes(String(v)),
  },
  AG_SAFETY_SETTINGS: {
    def: 'block_none',
    doc: 'safetySettings：block_none = 发送 5 条 BLOCK_NONE（原行为）；off = 不发送该字段（与官方 Antigravity 客户端一致）',
    validate: v => ['off', 'block_none'].includes(String(v)),
  },
};

const DEFAULT_FILE = () => path.join(process.env.DATA_DIR || process.cwd(), 'ag-tuning.json');
let file = null;
let overrides = {};

/** server 启动时调用；测试可传临时文件 */
export function loadTuning(filePath = DEFAULT_FILE()) {
  file = filePath;
  try { overrides = JSON.parse(fs.readFileSync(file, 'utf8')) || {}; } catch { overrides = {}; }
  for (const k of Object.keys(overrides)) if (!TUNING_DEFS[k]) delete overrides[k];
  return overrides;
}

export function tuning(name) {
  const d = TUNING_DEFS[name];
  if (!d) throw new Error('unknown tuning ' + name);
  if (overrides[name] !== undefined && overrides[name] !== '') return String(overrides[name]);
  const env = process.env[name];
  if (env !== undefined && env !== '' && (!d.validate || d.validate(env))) return String(env);
  return d.def;
}

export function tuningNumber(name) { const n = Number(tuning(name)); return Number.isFinite(n) ? n : Number(TUNING_DEFS[name].def); }

/** 控制台展示：值、来源、说明 */
export function describeTuning() {
  return Object.entries(TUNING_DEFS).map(([name, d]) => ({
    name, value: tuning(name), default: d.def, doc: d.doc,
    source: overrides[name] !== undefined && overrides[name] !== '' ? 'console' : (process.env[name] ? 'env' : 'default'),
    env: process.env[name] ?? null,
  }));
}

/** 控制台修改：value 为空串 / null = 清除覆盖。返回 { ok, error } */
export function setTuning(name, value) {
  const d = TUNING_DEFS[name];
  if (!d) return { ok: false, error: '未知开关 ' + name };
  if (value === null || value === undefined || value === '') delete overrides[name];
  else {
    const v = String(value).trim();
    if (d.validate && !d.validate(v)) return { ok: false, error: `${name} 取值无效：${v}` };
    overrides[name] = v;
  }
  if (file) {
    try { fs.writeFileSync(file, JSON.stringify(overrides, null, 2)); } catch (e) { return { ok: false, error: '保存失败：' + e.message }; }
  }
  return { ok: true };
}

// ---------- AG_ENDPOINTS ----------
const NAMED = {
  daily: 'https://daily-cloudcode-pa.sandbox.googleapis.com',
  autopush: 'https://autopush-cloudcode-pa.sandbox.googleapis.com',
  prod: 'https://cloudcode-pa.googleapis.com',
};

/** 'prod,daily, https://x.example.com/ ,bogus' → [prod URL, daily URL, 'https://x.example.com']；无效项忽略，去重 */
export function parseEndpoints(str) {
  const out = [];
  for (const raw of String(str ?? '').split(',')) {
    const t = raw.trim();
    if (!t) continue;
    let url = NAMED[t.toLowerCase()];
    if (!url) {
      try {
        const u = new URL(t);
        if (u.protocol !== 'https:' && u.protocol !== 'http:') continue;
        url = (u.origin + u.pathname).replace(/\/+$/, '');
      } catch { continue; }
    }
    if (!out.includes(url)) out.push(url);
  }
  return out;
}

export function configuredEndpoints() {
  const list = parseEndpoints(tuning('AG_ENDPOINTS'));
  return list.length ? list : parseEndpoints(TUNING_DEFS.AG_ENDPOINTS.def);
}
