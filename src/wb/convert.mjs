/**
 * WB 引擎格式转换（翻译自 AnthropicToOpenAI.kt）：
 *   - convertRequest：Anthropic Messages 请求 → OpenAI Chat 请求
 *   - convertResponse：OpenAI 非流式响应 → Anthropic 响应
 *   - AnthropicStreamTranslator：OpenAI SSE chunk → Anthropic SSE 事件
 *   - conversationId：稳定的 X-Conversation-ID（与 Kotlin ConversationIds 逐字节一致）
 */
import crypto from 'crypto';

const str = (o, k) => (o && o[k] !== undefined && o[k] !== null ? String(o[k]) : '');
const isObj = v => v !== null && typeof v === 'object' && !Array.isArray(v);
export const newId = prefix => prefix + crypto.randomUUID().replace(/-/g, '').slice(0, 24);

export function systemText(sys) {
  if (typeof sys === 'string') return sys.trim() ? sys : null;
  if (Array.isArray(sys)) {
    const t = sys.filter(b => isObj(b) && b.type === 'text').map(b => str(b, 'text')).join('\n');
    return t.trim() ? t : null;
  }
  return null;
}

export function parseArgs(s) {
  if (!s || !String(s).trim()) return {};
  try {
    const v = JSON.parse(s);
    return isObj(v) ? v : { _raw: s };
  } catch (e) {
    return { _raw: s };
  }
}

export function mapFinish(r, hasTools) {
  if (r === 'tool_calls' || r === 'function_call') return 'tool_use';
  if (r === 'length') return 'max_tokens';
  return hasTools ? 'tool_use' : 'end_turn';
}

function imagePart(b) {
  const s = b.source;
  if (!isObj(s)) return null;
  let url;
  if (s.type === 'base64') url = `data:${str(s, 'media_type')};base64,${str(s, 'data')}`;
  else if (s.type === 'url') url = str(s, 'url');
  else return null;
  return { type: 'image_url', image_url: { url } };
}

function convertAssistant(content) {
  const msg = { role: 'assistant' };
  if (typeof content === 'string') return { ...msg, content };
  if (!Array.isArray(content)) return { ...msg, content: '' };
  let text = '', reasoning = '';
  const calls = [];
  for (const b of content) {
    if (!isObj(b)) continue;
    if (b.type === 'text') text += str(b, 'text');
    else if (b.type === 'thinking') reasoning += str(b, 'thinking');
    else if (b.type === 'tool_use') {
      calls.push({ id: b.id, type: 'function', function: { name: b.name, arguments: JSON.stringify(isObj(b.input) ? b.input : {}) } });
    }
  }
  if (reasoning) msg.reasoning_content = reasoning;
  if (calls.length) {
    msg.content = text ? text : null;
    msg.tool_calls = calls;
  } else {
    msg.content = text;
  }
  return msg;
}

function flattenToolResult(c) {
  if (typeof c === 'string') return [c, []];
  if (Array.isArray(c)) {
    const texts = [], imgs = [];
    for (const b of c) {
      if (!isObj(b)) continue;
      if (b.type === 'text') texts.push(str(b, 'text'));
      else if (b.type === 'image') { const p = imagePart(b); if (p) imgs.push(p); }
    }
    return [texts.join('\n'), imgs];
  }
  return ['', []];
}

function simplify(parts) {
  return parts.every(p => p.type === 'text') ? parts.map(p => str(p, 'text')).join('\n') : parts;
}

function convertUser(content) {
  if (typeof content === 'string') return [{ role: 'user', content }];
  if (!Array.isArray(content)) return [{ role: 'user', content: '' }];
  const toolMsgs = [], parts = [];
  for (const b of content) {
    if (!isObj(b)) continue;
    if (b.type === 'tool_result') {
      const [text, images] = flattenToolResult(b.content);
      const body = b.is_error ? `[tool error] ${text}` : text;
      toolMsgs.push({ role: 'tool', tool_call_id: b.tool_use_id, content: body || '(empty)' });
      parts.push(...images); // tool 消息只能放文本，图片挪到随后的 user 消息
    } else if (b.type === 'text') parts.push({ type: 'text', text: str(b, 'text') });
    else if (b.type === 'image') { const p = imagePart(b); if (p) parts.push(p); }
  }
  const result = [...toolMsgs];
  if (parts.length) result.push({ role: 'user', content: simplify(parts) });
  return result;
}

