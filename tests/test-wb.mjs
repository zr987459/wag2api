/**
 * WB 引擎（Node 版）单元 + 集成测试：node tests/test-wb.mjs
 * 不连真实上游：fetch 用桩替换；HTTP 集成用临时 DATA_DIR 起真实 server.mjs。
 */
import assert from 'assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import http from 'http';
import { spawn } from 'child_process';
import { fileURLToPath } from 'url';
import { convertRequest, convertResponse, AnthropicStreamTranslator, uuidOf, conversationId, repairToolPairing } from '../src/wb/convert.mjs';
import { decide, mergedModels } from '../src/wb/router.mjs';
import { AccountVault } from '../src/wb/vault.mjs';
import { AccountScheduler } from '../src/wb/scheduler.mjs';
import { Settings } from '../src/wb/store.mjs';
import { GatewayMetrics, usageFromOpenAi } from '../src/wb/metrics.mjs';
import { TencentGateway, UpstreamError, resolveModel, buildUpstreamPayload } from '../src/wb/gateway.mjs';
import { createWbEngine, errorPayload } from '../src/wb/index.mjs';
import { wbModels } from '../src/wb/constants.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const quiet = { log() {}, warn() {}, error() {} };
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'wb-test-'));
let passed = 0;
const tests = [];
const test = (name, fn) => tests.push([name, fn]);

