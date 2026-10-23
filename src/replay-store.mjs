/**
 * fix/ttft：长上下文回放测速用的「最近一次正式 AG 请求」。
 *
 *  - 只存内存，只存一份（新请求覆盖旧的），不落盘、不进日志、不出现在任何 API 返回里（只返回元信息）。
 *  - 存的是已经序列化好的请求体字符串，零额外 CPU；回放时再 parse。
 */
let last = null; // { body, email, model, bytes, at }

export function rememberPayload(bodyStr, { email = '', model = '' } = {}) {
  if (typeof bodyStr !== 'string' || !bodyStr) return;
  last = { body: bodyStr, email, model, bytes: Buffer.byteLength(bodyStr), at: Date.now() };
}

/** 回放用：返回一份独立的 payload 对象（每次 parse，互不影响） */
export function takePayload() {
  if (!last) return null;
  return { payload: JSON.parse(last.body), email: last.email, model: last.model };
}

/** 只给元信息，绝不含请求内容 */
export function replayInfo(now = Date.now()) {
  if (!last) return { available: false };
  return { available: true, email: last.email, model: last.model, body_bytes: last.bytes, est_input_tokens: Math.round(last.bytes / 4), age_s: Math.round((now - last.at) / 1000) };
}

export function clearReplay() { last = null; }