/** 每个 tool_call_id 都必须有且只有一条 tool 回复且紧跟其后；孤立的 tool 消息丢弃 */
export function repairToolPairing(msgs) {
  const out = [];
  let i = 0;
  while (i < msgs.length) {
    const rawM = msgs[i++];
    if (!rawM || typeof rawM !== 'object') continue;
    const m = { ...rawM };
    // 兼容部分旧客户端使用的 role: 'function'
    if (m.role === 'function') {
      m.role = 'tool';
      if (!m.tool_call_id && m.name) m.tool_call_id = m.name;
    }
    if (m.role === 'tool') continue;
    out.push(m);
    if (!Array.isArray(m.tool_calls)) continue;
    const pending = new Set(m.tool_calls.map(c => c.id));
    while (i < msgs.length && (msgs[i].role === 'tool' || msgs[i].role === 'function')) {
      const rawT = msgs[i++];
      const t = { ...rawT };
      if (t.role === 'function') {
        t.role = 'tool';
        if (!t.tool_call_id && t.name) t.tool_call_id = t.name;
      }
      if (pending.delete(t.tool_call_id)) out.push(t);
    }
    for (const id of pending) out.push({ role: 'tool', tool_call_id: id, content: '[no result: tool call was interrupted]' });
  }
  return out;
}

function convertTools(tools) {
  const out = [];
  for (const t of tools) {
    if (!isObj(t) || !isObj(t.input_schema)) continue; // 服务端内置工具无 schema，跳过
    out.push({ type: 'function', function: { name: t.name, description: str(t, 'description'), parameters: t.input_schema } });
  }
  return out;
}

function convertToolChoice(tc) {
  switch (tc.type) {
    case 'auto': return 'auto';
    case 'any': return 'required';
    case 'none': return 'none';
    case 'tool': return { type: 'function', function: { name: tc.name } };
    default: return null;
  }
}

export function convertRequest(req) {
  const out = { model: str(req, 'model') };
  if (req.max_tokens !== undefined && req.max_tokens !== null) out.max_tokens = parseInt(req.max_tokens, 10);
  for (const k of ['temperature', 'top_p']) if (req[k] !== undefined && req[k] !== null) out[k] = req[k];
  if (Array.isArray(req.stop_sequences)) out.stop = req.stop_sequences;
  if (req.stream === true) {
    out.stream = true;
    out.stream_options = { include_usage: true };
  }
  const msgs = [];
  const sys = systemText(req.system);
  if (sys) msgs.push({ role: 'system', content: sys });
  for (const m of Array.isArray(req.messages) ? req.messages : []) {
    if (!isObj(m)) continue;
    if (m.role === 'assistant') msgs.push(convertAssistant(m.content));
    else if (m.role === 'user') msgs.push(...convertUser(m.content));
  }
  out.messages = repairToolPairing(msgs);
  const tools = Array.isArray(req.tools) ? convertTools(req.tools) : null;
  if (tools && tools.length) {
    out.tools = tools;
    if (isObj(req.tool_choice)) {
      const c = convertToolChoice(req.tool_choice);
      if (c) out.tool_choice = c;
      if (req.tool_choice.disable_parallel_tool_use) out.parallel_tool_calls = false;
    }
  }
  return out;
}

export function convertResponse(resp, model) {
  const choice = resp.choices[0];
  const msg = choice.message || {};
  const content = [];
  const text = str(msg, 'content');
  if (text) content.push({ type: 'text', text });
  const calls = Array.isArray(msg.tool_calls) ? msg.tool_calls : null;
  if (calls) for (const c of calls) {
    const f = c.function || {};
    content.push({ type: 'tool_use', id: str(c, 'id') || newId('toolu_'), name: str(f, 'name'), input: parseArgs(str(f, 'arguments')) });
  }
  const u = resp.usage || {};
  return {
    id: newId('msg_'), type: 'message', role: 'assistant', model,
    content,
    stop_reason: mapFinish(str(choice, 'finish_reason'), (calls ? calls.length : 0) > 0),
    stop_sequence: null,
    usage: { input_tokens: u.prompt_tokens || 0, output_tokens: u.completion_tokens || 0 },
  };
}

export class AnthropicStreamTranslator {
  constructor(model, emit) {
    this.model = model;
    this.emit = emit;
    this.started = false;
    this.textIndex = -1;
    this.thinkIndex = -1;
    this.thinkOpen = false;
    this.nextIndex = 0;
    this.tools = new Map(); // index -> {id,name,args}
    this.finishReason = '';
    this.inTok = 0;
    this.outTok = 0;
  }

  closeThinking() {
    if (!this.thinkOpen) return;
    this.thinkOpen = false;
    this.emit('content_block_delta', { type: 'content_block_delta', index: this.thinkIndex, delta: { type: 'signature_delta', signature: '' } });
    this.emit('content_block_stop', { type: 'content_block_stop', index: this.thinkIndex });
  }

