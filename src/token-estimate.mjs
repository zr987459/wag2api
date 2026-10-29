/**
 * /v1/messages/count_tokens 本地估算（不消耗上游配额）
 *
 * 口径与 Antigravity-Manager 一致：ASCII 约 4 字符 / token，非 ASCII（中日韩等）约 2.2 字符 / token；
 * base64 图片按大小折算（< 5KB 记 258，否则 2000），其它 base64 媒体按长度 / 4。
 */

export function estimateTextTokens(s) {
  const text = String(s || '');
  if (!text) return 0;
  let ascii = 0, other = 0;
  for (const ch of text) {
    if (ch.charCodeAt(0) < 128) ascii++; else other++;
  }
  return Math.round(ascii / 4) + Math.round(other / 2.2);
}

function mediaTokens(mime, data) {
  const len = String(data || '').length;
  if (String(mime || '').startsWith('image/')) return (len * 3) / 4 < 5000 ? 258 : 2000;
  return Math.ceil(len / 4);
}

function blockTokens(b) {
  if (b == null) return 0;
  if (typeof b === 'string') return estimateTextTokens(b);
  switch (b.type) {
    case 'text': return estimateTextTokens(b.text);
    case 'thinking': return estimateTextTokens(b.thinking);
    case 'redacted_thinking': return 0;
    case 'image':
    case 'document':
      if (b.source?.type === 'base64') return mediaTokens(b.source.media_type, b.source.data);
      if (b.source?.type === 'text') return estimateTextTokens(b.source.data);
      return 0;
    case 'tool_use': return estimateTextTokens((b.name || '') + JSON.stringify(b.input || {}));
    case 'tool_result':
      if (Array.isArray(b.content)) return b.content.reduce((n, x) => n + blockTokens(x), 0);
      return estimateTextTokens(typeof b.content === 'string' ? b.content : JSON.stringify(b.content ?? ''));
    default: return estimateTextTokens(JSON.stringify(b));
  }
}

/** 估算 Anthropic Messages 请求体的输入 token 数 */
export function estimateAnthropicInputTokens(body) {
  const req = body && typeof body === 'object' ? body : {};
  let n = 0;
  if (typeof req.system === 'string') n += estimateTextTokens(req.system);
  else if (Array.isArray(req.system)) n += req.system.reduce((a, p) => a + estimateTextTokens(p?.text), 0);
  for (const m of Array.isArray(req.messages) ? req.messages : []) {
    if (typeof m?.content === 'string') n += estimateTextTokens(m.content);
    else if (Array.isArray(m?.content)) n += m.content.reduce((a, b) => a + blockTokens(b), 0);
    n += 3; // 每条消息的角色 / 分隔开销
  }
  if (Array.isArray(req.tools)) {
    for (const t of req.tools) n += estimateTextTokens((t?.name || '') + (t?.description || '') + JSON.stringify(t?.input_schema || {}));
  }
  return Math.max(1, n);
}