// ── 桩：按顺序返回预设响应，记录请求 ─────────────────────────
function sse(lines) {
  return new Response(new ReadableStream({
    start(c) { const e = new TextEncoder(); for (const l of lines) c.enqueue(e.encode(l + '\n\n')); c.close(); },
  }), { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
}
const chunk = (delta, extra = {}) => 'data: ' + JSON.stringify({ choices: [{ index: 0, delta }], ...extra });
const json = (status, obj) => new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json' } });
function stubFetch(handler) {
  const calls = [];
  const f = async (url, init = {}) => { calls.push({ url: String(url), init }); return handler(String(url), init, calls.length); };
  f.calls = calls;
  return f;
}

function makeGateway(dir, fetchImpl, accounts = ['a', 'b', 'c']) {
  const settings = new Settings(dir);
  const vault = new AccountVault(dir);
  for (const u of [...accounts].reverse()) vault.saveAccount(u, `n-${u}`, 'global', `tok-${u}`, `rt-${u}`);
  const scheduler = new AccountScheduler(vault, settings);
  const refreshed = [];
  const tokenKeeper = { refreshIfPossible: async uid => { refreshed.push(uid); vault.updateTokens(uid, `new-${uid}`); return true; } };
  const gw = new TencentGateway({ vault, scheduler, tokenKeeper, fetchImpl, log: quiet, backoffMs: 1 });
  return { gw, vault, scheduler, refreshed };
}

async function collect(gw, payload) {
  const out = [];
  await gw.streamChat(payload, 'conv1', l => { out.push(l); return true; });
  return out;
}

// ── convert ────────────────────────────────────────────────
test('uuidOf 与 Java UUID.nameUUIDFromBytes 一致', () => {
  assert.equal(uuidOf('hello'), '5d41402abc4b3a76b9719d911017c592');
});

test('conversationId：会话头 > metadata.user_id > system+首条 user（多轮不变）', () => {
  assert.equal(conversationId({ 'x-conversation-id': 'abc' }, {}), 'abc');
  assert.equal(conversationId({}, { metadata: { user_id: 'u1' } }), uuidOf('meta:u1'));
  const a = conversationId({}, { system: 'S', messages: [{ role: 'user', content: 'hi' }] });
  const b = conversationId({}, { system: 'S', messages: [{ role: 'user', content: 'hi' }, { role: 'assistant', content: 'yo' }, { role: 'user', content: 'more' }] });
  assert.equal(a, b);
  assert.equal(a, uuidOf('conv:S\u0000hi'));
});

test('Anthropic → OpenAI：tool_use / tool_result 配对、thinking、图片、tool_choice', () => {
  const out = convertRequest({
    model: 'm', max_tokens: 100, stream: true, system: [{ type: 'text', text: 'sys' }],
    tools: [{ name: 'ls', description: 'list', input_schema: { type: 'object' } }, { name: 'web_search', type: 'web_search_20250305' }],
    tool_choice: { type: 'any', disable_parallel_tool_use: true },
    messages: [
      { role: 'user', content: 'go' },
      { role: 'assistant', content: [{ type: 'thinking', thinking: 'hmm' }, { type: 'tool_use', id: 't1', name: 'ls', input: { p: 1 } }, { type: 'tool_use', id: 't2', name: 'ls', input: {} }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: [{ type: 'text', text: 'ok' }, { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AA' } }] }, { type: 'text', text: 'next' }] },
    ],
  });
  assert.deepEqual(out.stream_options, { include_usage: true });
  assert.equal(out.tools.length, 1);
  assert.equal(out.tool_choice, 'required');
  assert.equal(out.parallel_tool_calls, false);
  assert.deepEqual(out.messages.map(m => m.role), ['system', 'user', 'assistant', 'tool', 'tool', 'user']);
  const asst = out.messages[2];
  assert.equal(asst.content, null);
  assert.equal(asst.reasoning_content, 'hmm');
  assert.equal(asst.tool_calls[0].function.arguments, '{"p":1}');
  assert.equal(out.messages[4].content, '[no result: tool call was interrupted]');
  assert.equal(out.messages[5].content[0].type, 'image_url');
});

test('repairToolPairing 丢弃孤儿 tool、去重', () => {
  const r = repairToolPairing([
    { role: 'tool', tool_call_id: 'x', content: 'orphan' },
    { role: 'assistant', content: null, tool_calls: [{ id: 'a' }] },
    { role: 'tool', tool_call_id: 'a', content: '1' },
    { role: 'tool', tool_call_id: 'a', content: 'dup' },
  ]);
  assert.deepEqual(r.map(m => m.content), [null, '1']);
});

test('OpenAI → Anthropic 非流式', () => {
  const r = convertResponse({ choices: [{ message: { content: 'hi', tool_calls: [{ id: 'c1', function: { name: 'f', arguments: '{"a":1}' } }] }, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 3, completion_tokens: 4 } }, 'm');
  assert.equal(r.stop_reason, 'tool_use');
  assert.deepEqual(r.content[1].input, { a: 1 });
  assert.deepEqual(r.usage, { input_tokens: 3, output_tokens: 4 });
});

test('流式翻译：thinking → text → tool_use → message_delta', () => {
  const ev = [];
  const t = new AnthropicStreamTranslator('m', (e, d) => ev.push([e, d]));
  t.onChunk({ choices: [{ delta: { reasoning_content: 'r' } }] });
  t.onChunk({ choices: [{ delta: { content: 'a' } }] });
  t.onChunk({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'c', function: { name: 'f', arguments: '{"x"' } }] } }] });
  t.onChunk({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: ':1}' } }] }, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 9, completion_tokens: 7 } });
  t.finish();
  assert.deepEqual(ev.map(e => e[0]), ['message_start', 'content_block_start', 'content_block_delta', 'content_block_delta', 'content_block_stop',
    'content_block_start', 'content_block_delta', 'content_block_stop', 'content_block_start', 'content_block_delta', 'content_block_stop', 'message_delta', 'message_stop']);
  const toolDelta = ev.find(e => e[1].delta && e[1].delta.type === 'input_json_delta');
  assert.equal(toolDelta[1].delta.partial_json, '{"x":1}');
  const md = ev.find(e => e[0] === 'message_delta')[1];
  assert.equal(md.delta.stop_reason, 'tool_use');
  assert.deepEqual(md.usage, { input_tokens: 9, output_tokens: 7 });
});

