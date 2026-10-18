/**
 * 历史锁定：部分客户端会在后续请求中改写旧的工具调用参数/工具结果（裁剪、去重、"[内容已清除]"）。
 * 这会让请求前缀与上游已缓存的版本不一致，导致隐式缓存从改写处整段失效。
 * 这里按 tool call id 记住第一次见到的内容，之后同一 id 一律按原样转发，保证前缀稳定。
 * 开启：环境变量 HISTORY_PIN=1（默认关闭）
 */
const ENABLED = process.env.HISTORY_PIN !== '0'; // 默认开启：锁定同一工具调用的原始输出，防止客户端截断导致前缀缓存击穿
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

  evict(now) {
    for (const [k, v] of this.map) {
      if (this.bytes <= MAX_BYTES && v.exp > now) break;
      this.map.delete(k); this.bytes -= entrySize(v);
    }
  }

  stats() { return { enabled: ENABLED, entries: this.map.size, bytes: this.bytes, restored: this.hits }; }
}

export const historyPin = new HistoryPin();
