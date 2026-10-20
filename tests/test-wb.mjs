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
  assert.ok(v.find('a').last_used > 9);
  assert.equal(s.poolStatus().find(p => p.uid === 'a').request_count, 0); // touch 只记最近使用，计数在请求结束时记
  s.recordUsage('a', 7); s.recordUsage('a', 0); s.recordUsage('', 5);
  assert.equal(s.poolStatus().find(p => p.uid === 'a').request_count, 2);
  assert.deepEqual(v.find('a').token_usage, { request_count: 2, total_tokens: 7 });
});

test('调度：会话亲和表 (Session Affinity) 粘滞与 429 遇冷换绑 (含 CAS 保护)', () => {
  const dir = tmp();
  const v = new AccountVault(dir);
  const s = new AccountScheduler(v, new Settings(dir));
  v.saveAccount('u1', 'User1', 'global', 't1', '');
  v.saveAccount('u2', 'User2', 'global', 't2', '');
  v.saveAccount('u3', 'User3', 'global', 't3', '');

  // 1. 首次提问分配账号（按 LRU）并锁定亲和
  const first = s.pick('global', new Set(), 'conv-alice');
  assert.ok(first && first.uid);
  const lockedUid = first.uid;

  // 2. 模拟后续 10 轮对话：在无冷却情况下 100% 锁定该账号（保住腾讯 KV-Cache）
  for (let i = 0; i < 10; i++) {
    const next = s.pick('global', new Set(), 'conv-alice');
    assert.equal(next.uid, lockedUid, `第 ${i + 1} 轮对话必须严格锁定同一账号保住 KV-Cache`);
  }

  // 3. 模拟撞上 429 限流：lockedUid 进入冷却
  s.markCooling(lockedUid, 8000);
  // conv-alice 发起新一轮提问，必须自动绕行至其他健康账号并更新绑定
  const rebountAcc = s.pick('global', new Set([lockedUid]), 'conv-alice');
  assert.notEqual(rebountAcc.uid, lockedUid, '遇冷时必须无感换号重派');

  // 下一次提问，亲和表已自动更新为新账号并继续锁定
  const reboundNext = s.pick('global', new Set(), 'conv-alice');
  assert.equal(reboundNext.uid, rebountAcc.uid, '换号后会话亲和表无缝更新并保持粘滞');

  // 4. CAS 保护测试：慢请求携带旧 epoch 不能覆盖新 epoch
  const curBinding = s.getBinding('conv-alice');
  assert.ok(curBinding);
  const oldEpoch = curBinding.epoch - 1;
  const staleRes = s.bindSession('conv-alice', 'u1', oldEpoch);
  assert.equal(staleRes.uid, rebountAcc.uid, 'CAS 校验失败时不可覆盖较新的绑定');
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

test('账号用量：每次请求结束（成功或失败）记到最终账号；重试换号只记最后一个；不触发云端同步', async () => {
  // a 永远 429，b 正常：每个请求都会先试 a 再换 b
  const up = stubFetch((url, init) => (init.headers.Authorization === 'Bearer tok-a'
    ? json(429, { code: 14003 })
    : sse([chunk({ content: 'ok' }), 'data: ' + JSON.stringify({ choices: [], usage: { prompt_tokens: 5, completion_tokens: 2 } }), 'data: [DONE]'])));
  const dir = tmp();
  let changes = 0;
  const wb = createWbEngine({ dataDir: dir, fetchImpl: up, log: quiet, backoffMs: 1, onChange: () => { changes++; } });
  wb.vault.saveAccount('b', 'B', 'global', 'tok-b', '');
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
  try {
    const changesBefore = changes;
    await (await post(base, '/v1/chat/completions', { model: 'hy3', stream: true, messages: [{ role: 'user', content: 'x' }] })).text();
    await (await post(base, '/v1/chat/completions', { model: 'hy3', messages: [{ role: 'user', content: 'x' }] })).json();
    await (await post(base, '/v1/messages', { model: 'hy3', stream: true, max_tokens: 10, messages: [{ role: 'user', content: 'x' }] })).text();
    await (await post(base, '/v1/messages', { model: 'hy3', max_tokens: 10, messages: [{ role: 'user', content: 'x' }] })).json();
    // 四种入口各一次，全部记在最终账号 b 上；a 只是被试过，不计
    assert.deepEqual(wb.vault.find('b').token_usage, { request_count: 4, total_tokens: 28 });
    assert.deepEqual(wb.vault.find('a').token_usage, { request_count: 0, total_tokens: 0 });
    // 概览卡片与账号池读到同一个数
    const ov = await (await fetch(base + '/panel/api/overview')).json();
    assert.equal(ov.accounts.find(x => x.uid === 'b').token_usage.total_tokens, 28);
    const pool = await (await fetch(base + '/panel/api/pool')).json();
    assert.equal(pool.accounts.find(x => x.uid === 'b').request_count, 4);
    // 失败也计数（Token 为 0），记在最后一次尝试的账号上
    wb.vault.setDisabled('b', true);
    const r = await post(base, '/v1/chat/completions', { model: 'hy3', messages: [{ role: 'user', content: 'x' }] });
    assert.equal(r.status, 529);
    assert.deepEqual(wb.vault.find('a').token_usage, { request_count: 1, total_tokens: 0 });
    // 用量写入是 quiet 的：除了上面手动 setDisabled 那一次，不触发同步
    assert.equal(changes, changesBefore + 1);
    // 写盘了，重启后还在
    const again = new AccountVault(path.join(dir, 'wb'));
    assert.equal(again.find('b').token_usage.request_count, 4);
  } finally { srv.close(); wb.flush(); }
});

test('请求日志带上最终账号 uid / nickname（成功与失败都有）', async () => {
  let fail = false;
  const up = stubFetch(() => (fail ? json(400, { code: 1, msg: 'bad' }) : sse([chunk({ content: 'ok' }), 'data: [DONE]'])));
  await withEngine(up, async (base, wb) => {
    await (await post(base, '/v1/chat/completions', { model: 'hy3', stream: true, messages: [{ role: 'user', content: 'x' }] })).text();
    fail = true;
    await (await post(base, '/v1/messages', { model: 'hy3', max_tokens: 10, messages: [{ role: 'user', content: 'x' }] })).json();
    const { logs } = await (await fetch(base + '/panel/api/logs')).json();
    assert.equal(logs.length, 2);
    for (const l of logs) { assert.equal(l.uid, 'a'); assert.equal(l.nickname, 'A'); }
    assert.ok(logs[0].status >= 400 && logs[1].status === 200);
    // 没选到账号（请求体无法解析）时字段仍在，为空字符串
    wb.metrics.record('POST', '/v1/messages', 'm', 'error', 400, 0, 1, null, 'bad');
    const first = (await (await fetch(base + '/panel/api/logs')).json()).logs[0];
    assert.equal(first.uid, ''); assert.equal(first.nickname, '');
  });
});

test('暂停当前选中账号：selected_uid 回到自动；已暂停账号不能设为当前', async () => {
  await withEngine(stubFetch(() => sse([chunk({ content: 'ok' })])), async (base, wb) => {
    wb.vault.saveAccount('b', 'B', 'global', 'tok-b', '');
    const g = p => fetch(base + p).then(r => r.json());
    const p = (u, b) => post(base, u, b || {}).then(r => r.json());
    assert.deepEqual(await p('/panel/api/pool/select', { uid: 'a' }), { ok: true, uid: 'a' });
    // 暂停别的账号不影响选中
    assert.deepEqual(await p('/panel/api/pool/toggle', { uid: 'b', disabled: true }), { ok: true });
    assert.equal((await g('/panel/api/pool')).selected_uid, 'a');
    // 暂停选中的账号：回到自动
    assert.deepEqual(await p('/panel/api/pool/toggle', { uid: 'a', disabled: true }), { ok: true });
    assert.equal((await g('/panel/api/pool')).selected_uid, '');
    assert.equal(wb.scheduler.getSelectedUid(), '');
    // 已暂停的账号点「使用」被拒绝
    assert.deepEqual(await p('/panel/api/pool/select', { uid: 'a' }), { ok: false, msg: '该账号已暂停，请先启用' });
    assert.equal(wb.scheduler.getSelectedUid(), '');
    // 重新启用后不会自动变回「当前」，可以再选
    assert.deepEqual(await p('/panel/api/pool/toggle', { uid: 'a', disabled: false }), { ok: true });
    assert.equal((await g('/panel/api/pool')).selected_uid, '');
    assert.deepEqual(await p('/panel/api/pool/select', { uid: 'a' }), { ok: true, uid: 'a' });
    // 修复前遗留的状态（选中的账号已是暂停）：读取账号池时视为自动并清掉
    wb.vault.setDisabled('a', true);
    assert.equal((await g('/panel/api/pool')).selected_uid, '');
    assert.equal(wb.scheduler.getSelectedUid(), '');
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

test('server.mjs：HOST=0.0.0.0 且没有 ADMIN_KEY 时打印安全警告', async () => {
  const { child, log } = await startServer({ HOST: '0.0.0.0' });
  try {
    await new Promise(r => setTimeout(r, 200));
    assert.match(log(), /安全警告/);
    assert.match(log(), /tokens\/export/);
  } finally { child.kill(); }
  const s2 = await startServer({ HOST: '0.0.0.0', ADMIN_KEY: 'k' });
  try { await new Promise(r => setTimeout(r, 200)); assert.doesNotMatch(s2.log(), /安全警告/); } finally { s2.child.kill(); }
});

// ── persist：WB 数据同步到 GitHub state 分支（本地假 GitHub API）────────
function fakeGitHub() {
  const files = new Map(); // path -> {content(base64), sha}
  let n = 0, puts = 0;
  const srv = http.createServer(async (req, res) => {
    const u = new URL(req.url, 'http://x');
    const chunks = []; for await (const c of req) chunks.push(c);
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : null;
    const send = (st, o) => { res.writeHead(st, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(o)); };
    if (/\/branches\//.test(u.pathname)) return send(200, { name: 'state' });
    const m = u.pathname.match(/^\/repos\/[^/]+\/[^/]+\/contents\/(.+)$/);
    if (!m) return send(404, {});
    const p = decodeURIComponent(m[1]);
    if (req.method === 'GET') {
      if (files.has(p)) return send(200, { type: 'file', path: p, sha: files.get(p).sha, content: files.get(p).content });
      const kids = [...files.keys()].filter(k => k.startsWith(p + '/') && !k.slice(p.length + 1).includes('/'));
      return kids.length ? send(200, kids.map(k => ({ type: 'file', path: k, name: k.split('/').pop(), sha: files.get(k).sha }))) : send(404, {});
    }
    if (req.method === 'PUT') { puts++; const sha = 's' + (++n); files.set(p, { content: body.content, sha }); return send(200, { content: { sha } }); }
    if (req.method === 'DELETE') { files.delete(p); return send(200, {}); }
    send(404, {});
  });
  return { srv, files, puts: () => puts, read: p => files.has(p) ? Buffer.from(files.get(p).content, 'base64').toString() : null };
}

test('persist：WB 账号 / 设置 / 统计同步到云端，重新部署后恢复；最近使用不触发提交', async () => {
  const gh = fakeGitHub();
  await new Promise(r => gh.srv.listen(0, '127.0.0.1', r));
  process.env.GH_API = `http://127.0.0.1:${gh.srv.address().port}`;
  process.env.GH_TOKEN = 't'; process.env.GH_REPO = 'o/r';
  try {
    const { Persist, stripVolatile, mergeVolatile } = await import('../src/persist.mjs?wb=' + Date.now());
    assert.deepEqual(JSON.parse(stripVolatile(JSON.stringify([{ uid: 'a', accessToken: 't', last_used: 5, token_usage: { request_count: 3 } }]))), [{ uid: 'a', accessToken: 't' }]);
    assert.equal(JSON.parse(mergeVolatile(JSON.stringify([{ uid: 'a', accessToken: 'new' }]), JSON.stringify([{ uid: 'a', accessToken: 'old', last_used: 9 }])))[0].last_used, 9);

    // 第一台机器：加账号、改设置、记一笔统计
    const d1 = tmp();
    const p1 = new Persist(d1);
    await p1.restore();
    let changes = 0;
    const wb1 = createWbEngine({ dataDir: d1, log: quiet, onChange: () => { changes++; p1.schedule(); } });
    wb1.vault.saveAccount('u1', 'N1', 'global', 'AT1', 'RT1');
    wb1.settings.set('default_engine', 'ag');
    wb1.metrics.record('POST', '/v1/messages', 'm', 'stream', 200, { input: 1, cached: 0, output: 2, thoughts: 0 }, 10);
    wb1.flush();
    clearTimeout(p1.timer);
    await p1.sync();
    await p1.syncStats();
    assert.equal(JSON.parse(gh.read('gateway-state/wb/accounts.json'))[0].accessToken, 'AT1');
    assert.equal(JSON.parse(gh.read('gateway-state/wb/settings.json')).default_engine, 'ag');
    assert.ok(gh.read('gateway-state/wb/metrics.json'));

    // 每次请求都会 touch（最近使用 / 计数）：推送内容不变，不产生提交
    const before = gh.puts(), changesBefore = changes;
    wb1.scheduler.touch('u1');
    assert.equal(changes, changesBefore);
    await p1.sync();
    assert.equal(gh.puts(), before);
    // Token 刷新属于实质变化，要同步
    wb1.vault.updateTokens('u1', 'AT2');
    clearTimeout(p1.timer);
    await p1.sync();
    assert.equal(JSON.parse(gh.read('gateway-state/wb/accounts.json'))[0].accessToken, 'AT2');

    // 第二台（重新部署、空磁盘）：恢复后 WB 引擎直接可用
    const d2 = tmp();
    const p2 = new Persist(d2);
    await p2.restore();
    const wb2 = createWbEngine({ dataDir: d2, log: quiet });
    assert.equal(wb2.vault.find('u1').accessToken, 'AT2');
    assert.equal(wb2.defaultEngine(), 'ag');
    assert.equal(wb2.metrics.statsJson().total_requests, 1);
    assert.ok(fs.existsSync(path.join(d2, 'wb', 'auths', 'workbuddy-u1.json')));

    // 删除账号同步上去，再部署也不会回来
    wb2.vault.deleteAccount('u1');
    await p2.sync();
    clearTimeout(p2.timer);
    const d3 = tmp();
    await new Persist(d3).restore();
    assert.equal(createWbEngine({ dataDir: d3, log: quiet }).vault.getAccounts().length, 0);
    wb1.flush(); wb2.flush();
  } finally {
    gh.srv.close();
    delete process.env.GH_API; delete process.env.GH_TOKEN; delete process.env.GH_REPO;
  }
});

for (const [name, fn] of tests) {
  try { await fn(); passed++; console.log('  ✓', name); } catch (e) { console.error('  ✗', name); console.error(e); process.exitCode = 1; }
}
console.log(`\nWB 引擎测试：通过 ${passed} / ${tests.length}`);