// ── router ─────────────────────────────────────────────────
test('前门分流与 tests/test-engine-router.mjs 用例表一致', () => {
  const WB = ['deepseek-v4.1-flash-1017', 'hy4-preview', 'claude-4.0-sonnet', 'gemini-3.5-flash', 'gpt-6-astra', 'gpt-5.6-sol', 'auto'].map(id => ({ id }));
  const AG = ['claude-sonnet-4-6', 'gemini-3.8-flash', 'gemini-4-argon', 'gpt-5.6-sol'].map(id => ({ id }));
  const cases = [
    ['/v1/messages', 'claude-sonnet-4-6', 'wb', 'ag'], ['/v1/messages', 'claude-4.0-sonnet', 'wb', 'wb'],
    ['/v1/messages', 'gpt-5.6-sol', 'wb', 'wb'], ['/v1/messages', 'gpt-5.6-sol', 'ag', 'ag'],
    ['/v1/messages', 'ag:claude-4.0-sonnet', 'wb', 'ag'], ['/v1/messages', 'wb:claude-sonnet-4-6', 'ag', 'wb'],
    ['/v1/messages', 'unknown-model', 'wb', 'wb'], ['/v1/chat/completions', 'gemini-4-argon', 'wb', 'ag'],
    ['/ag/', 'x', 'wb', 'ag'], ['/api/status', 'x', 'wb', 'ag'], ['/panel/api/overview', 'x', 'wb', 'wb'], ['//v1//messages/', 'hy4-preview', 'wb', 'wb'],
  ];
  for (const [p, m, def, want] of cases) assert.equal(decide(p, m, { agModels: AG, wbModels: WB, defaultEngine: def }).engine, want, `${p} ${m}`);
  assert.equal(decide('/v1/messages', 'wb:x', {}).strip, 'wb:');
});

test('合并模型表：重名项补 ag: / wb: 版本', () => {
  const r = mergedModels([{ id: 'x' }, { id: 'w' }], [{ id: 'x' }, { id: 'g' }]);
  assert.deepEqual(r.data.map(m => m.id), ['x', 'w', 'g', 'ag:x', 'wb:x']);
});

// ── vault / scheduler ──────────────────────────────────────
test('导入：JSON 数组 / auth 对象 / 多行 JWT；禁用状态持久化；auths/ 自动并入', () => {
  const dir = tmp();
  const v = new AccountVault(dir);
  assert.deepEqual(v.importToken(JSON.stringify([{ uid: 'u1', accessToken: 't1' }, { uid: 'x' }])), [true, '成功导入 1 个账号']);
  assert.equal(v.importToken(JSON.stringify({ account: { uid: 'u2', nickname: 'N' }, auth: { accessToken: 't2', realm: 'cn' } }))[1], '成功导入账号：N');
  const jwt = ['eyJhbGciOiJub25lIn0', Buffer.from(JSON.stringify({ sub: 'u3', name: 'J' })).toString('base64url'), 'sig'].join('.');
  assert.deepEqual(v.importToken(`Bearer ${jwt}\nnot-a-token`), [true, '成功导入 1 个凭据']);
  assert.equal(v.importToken('garbage')[0], false);
  v.setDisabled('u1', true);
  const v2 = new AccountVault(dir);
  assert.equal(v2.find('u1').disabled, true);
  assert.equal(v2.find('u2').realm, 'cn');
  assert.ok(fs.existsSync(path.join(dir, 'auths', 'workbuddy-u3.json')));
  fs.writeFileSync(path.join(dir, 'auths', 'workbuddy-u9.json'), JSON.stringify({ account: { uid: 'u9' }, auth: { accessToken: 't9' } }));
  assert.equal(new AccountVault(dir).find('u9').accessToken, 't9');
  assert.equal(v2.deleteAccount('u3'), true);
  assert.ok(!fs.existsSync(path.join(dir, 'auths', 'workbuddy-u3.json')));
});

test('调度：手动选中 → 最久未用 → 全冷却取最快恢复', () => {
  const dir = tmp();
  const v = new AccountVault(dir);
  const s = new AccountScheduler(v, new Settings(dir));
  v.saveAccount('a', 'A', 'global', 't', ''); v.saveAccount('b', 'B', 'global', 't', '');
  v.updateAccount('a', x => { x.last_used = 5; }); v.updateAccount('b', x => { x.last_used = 9; });
  assert.equal(s.pick('global').uid, 'a');
  s.setSelectedUid('b');
  assert.equal(s.pick('global').uid, 'b');
  s.markCooling('b', 60_000);
  assert.equal(s.pick('global').uid, 'a');
  s.markCooling('a', 120_000);
  assert.equal(s.pick('global').uid, 'b');
  assert.equal(s.pick('global', new Set(['a', 'b'])), null);
  s.touch('a');
  assert.equal(s.poolStatus().find(p => p.uid === 'a').request_count, 1);
});

