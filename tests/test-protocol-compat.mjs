/**
 * OpenAI Chat Completions / Anthropic Messages 协议兼容修复回归：node tests/test-protocol-compat.mjs
 */
import assert from 'assert/strict';
import { EventEmitter } from 'events';
import { handleStreamConversion } from '../src/sse-streamer.mjs';
import { convertAnthropicToGoogle, convertGoogleToAnthropic } from '../src/content-converter.mjs';
import { openaiRequestToAnthropic, convertGoogleToOpenAI, handleOpenAIStreamConversion } from '../src/openai-ag-converter.mjs';
import { buildCloudCodePayload } from '../src/cloudcode.mjs';
import { sanitizeSchema } from '../src/schema-sanitizer.mjs';
import { estimateAnthropicInputTokens, estimateTextTokens } from '../src/token-estimate.mjs';

let passed = 0;
const ok = async (name, fn) => { await fn(); passed++; console.log('  ✓', name); };

function mockRes() {
  const r = new EventEmitter();
  r.out = ''; r.writableFinished = false;
  r.setHeader = () => {}; r.flushHeaders = () => {};
  r.write = s => { r.out += s; return true; };
  r.end = () => { r.writableFinished = true; };
  return r;
}
const enc = new TextEncoder();
const sse = obj => `data: ${JSON.stringify({ response: obj })}\n\n`;
const upstream = (chunks, { failAfter = false } = {}) => ({
  body: new ReadableStream({
    start(c) {
      for (const s of chunks) c.enqueue(enc.encode(s));
      if (failAfter) c.error(new Error('upstream reset'));
      else c.close();
    },
  }),
});
const aEvents = out => out.split('\n\n').filter(Boolean).map(b => ({ event: b.match(/^event: (.*)$/m)?.[1], data: JSON.parse(b.match(/^data: (.*)$/m)[1]) }));
const oChunks = out => out.split('\n\n').filter(b => b.startsWith('data: ') && !b.includes('[DONE]')).map(b => JSON.parse(b.slice(6)));

const tools = [{ name: 'get_weather', description: 'w', input_schema: { type: 'object', properties: { city: { type: 'string' } } } }];
const msgs = [{ role: 'user', content: 'hi' }];

console.log('Anthropic 流式');

await ok('多个 tool_use 块各自 content_block_stop，index 不复用', async () => {
  const res = mockRes();
  await handleStreamConversion(upstream([
    sse({ candidates: [{ content: { parts: [{ text: 'ok' }] } }] }),
    sse({ candidates: [{ content: { parts: [{ functionCall: { name: 'a', args: { x: 1 } } }, { functionCall: { name: 'b', args: {} } }] } }] }),
    sse({ candidates: [{ content: { parts: [{ text: 'after' }] }, finishReason: 'STOP' }] }),
  ]), res, 'm');
  const ev = aEvents(res.out);
  const starts = ev.filter(e => e.event === 'content_block_start').map(e => e.data.index);
  const stops = ev.filter(e => e.event === 'content_block_stop').map(e => e.data.index);
  assert.deepEqual(starts, [0, 1, 2, 3]);
  assert.deepEqual(stops, [0, 1, 2, 3]);
  // 每个块的 stop 都在下一个块的 start 之前
  let open = null;
  for (const e of ev) {
    if (e.event === 'content_block_start') { assert.equal(open, null, '上一个块未关闭就开始新块'); open = e.data.index; }
    if (e.event === 'content_block_stop') { assert.equal(e.data.index, open); open = null; }
  }
  assert.equal(ev.find(e => e.event === 'message_delta').data.delta.stop_reason, 'tool_use');
});

await ok('MAX_TOKENS → stop_reason=max_tokens（流式 / 非流式）', async () => {
  const res = mockRes();
  await handleStreamConversion(upstream([sse({ candidates: [{ content: { parts: [{ text: 'trunc' }] }, finishReason: 'MAX_TOKENS' }] })]), res, 'm');
  assert.equal(aEvents(res.out).find(e => e.event === 'message_delta').data.delta.stop_reason, 'max_tokens');
  const m = convertGoogleToAnthropic({ response: { candidates: [{ content: { parts: [{ text: 'x' }] }, finishReason: 'MAX_TOKENS' }] } }, 'm');
  assert.equal(m.stop_reason, 'max_tokens');
  const t = convertGoogleToAnthropic({ response: { candidates: [{ content: { parts: [{ functionCall: { name: 'a', args: {} } }] }, finishReason: 'MAX_TOKENS' }] } }, 'm');
  assert.equal(t.stop_reason, 'tool_use', '工具调用优先');
});

