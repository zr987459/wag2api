/**
 * 历史锁定：部分客户端会在后续请求中改写旧的工具调用参数/工具结果（裁剪、去重、"[内容已清除]"）。
 * 这会让请求前缀与上游已缓存的版本不一致，导致隐式缓存从改写处整段失效。
 * 这里按 tool call id 记住第一次见到的内容，之后同一 id 一律按原样转发，保证前缀稳定。
 * 默认开启，HISTORY_PIN=0 关闭。
 *
 * 安全约束（v1.3.4，修复跨会话串台）：
 *  - 只在客户端带了真实会话 id 时启用（content-converter 负责判断）；按首条消息哈希推出来的 conv 不可靠，
 *    固定前缀的客户端会让不同对话撞到同一个 key。
 *  - 模型回复 / 首条提示 / 系统提示 / 工具声明用 pinIf：只有"同一内容的轻微改写"才还原，内容不同就覆盖旧记录，
 *    绝不把别的对话的内容塞进当前请求。
 */
const ENABLED = process.env.HISTORY_PIN !== '0';
const TTL_MS = 6 * 60 * 60 * 1000;
const MAX_BYTES = 150 * 1024 * 1024;

function entrySize(e) {
  if (e.str !== undefined) return e.str.length;
  return e.json.length * (e.obj === undefined ? 1 : 2);
}

function deepFreeze(o) {
  if (o && typeof o === 'object' && !Object.isFrozen(o)) {
    Object.freeze(o);
    for (const k of Object.keys(o)) deepFreeze(o[k]);
  }
  return o;
}

class HistoryPin {
  constructor() { this.map = new Map(); this.bytes = 0; this.hits = 0; this.active = true; }

  /**
   * PR5：命中时不再每次 JSON.parse 一份副本。
   *  - 字符串（工具结果、首条提示词、系统提示词，占了绝大部分字节）直接存原串、直接比较、直接返回；
   *  - 对象（工具参数、模型 parts、工具声明）首次命中时解析一次并深度冻结，之后返回同一个冻结对象。
   *    convert 之后的 canonicalize 会生成新对象，下游不会改写它；冻结只是保险。
   * 返回内容与原实现逐字节一致。
   */
  pin(key, value) {
    if (!ENABLED || !this.active || !key) return value;
    const now = Date.now();
    const old = this.map.get(key);
    if (old && old.exp > now) {
      old.exp = now + TTL_MS;
      if (old.str !== undefined) {
        if (typeof value !== 'string' || value !== old.str) this.hits++;
        return old.str;
      }
      if (old.json !== JSON.stringify(value)) this.hits++;
      if (old.obj === undefined) {
        old.obj = deepFreeze(JSON.parse(old.json));
        this.bytes += old.json.length; // 解析后的对象另占内存，按同等大小计入上限
      }
      return old.obj;
    }
    if (old) this.bytes -= entrySize(old);
    this.map.delete(key);
    const entry = typeof value === 'string' ? { str: value, exp: now + TTL_MS } : { json: JSON.stringify(value), exp: now + TTL_MS };
    this.map.set(key, entry);
    this.bytes += entrySize(entry);
    this.evict(now);
    return value;
  }

  /**
   * 带校验的锁定：命中且 same(旧值, 新值) 为真才返回旧值；否则用新值覆盖旧记录并原样返回新值。
   */
  pinIf(key, value, same) {
    if (!ENABLED || !this.active || !key) return value;
    const now = Date.now();
    const old = this.map.get(key);
    if (old && old.exp > now) {
      let prev;
      if (old.str !== undefined) prev = old.str;
      else {
        if (old.obj === undefined) { old.obj = deepFreeze(JSON.parse(old.json)); this.bytes += old.json.length; }
        prev = old.obj;
      }
      let keep = false;
      try { keep = Boolean(same(prev, value)); } catch (e) { keep = false; }
      if (keep) {
        old.exp = now + TTL_MS;
        if (old.str !== undefined ? prev !== value : old.json !== JSON.stringify(value)) this.hits++;
        return prev;
      }
      this.bytes -= entrySize(old);
      this.map.delete(key);
      this.overwrites = (this.overwrites || 0) + 1;
    }
    return this.pin(key, value);
  }

  evict(now) {
    for (const [k, v] of this.map) {
      if (this.bytes <= MAX_BYTES && v.exp > now) break;
      this.map.delete(k); this.bytes -= entrySize(v);
    }
  }

  stats() { return { enabled: ENABLED, entries: this.map.size, bytes: this.bytes, restored: this.hits, overwritten: this.overwrites || 0 }; }
}

export const historyPin = new HistoryPin();

// ---- 校验函数 ----
const norm = t => String(t ?? '').replace(/\r\n/g, '\n').replace(/\s+/g, ' ').trim();

/** 文本近似相同：归一化空白后相等，或公共前缀 + 公共后缀覆盖较长串的 90% 以上（如只改了时间戳/环境信息）。 */
export function nearSameText(a, b) {
  const x = norm(a), y = norm(b);
  if (x === y) return true;
  const max = Math.max(x.length, y.length);
  if (!max) return true;
  if (Math.min(x.length, y.length) / max < 0.9) return false;
  let p = 0; while (p < x.length && p < y.length && x[p] === y[p]) p++;
  let s = 0; while (s < x.length - p && s < y.length - p && x[x.length - 1 - s] === y[y.length - 1 - s]) s++;
  return (p + s) / max >= 0.9;
}

/** 模型回复可见内容（剔除 thought 与签名）一致：只允许还原被客户端剥掉/降级的思考块与签名。 */
export function sameVisibleParts(a, b) {
  const vis = ps => (Array.isArray(ps) ? ps : []).filter(p => p && !p.thought).map(p =>
    p.functionCall ? 'fc:' + JSON.stringify([p.functionCall.name, p.functionCall.args ?? {}])
      : p.functionResponse ? 'fr:' + p.functionResponse.name
      : p.inlineData ? 'img:' + String(p.inlineData.data || '').length
      : norm(p.text)).filter(Boolean).join('\n');
  return vis(a) === vis(b);
}

/** 工具声明：工具名集合相同才还原（只吸收描述/参数的微调）。 */
export function sameToolNames(a, b) {
  const names = fs => (Array.isArray(fs) ? fs : []).map(f => f?.name || '').sort().join(',');
  return names(a) === names(b);
}

/** 工具结果：仅当新内容像是被裁剪/清除时才还原。 */
export function looksTrimmed(prev, cur) {
  if (typeof prev !== 'string' || typeof cur !== 'string') return false;
  if (cur === prev) return true;
  if (cur.length < prev.length) return true;
  return cur.length <= 200 && /清除|省略|截断|已移除|truncat|omit|clear|remov|elided/i.test(cur);
}