// ── gateway ────────────────────────────────────────────────
test('模型解析：cn: 前缀与别名', () => {
  assert.deepEqual(resolveModel('CN:Kimi-K3'), { realm: 'cn', clean: 'kimi-k3-1' });
  assert.deepEqual(resolveModel('global:deepseek-flash'), { realm: 'global', clean: 'deepseek-v4.1-flash' });
});

test('上游请求体：补 system、developer→system、当前轮补回思考', () => {
  const p = buildUpstreamPayload({ model: 'x', messages: [{ role: 'user', content: 'q' }, { role: 'assistant', tool_calls: [{ id: 'k' }] }, { role: 'tool', tool_call_id: 'k', content: 'r' }] }, 'y', id => (id === 'k' ? 'why' : null));
  assert.equal(p.messages[0].role, 'system');
  assert.equal(p.messages[2].reasoning_content, 'why');
  assert.equal(p.stream, true);
  assert.equal(buildUpstreamPayload({ messages: [{ role: 'developer', content: 'd' }] }, 'y', () => null).messages[0].role, 'system');
});

test('流式成功：透传每一帧并记录最近使用', async () => {
  const f = stubFetch(() => sse([chunk({ content: 'hi' }), 'data: [DONE]']));
  const { gw, vault } = makeGateway(tmp(), f);
  const out = await collect(gw, { model: 'hy3', messages: [{ role: 'user', content: 'x' }] });
  assert.equal(out.length, 2);
  assert.ok(out[0].endsWith('\n\n'));
  assert.equal(f.calls[0].url, 'https://www.workbuddy.ai/v2/chat/completions');
  const h = f.calls[0].init.headers;
  assert.equal(h['X-Domain'], 'www.workbuddy.ai');
  assert.equal(h['X-Machine-ID'].length, 36);
  assert.ok(vault.find('a').last_used > 0);
});

test('429：打冷却并换账号', async () => {
  const f = stubFetch((url, init) => (init.headers.Authorization === 'Bearer tok-a' ? json(429, { code: 14003 }) : sse([chunk({ content: 'ok' })])));
  const { gw, scheduler } = makeGateway(tmp(), f);
  const out = await collect(gw, { model: 'hy3', messages: [] });
  assert.equal(out.length, 1);
  assert.ok(scheduler.isCooling('a'));
  assert.equal(f.calls.at(-1).init.headers.Authorization, 'Bearer tok-b');
});

test('401：刷新 token 后下一个端点用新 token', async () => {
  const f = stubFetch((url, init) => (init.headers.Authorization === 'Bearer tok-a' ? json(401, { msg: 'unauthorized' }) : sse([chunk({ content: 'ok' })])));
  const { gw, refreshed } = makeGateway(tmp(), f, ['a']);
  await collect(gw, { model: 'hy3', messages: [] });
  assert.deepEqual(refreshed, ['a']);
  assert.equal(f.calls[1].init.headers.Authorization, 'Bearer new-a');
  assert.ok(f.calls[1].url.endsWith('/console/chat/completions'));
});

test('/v2 返回 404：回退 /console', async () => {
  const f = stubFetch(url => (url.includes('/v2/') ? json(404, {}) : sse([chunk({ content: 'ok' })])));
  const { gw } = makeGateway(tmp(), f, ['a']);
  assert.equal((await collect(gw, { model: 'hy3', messages: [] })).length, 1);
});