  onChunk(chunk) {
    if (!this.started) {
      this.started = true;
      this.emit('message_start', {
        type: 'message_start',
        message: { id: newId('msg_'), type: 'message', role: 'assistant', model: this.model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 20, output_tokens: 0 } },
      });
    }
    if (isObj(chunk.usage)) {
      if (Number.isFinite(chunk.usage.prompt_tokens)) this.inTok = chunk.usage.prompt_tokens;
      if (Number.isFinite(chunk.usage.completion_tokens)) this.outTok = chunk.usage.completion_tokens;
    }
    const choice = Array.isArray(chunk.choices) ? chunk.choices[0] : null;
    if (!isObj(choice)) return;
    const d = choice.delta;
    if (isObj(d)) {
      const reasoning = str(d, 'reasoning_content');
      if (reasoning) {
        if (this.thinkIndex < 0) {
          this.thinkIndex = this.nextIndex++;
          this.thinkOpen = true;
          this.emit('content_block_start', { type: 'content_block_start', index: this.thinkIndex, content_block: { type: 'thinking', thinking: '' } });
        }
        this.emit('content_block_delta', { type: 'content_block_delta', index: this.thinkIndex, delta: { type: 'thinking_delta', thinking: reasoning } });
      }
      const text = str(d, 'content');
      if (text) {
        this.closeThinking();
        if (this.textIndex < 0) {
          this.textIndex = this.nextIndex++;
          this.emit('content_block_start', { type: 'content_block_start', index: this.textIndex, content_block: { type: 'text', text: '' } });
        }
        this.emit('content_block_delta', { type: 'content_block_delta', index: this.textIndex, delta: { type: 'text_delta', text } });
      }
      if (Array.isArray(d.tool_calls)) d.tool_calls.forEach((c, k) => {
        if (!isObj(c)) return;
        const idx = Number.isInteger(c.index) ? c.index : k;
        if (!this.tools.has(idx)) this.tools.set(idx, { id: '', name: '', args: '' });
        const buf = this.tools.get(idx);
        if (str(c, 'id')) buf.id = str(c, 'id');
        if (isObj(c.function)) {
          if (str(c.function, 'name')) buf.name = str(c.function, 'name');
          buf.args += str(c.function, 'arguments');
        }
      });
    }
    if (str(choice, 'finish_reason')) this.finishReason = str(choice, 'finish_reason');
  }

  abort(err) {
    this.closeThinking();
    if (this.textIndex >= 0) {
      this.emit('content_block_stop', { type: 'content_block_stop', index: this.textIndex });
      this.textIndex = -1;
    }
    this.emit('error', { type: 'error', error: isObj(err.error) ? err.error : err });
  }

  finish() {
    if (!this.started) this.onChunk({});
    this.closeThinking();
    if (this.textIndex >= 0) this.emit('content_block_stop', { type: 'content_block_stop', index: this.textIndex });
    const sorted = [...this.tools.entries()].sort((a, b) => a[0] - b[0]).map(e => e[1]);
    for (const t of sorted) {
      const idx = this.nextIndex++;
      this.emit('content_block_start', { type: 'content_block_start', index: idx, content_block: { type: 'tool_use', id: t.id || newId('toolu_'), name: t.name, input: {} } });
      this.emit('content_block_delta', { type: 'content_block_delta', index: idx, delta: { type: 'input_json_delta', partial_json: JSON.stringify(parseArgs(t.args)) } });
      this.emit('content_block_stop', { type: 'content_block_stop', index: idx });
    }
    this.emit('message_delta', {
      type: 'message_delta',
      delta: { stop_reason: mapFinish(this.finishReason, sorted.length > 0), stop_sequence: null },
      usage: { input_tokens: this.inTok, output_tokens: Math.max(this.outTok, 1) },
    });
    this.emit('message_stop', { type: 'message_stop' });
  }
}

/** Java UUID.nameUUIDFromBytes（MD5 + v3），去掉横线 */
export function uuidOf(s) {
  const h = crypto.createHash('md5').update(Buffer.from(s, 'utf-8')).digest();
  h[6] = (h[6] & 0x0f) | 0x30;
  h[8] = (h[8] & 0x3f) | 0x80;
  return h.toString('hex');
}

export function conversationId(headers, req) {
  const hv = headers['x-conversation-id'];
  if (hv && String(hv).trim()) return String(hv);
  const uid = isObj(req.metadata) ? str(req.metadata, 'user_id') : '';
  if (uid.trim()) return uuidOf(`meta:${uid}`);
  const msgs = Array.isArray(req.messages) ? req.messages : [];
  let sys = systemText(req.system);
  if (sys === null) {
    const first = msgs[0];
    sys = isObj(first) && first.role === 'system' ? str(first, 'content') : null;
  }
  const firstUser = msgs.find(m => isObj(m) && m.role === 'user');
  let firstText = '';
  if (firstUser) {
    const c = firstUser.content;
    if (typeof c === 'string') firstText = c;
    else if (Array.isArray(c)) firstText = c.filter(b => isObj(b) && b.type === 'text').map(b => str(b, 'text')).join('\n');
  }
  return uuidOf('conv:' + (sys || '') + '\u0000' + firstText);
}