await ok('上游中途出错：下发标准 Anthropic error 事件', async () => {
  const res = mockRes();
  const orig = console.error; console.error = () => {};
  let fin = null;
  try {
    await handleStreamConversion(upstream([sse({ candidates: [{ content: { parts: [{ text: 'a' }] } }] })], { failAfter: true }), res, 'm', u => { fin = u; });
  } finally { console.error = orig; }
  const err = aEvents(res.out).find(e => e.event === 'error');
  assert.ok(err, '必须有 event: error');
  assert.equal(err.data.type, 'error');
  assert.equal(err.data.error.type, 'api_error');
  assert.equal(fin.outcome, 'stream_error');
});

console.log('Anthropic 请求');

await ok('tool_result 块数组：文本拼接、图片转 inlineData；document 块转 inlineData', () => {
  const g = convertAnthropicToGoogle({
    model: 'claude-sonnet-4-6',
    messages: [
      { role: 'user', content: [{ type: 'text', text: 'read' }, { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: 'JVBERi0x' } }] },
      { role: 'assistant', content: [{ type: 'tool_use', id: 'tu_arr_1', name: 'shot', input: {} }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu_arr_1', content: [{ type: 'text', text: 'line1' }, { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'iVBOR' } }, { type: 'text', text: 'line2' }] }] },
    ],
  });
  assert.deepEqual(g.contents[0].parts[1], { inlineData: { mimeType: 'application/pdf', data: 'JVBERi0x' } });
  const last = g.contents[2].parts;
  assert.equal(last[0].functionResponse.response.output, 'line1\nline2');
  assert.deepEqual(last[1], { inlineData: { mimeType: 'image/png', data: 'iVBOR' } });
  // 字符串 content 保持原样
  const s = convertAnthropicToGoogle({ model: 'claude-sonnet-4-6', messages: [
    { role: 'assistant', content: [{ type: 'tool_use', id: 'tu_s', name: 'f', input: {} }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu_s', content: 'plain' }] },
  ] });
  assert.equal(s.contents[2].parts[0].functionResponse.response.output, 'plain');
});

await ok('tool_choice → functionCallingConfig（none / any / tool；auto 保持默认）', () => {
  const p = tc => buildCloudCodePayload({ model: 'gemini-3.8-flash-high', messages: msgs, tools, tool_choice: tc }).request.toolConfig.functionCallingConfig;
  assert.deepEqual(p(undefined), { mode: 'AUTO' });
  assert.deepEqual(p({ type: 'auto' }), { mode: 'AUTO' });
  assert.deepEqual(p({ type: 'none' }), { mode: 'NONE' });
  assert.deepEqual(p({ type: 'any' }), { mode: 'ANY' });
  assert.deepEqual(p({ type: 'tool', name: 'get_weather' }), { allowedFunctionNames: ['get_weather'], mode: 'ANY' });
  const c = buildCloudCodePayload({ model: 'claude-sonnet-4-6', messages: msgs, tools }).request.toolConfig.functionCallingConfig;
  assert.deepEqual(c, { mode: 'VALIDATED' }, 'Claude 未指定 tool_choice 时保持 VALIDATED');
});

await ok('top_p / top_k / stop_sequences 下发；未传时 generationConfig 不变', () => {
  const g = buildCloudCodePayload({ model: 'gemini-3.8-flash-high', messages: msgs, top_p: 0.9, top_k: 40, stop_sequences: ['END', '', 'a', 'b', 'c', 'd', 'e'] }).request.generationConfig;
  assert.equal(g.topP, 0.9);
  assert.equal(g.topK, 40);
  assert.deepEqual(g.stopSequences, ['END', 'a', 'b', 'c', 'd']);
  const plain = buildCloudCodePayload({ model: 'gemini-3.8-flash-high', messages: msgs }).request.generationConfig;
  assert.deepEqual(Object.keys(plain).sort(), ['maxOutputTokens', 'temperature', 'thinkingConfig']);
  const claude = buildCloudCodePayload({ model: 'claude-sonnet-4-6', messages: msgs, stop_sequences: ['END'] }).request.generationConfig;
  assert.equal(claude.stopSequences, undefined, 'Claude-on-AG 不下发 stopSequences');
});

await ok('count_tokens 本地估算', () => {
  assert.equal(estimateTextTokens('abcdefgh'), 2);
  assert.equal(estimateTextTokens('你好你好'), 2);
  const n = estimateAnthropicInputTokens({ system: [{ type: 'text', text: 'x'.repeat(400) }], messages: [{ role: 'user', content: 'y'.repeat(40) }], tools });
  assert.ok(n > 110 && n < 160, String(n));
  assert.equal(estimateAnthropicInputTokens({}), 1);
});

console.log('OpenAI 请求');

await ok('response_format json_schema / json_object → responseMimeType + responseSchema（Claude 跳过）', () => {
  const rf = { type: 'json_schema', json_schema: { name: 'r', schema: { type: 'object', properties: { a: { type: 'integer' } }, required: ['a'] } } };
  const ant = openaiRequestToAnthropic({ model: 'gemini-3.8-flash-high', messages: msgs, response_format: rf });
  const g = buildCloudCodePayload(ant).request.generationConfig;
  assert.equal(g.responseMimeType, 'application/json');
  assert.deepEqual(g.responseSchema, { properties: { a: { type: 'INTEGER' } }, required: ['a'], type: 'OBJECT' });
  const j = buildCloudCodePayload(openaiRequestToAnthropic({ model: 'gemini-3.8-flash-high', messages: msgs, response_format: { type: 'json_object' } })).request.generationConfig;
  assert.equal(j.responseMimeType, 'application/json');
  assert.equal(j.responseSchema, undefined);
  const t = buildCloudCodePayload(openaiRequestToAnthropic({ model: 'gemini-3.8-flash-high', messages: msgs, response_format: { type: 'text' } })).request.generationConfig;
  assert.equal(t.responseMimeType, undefined);
  const c = buildCloudCodePayload(openaiRequestToAnthropic({ model: 'claude-sonnet-4-6', messages: msgs, response_format: rf })).request.generationConfig;
  assert.equal(c.responseMimeType, undefined);
});

await ok('stop / tool_choice(required / 函数 / 扁平写法) 真正生效', () => {
  const ant = openaiRequestToAnthropic({
    model: 'gemini-3.8-flash-high', messages: msgs, stop: 'STOP!',
    tools: [{ type: 'function', function: { name: 'f', parameters: { type: 'object', properties: { q: { type: 'string' } } } } }],
    tool_choice: { type: 'function', function: { name: 'f' } },
  });
  const r = buildCloudCodePayload(ant).request;
  assert.deepEqual(r.generationConfig.stopSequences, ['STOP!']);
  assert.deepEqual(r.toolConfig.functionCallingConfig, { allowedFunctionNames: ['f'], mode: 'ANY' });
  assert.deepEqual(openaiRequestToAnthropic({ model: 'm', messages: msgs, tools: [{ type: 'function', function: { name: 'f' } }], tool_choice: { type: 'function', name: 'f' } }).tool_choice, { type: 'tool', name: 'f' });
  const req = buildCloudCodePayload(openaiRequestToAnthropic({ model: 'gemini-3.8-flash-high', messages: msgs, tools: [{ type: 'function', function: { name: 'f' } }], tool_choice: 'required' })).request;
  assert.deepEqual(req.toolConfig.functionCallingConfig, { mode: 'ANY' });
});

await ok('reasoning_effort：none 不开思考，minimal 落 low 档', () => {
  assert.equal(openaiRequestToAnthropic({ model: 'm', messages: msgs, reasoning_effort: 'none' }).thinking, undefined);
  const mi = openaiRequestToAnthropic({ model: 'gemini-3.8-flash', messages: msgs, reasoning_effort: 'minimal' });
  assert.equal(mi.thinking.budget_tokens, 1024);
  assert.equal(buildCloudCodePayload(mi).request.generationConfig.thinkingConfig.thinkingLevel, 'low');
  assert.equal(openaiRequestToAnthropic({ model: 'm', messages: msgs, reasoning_effort: 'medium' }).thinking.budget_tokens, 8192);
});

await ok('tool 消息分段 content 拼接；data URI 带参数；file 块 → document → inlineData', () => {
  const ant = openaiRequestToAnthropic({
    model: 'gemini-3.8-flash-high',
    messages: [
      { role: 'user', content: [
        { type: 'text', text: 'see' },
        { type: 'image_url', image_url: { url: 'data:image/png;name=a.png;base64,iVBOR' } },
        { type: 'file', file: { filename: 'a.pdf', file_data: 'data:application/pdf;base64,JVBERi0x' } },
      ] },
      { role: 'assistant', content: null, tool_calls: [{ id: 'call_seg', type: 'function', function: { name: 'f', arguments: '{}' } }] },
      { role: 'tool', tool_call_id: 'call_seg', content: [{ type: 'text', text: 'r1' }, { type: 'text', text: 'r2' }] },
    ],
  });
  assert.deepEqual(ant.messages[0].content[1], { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'iVBOR' } });
  assert.equal(ant.messages[0].content[2].type, 'document');
  assert.equal(ant.messages[2].content[0].content, 'r1\nr2');
  const g = convertAnthropicToGoogle(ant);
  assert.deepEqual(g.contents[0].parts[2], { inlineData: { mimeType: 'application/pdf', data: 'JVBERi0x' } });
});

console.log('OpenAI 响应');

const usageMeta = { promptTokenCount: 100, cachedContentTokenCount: 40, candidatesTokenCount: 10, thoughtsTokenCount: 5 };

await ok('usage：completion_tokens 不重复计算 reasoning_tokens', () => {
  const r = convertGoogleToOpenAI({ response: { candidates: [{ content: { parts: [{ text: 'x' }] }, finishReason: 'STOP' }], usageMetadata: usageMeta } }, 'm');
  assert.deepEqual(r.usage, {
    prompt_tokens: 100, completion_tokens: 15, total_tokens: 115,
    prompt_tokens_details: { cached_tokens: 40 }, completion_tokens_details: { reasoning_tokens: 5 },
  });
});

await ok('SAFETY / RECITATION → finish_reason=content_filter（流式 / 非流式）', async () => {
  const r = convertGoogleToOpenAI({ response: { candidates: [{ content: { parts: [{ text: 'x' }] }, finishReason: 'SAFETY' }] } }, 'm');
  assert.equal(r.choices[0].finish_reason, 'content_filter');
  const res = mockRes();
  await handleOpenAIStreamConversion(upstream([sse({ candidates: [{ content: { parts: [{ text: 'x' }] }, finishReason: 'RECITATION' }] })]), res, 'm');
  assert.ok(oChunks(res.out).some(c => c.choices[0]?.finish_reason === 'content_filter'));
});

await ok('stream_options.include_usage：true 单独 usage 帧；未要求时 usage 挂在 finish 帧且无空 choices 帧', async () => {
  const chunks = [sse({ candidates: [{ content: { parts: [{ text: 'hi' }] }, finishReason: 'STOP' }], usageMetadata: usageMeta })];
  const a = mockRes();
  await handleOpenAIStreamConversion(upstream(chunks), a, 'm', null, Date.now(), { includeUsage: true });
  const ca = oChunks(a.out);
  const u = ca.find(c => Array.isArray(c.choices) && c.choices.length === 0);
  assert.equal(u.usage.completion_tokens, 15);
  assert.ok(a.out.trim().endsWith('data: [DONE]'));
  const b = mockRes();
  await handleOpenAIStreamConversion(upstream(chunks), b, 'm', null, Date.now(), { includeUsage: false });
  const cb = oChunks(b.out);
  assert.ok(cb.every(c => c.choices.length === 1), '不应出现 choices:[] 帧');
  const fin = cb.find(c => c.choices[0].finish_reason === 'stop');
  assert.equal(fin.usage.total_tokens, 115);
  assert.equal(cb[0].choices[0].delta.role, 'assistant', '首帧为 role');
  assert.ok(b.out.trim().endsWith('data: [DONE]'));
});

console.log('Schema 清洗');

await ok('anyOf / type 数组 / $ref / allOf 展开（不再退化为 _empty OBJECT）', () => {
  const s = sanitizeSchema({
    type: 'object',
    $defs: { Loc: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] }, Node: { type: 'object', properties: { next: { $ref: '#/$defs/Node' } } } },
    properties: {
      name: { anyOf: [{ type: 'string' }, { type: 'null' }], description: 'opt' },
      age: { type: ['integer', 'null'] },
      loc: { $ref: '#/$defs/Loc' },
      both: { allOf: [{ type: 'object', properties: { a: { type: 'string' } } }, { properties: { b: { type: 'number' } }, required: ['b'] }] },
      tree: { $ref: '#/$defs/Node' },
      bad: { $ref: '#/$defs/Missing' },
    },
  });
  assert.deepEqual(s.properties.name, { type: 'STRING', description: 'opt' });
  assert.deepEqual(s.properties.age, { type: 'INTEGER' });
  assert.deepEqual(s.properties.loc, { type: 'OBJECT', properties: { city: { type: 'STRING' } }, required: ['city'] });
  assert.equal(s.properties.both.type, 'OBJECT');
  assert.deepEqual(Object.keys(s.properties.both.properties), ['a', 'b']);
  assert.deepEqual(s.properties.both.required, ['b']);
  assert.equal(s.properties.tree.properties.next.type, 'OBJECT', '循环引用降级为 object，不爆栈');
  assert.equal(s.properties.bad.type, 'STRING');
  // 普通 schema 输出保持不变（保护工具声明的前缀缓存）
  const plain = { type: 'object', properties: { q: { type: 'string', description: 'd', format: 'uri' }, n: { type: 'array', items: { type: 'number' } } }, required: ['q'] };
  assert.deepEqual(sanitizeSchema(plain), { type: 'OBJECT', properties: { n: { type: 'ARRAY', items: { type: 'NUMBER' } }, q: { type: 'STRING', description: 'd' } }, required: ['q'] });
});

console.log(`protocol-compat: ${passed} passed`);