test('流中途 14003：未吐字时换账号；已吐字时不重试直接抛错', async () => {
  let n = 0;
  const f1 = stubFetch(() => (++n === 1 ? sse(['data: {"code":14003,"msg":"busy"}']) : sse([chunk({ content: 'ok' })])));
  const g1 = makeGateway(tmp(), f1);
  assert.equal((await collect(g1.gw, { model: 'hy3', messages: [] })).length, 1);

  const f2 = stubFetch(() => sse([chunk({ content: 'half' }), 'data: {"code":14003}']));
  const g2 = makeGateway(tmp(), f2);
  const seen = [];
  await assert.rejects(g2.gw.streamChat({ model: 'hy3', messages: [] }, 'c', l => { seen.push(l); return true; }), UpstreamError);
  assert.equal(seen.length, 1);
  assert.equal(f2.calls.length, 1);
});

test('全部账号持续 429：有限轮次后抛出（不会无限递归）', async () => {
  const f = stubFetch(() => json(429, { code: 14003 }));
  const { gw } = makeGateway(tmp(), f);
  await assert.rejects(collect(gw, { model: 'hy3', messages: [] }), e => e instanceof UpstreamError && e.status === 429);
  // 3 个账号 × 2 端点 × (1 + 2 轮退避)
  assert.equal(f.calls.length, 18);
});

test('不可重试的错误（400 落在最后一个端点）直接抛出', async () => {
  const f = stubFetch(() => json(400, { code: 11102, msg: 'model not found' }));
  const { gw } = makeGateway(tmp(), f);
  await assert.rejects(collect(gw, { model: 'hy3', messages: [] }), e => e.status === 400 && e.code === 11102);
  assert.equal(f.calls.length, 2);
});

test('没有账号时报「未登录账号」', async () => {
  const { gw } = makeGateway(tmp(), stubFetch(() => json(200, {})), []);
  await assert.rejects(collect(gw, { model: 'hy3', messages: [] }), /未登录账号/);
});

test('chatSync 聚合正文 / 思考 / tool_calls / usage', async () => {
  const f = stubFetch(() => sse([
    chunk({ reasoning_content: 'r' }), chunk({ content: 'a' }),
    chunk({ tool_calls: [{ index: 0, id: 'c1', function: { name: 'f', arguments: '{}' } }] }),
    'data: ' + JSON.stringify({ choices: [], usage: { prompt_tokens: 11, completion_tokens: 5 } }), 'data: [DONE]',
  ]));
  const { gw } = makeGateway(tmp(), f, ['a']);
  const r = await gw.chatSync({ model: 'hy3', messages: [] });
  assert.equal(r.content, 'a');
  assert.equal(r.reasoning_content, 'r');
  assert.equal(r.tool_calls[0].function.name, 'f');
  assert.equal(r.prompt_tokens, 11);
  assert.equal(gw.getReasoningByToolId('c1'), 'r');
});

test('错误映射与安卓一致', () => {
  assert.equal(errorPayload(new UpstreamError(429, null, 'u', ''))[0], 529);
  assert.equal(errorPayload(new UpstreamError(200, 14003, 'u', ''))[1].error.type, 'overloaded_error');
  assert.equal(errorPayload(new UpstreamError(403, 11128, 'u', ''))[1].error.type, 'upstream_channel_rejected');
  assert.equal(errorPayload(new UpstreamError(500, null, 'u', ''))[0], 502);
  assert.equal(errorPayload(new Error('x'))[0], 500);
});

// ── metrics ────────────────────────────────────────────────
test('统计口径：prompt 拆 cached、持久化、24 点趋势', () => {
  assert.deepEqual(usageFromOpenAi({ prompt_tokens: 100, completion_tokens: 10, prompt_tokens_details: { cached_tokens: 40 }, completion_tokens_details: { reasoning_tokens: 3 } }),
    { input: 60, cached: 40, output: 10, thoughts: 3 });
  assert.equal(usageFromOpenAi({}), null);
  const dir = tmp();
  const m = new GatewayMetrics(dir);
  m.record('POST', '/v1/messages', 'x', 'stream', 200, { input: 60, cached: 40, output: 10, thoughts: 3 }, 500, 120);
  m.record('POST', '/v1/messages', 'x', 'sync', 502, 0, 50, null, 'boom');
  const s = m.statsJson();
  assert.equal(s.engine, 'wb');
  assert.equal(s.total_requests, 2);
  assert.equal(s.cache_hit_rate, 0.4);
  assert.equal(s.avg_ttft_ms, 120);
  assert.equal(s.trend.points.length, 24);
  assert.equal(m.getLogsJson()[0].note, 'boom');
  m.flush();
  const m2 = new GatewayMetrics(dir);
  assert.equal(m2.statsJson().today.total_requests, 2);
  assert.equal(m2.getLogsJson().length, 0);
});

// ── HTTP：引擎层（桩上游）────────────────────────────────────
async function withEngine(fetchImpl, fn) {
  const dir = tmp();
  const wb = createWbEngine({ dataDir: dir, fetchImpl, log: quiet, backoffMs: 1 });
  wb.vault.saveAccount('a', 'A', 'global', 'tok-a', '');
  const srv = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    const chunks = []; for await (const c of req) chunks.push(c);
    const raw = Buffer.concat(chunks).toString('utf-8');
    if (await wb.handlePanel(req, res, url, raw)) return;
    const body = JSON.parse(raw);
    if (url.pathname === '/v1/messages') return wb.handleMessages(req, res, body);
    return wb.handleChat(req, res, body);
  });
  await new Promise(r => srv.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${srv.address().port}`;
  try { await fn(base, wb); } finally { srv.close(); wb.flush(); }
}
const post = (base, p, body) => fetch(base + p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

test('HTTP：OpenAI 流式透传 + 非流式 + 统计入账', async () => {
  const up = stubFetch(() => sse([chunk({ content: '你好' }), 'data: ' + JSON.stringify({ choices: [], usage: { prompt_tokens: 5, completion_tokens: 2 } }), 'data: [DONE]']));
  await withEngine(up, async (base, wb) => {
    const r = await post(base, '/v1/chat/completions', { model: 'hy3', stream: true, messages: [{ role: 'user', content: 'x' }] });
    assert.match(r.headers.get('content-type'), /event-stream/);
    const t = await r.text();
    assert.ok(t.includes('你好') && t.includes('[DONE]'));
    const j = await (await post(base, '/v1/chat/completions', { model: 'hy3', messages: [{ role: 'user', content: 'x' }] })).json();
    assert.equal(j.choices[0].message.content, '你好');
    assert.equal(j.usage.total_tokens, 7);
    const st = await (await fetch(base + '/panel/api/stats')).json();
    assert.equal(st.total_requests, 2);
    assert.equal(st.input_tokens, 10);
  });
});

test('HTTP：Anthropic 流式事件 + 非流式（含思考）', async () => {
  const up = stubFetch(() => sse([chunk({ reasoning_content: '想' }), chunk({ content: '答' }), 'data: [DONE]']));
  await withEngine(up, async base => {
    const t = await (await post(base, '/v1/messages', { model: 'hy3', stream: true, max_tokens: 10, messages: [{ role: 'user', content: 'x' }] })).text();
    for (const e of ['message_start', 'thinking_delta', 'text_delta', 'message_stop']) assert.ok(t.includes(e), e);
    const j = await (await post(base, '/v1/messages', { model: 'hy3', max_tokens: 10, messages: [{ role: 'user', content: 'x' }] })).json();
    assert.equal(j.type, 'message');
    assert.deepEqual(j.content.map(c => c.type), ['thinking', 'text']);
  });
});

test('HTTP：上游限流时流式返回 overloaded_error 并结束', async () => {
  await withEngine(stubFetch(() => json(429, { code: 14003 })), async base => {
    const t = await (await post(base, '/v1/messages', { model: 'hy3', stream: true, messages: [{ role: 'user', content: 'x' }] })).text();
    assert.ok(t.includes('event: error') && t.includes('overloaded_error'));
    const r = await post(base, '/v1/chat/completions', { model: 'hy3', messages: [{ role: 'user', content: 'x' }] });
    assert.equal(r.status, 529);
  });
});

test('HTTP：/panel/api 返回格式与 LocalGatewayServer 一致', async () => {
  const up = stubFetch(url => {
    if (url.includes('/auth/state')) return json(200, { code: 0, data: { state: 'S1', authUrl: 'https://auth' } });
    if (url.includes('/auth/token?state=')) return json(200, { code: 0, data: { accessToken: 'AT', refreshToken: 'RT' } });
    if (url.includes('/login/account')) return json(200, { data: { uid: 'u-new', nickname: 'New' } });
    return sse([chunk({ content: 'pong' })]);
  });
  await withEngine(up, async (base, wb) => {
    const g = p => fetch(base + p).then(r => r.json());
    const p = (u, b) => post(base, u, b || {}).then(r => r.json());
    const ov = await g('/panel/api/overview');
    assert.deepEqual(Object.keys(ov), ['healthy', 'total', 'accounts', 'today_requests', 'today_tokens', 'auth_required', 'version']);
    assert.deepEqual(await p('/panel/api/login/start', { realm: 'global' }), { ok: true, state: 'S1', url: 'https://auth', realm: 'global' });
    assert.deepEqual(await g('/panel/api/login/poll?state=S1'), { ok: true, done: true, uid: 'u-new', nickname: 'New', realm: 'global' });
    assert.equal((await g('/m/api/auth/poll?state=S1')).uid, 'u-new');
    const pool = await g('/panel/api/pool');
    assert.deepEqual(Object.keys(pool.accounts[0]), ['uid', 'nickname', 'realm', 'disabled', 'cooling', 'cooldown_sec', 'last_used', 'request_count']);
    assert.deepEqual(await p('/panel/api/pool/select', {}), { ok: false, msg: 'uid 不能为空' });
    assert.deepEqual(await p('/panel/api/pool/select', { uid: 'a' }), { ok: true, uid: 'a' });
    assert.deepEqual(await p('/panel/api/pool/toggle', { uid: 'a', disabled: true }), { ok: true });
    assert.equal(wb.vault.find('a').disabled, true);
    assert.equal((await p('/panel/api/accounts/export-one', { uid: 'a' })).account.accessToken, 'tok-a');
    assert.deepEqual(await p('/panel/api/accounts/export-one', { uid: 'zz' }), { ok: false, msg: '未找到该账号' });
    const test = await p('/panel/api/accounts/test', { uid: 'u-new' });
    assert.equal(test.ok, true);
    assert.equal(test.model, 'deepseek-v4.1-flash');
    assert.deepEqual(await p('/panel/api/tokens/import', { raw: JSON.stringify([{ uid: 'i1', accessToken: 'x' }]) }), { ok: true, msg: '成功导入 1 个账号' });
    assert.ok(Array.isArray(await g('/panel/api/tokens/export')));
    assert.deepEqual(await p('/panel/api/accounts/delete', { uid: 'i1' }), { ok: true });
    assert.deepEqual(await p('/panel/api/engine/default', { engine: 'ag' }), { ok: true, engine: 'ag' });
    assert.equal((await g('/panel/api/engine/state')).default_engine, 'ag');
    assert.equal((await g('/panel/api/engine/state')).dual, true);
    assert.deepEqual(await p('/panel/api/settings/gateway', { enabled: false }), { ok: true, enabled: false, msg: '网关已关闭' });
    assert.equal(wb.gatewayEnabled(), false);
    assert.equal((await g('/panel/api/settings/port')).ok, true);
    assert.equal((await p('/panel/api/settings/port', { port: 9000 })).ok, false);
    assert.equal((await g('/panel/api/models/wb')).data.length, wbModels().length);
    assert.deepEqual(await p('/panel/api/stats/reset'), { ok: true });
    assert.deepEqual(await p('/panel/api/logs/clear'), { ok: true });
    assert.deepEqual(Object.keys(await g('/panel/api/logs')), ['ok', 'logs', 'today_requests', 'today_tokens']);
    assert.deepEqual(await p('/panel/api/pool/clear-cooldown'), { ok: true });
    assert.equal((await p('/panel/api/tokens/refresh')).msg, '已在后台刷新');
  });
});

// ── HTTP：真实 server.mjs（不连上游）──────────────────────────
async function startServer(env) {
  const port = 20000 + Math.floor(Math.random() * 20000);
  const child = spawn(process.execPath, [path.join(ROOT, 'src', 'server.mjs')], {
    env: { ...process.env, PORT: String(port), HOST: '127.0.0.1', DATA_DIR: tmp(), NO_AUTH: '1', ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = '';
  child.stdout.on('data', d => { log += d; });
  child.stderr.on('data', d => { log += d; });
  for (let i = 0; i < 50; i++) {
    await new Promise(r => setTimeout(r, 100));
    try { await fetch(`http://127.0.0.1:${port}/health`); return { base: `http://127.0.0.1:${port}`, child, log: () => log }; } catch (e) { /* 还没起来 */ }
  }
  child.kill();
  throw new Error('server 启动失败:\n' + log);
}

test('server.mjs 双引擎：ADMIN_KEY 鉴权、合并模型表、分流到 WB、网关开关', async () => {
  const { base, child } = await startServer({ ADMIN_KEY: 'k1' });
  try {
    assert.equal((await fetch(base + '/panel/api/overview')).status, 401);
    assert.equal((await fetch(base + '/panel/api/engine/state')).status, 401);
    const H = { 'x-admin-key': 'k1', 'Content-Type': 'application/json' };
    const st = await (await fetch(base + '/panel/api/engine/state', { headers: H })).json();
    assert.equal(st.dual, true);
    assert.equal(st.standalone, false);
    assert.equal(st.auth, true);
    const ids = (await (await fetch(base + '/v1/models', { headers: H })).json()).data.map(m => m.id);
    assert.ok(ids.includes('hy3') && ids.includes('gemini-3.8-flash-high'));
    // WB 没有账号：分流到 WB 后报未登录（500 gateway_error），证明没走 AG
    const r = await fetch(base + '/v1/chat/completions', { method: 'POST', headers: H, body: JSON.stringify({ model: 'wb:hy3', messages: [{ role: 'user', content: 'x' }] }) });
    assert.equal(r.status, 500);
    assert.match((await r.json()).error.message, /未登录账号/);
    // AG 模型走 AG（没有 Google 账号 → AG 自己的 401 提示）
    const ra = await fetch(base + '/v1/messages', { method: 'POST', headers: H, body: JSON.stringify({ model: 'gemini-3.8-flash-high', max_tokens: 5, messages: [{ role: 'user', content: '中文' }] }) });
    assert.match(JSON.stringify(await ra.json()), /Google 账号/);
    // 数据面也要密钥
    assert.equal((await fetch(base + '/v1/messages', { method: 'POST', body: JSON.stringify({ model: 'hy3', messages: [] }) })).status, 401);
    await fetch(base + '/panel/api/settings/gateway', { method: 'POST', headers: H, body: JSON.stringify({ enabled: false }) });
    assert.equal((await fetch(base + '/v1/models', { headers: H })).status, 503);
    assert.equal((await fetch(base + '/panel/api/overview', { headers: H })).status, 200);
  } finally { child.kill(); }
});

test('server.mjs 安卓模式（ENGINE_TOKEN）：不加载 WB，行为不变', async () => {
  const { base, child } = await startServer({ ENGINE_TOKEN: 'et' });
  try {
    const H = { 'x-engine-token': 'et' };
    const st = await (await fetch(base + '/panel/api/engine/state', { headers: H })).json();
    assert.equal(st.standalone, true);
    assert.equal((await fetch(base + '/panel/api/overview', { headers: H })).status, 404);
    const ids = (await (await fetch(base + '/v1/models', { headers: H })).json()).data.map(m => m.id);
    assert.ok(!ids.includes('hy3'));
  } finally { child.kill(); }
});

for (const [name, fn] of tests) {
  try { await fn(); passed++; console.log('  ✓', name); } catch (e) { console.error('  ✗', name); console.error(e); process.exitCode = 1; }
}
console.log(`\nWB 引擎测试：通过 ${passed} / ${tests.length}`);
