/**
 * PR1 降级可见 + 少降级 + 重试收敛：node tests/test-downgrade.mjs
 */
import assert from 'assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { EventEmitter } from 'events';
import {
  runWithPolicy, Cooldowns, classifyFailure, parseRetryDelayMs, swapAccountInPayload, stripSignaturesForDowngrade,
} from '../src/upstream-policy.mjs';
import { buildDowngradeNotice, stripDowngradeNotice, shouldInsertNotice, DOWNGRADE_NOTICE_PREFIX } from '../src/downgrade-notice.mjs';
import { buildCloudCodePayload, mapToUpstreamModel, MODEL_FALLBACK_CHAINS } from '../src/cloudcode.mjs';
import { handleStreamConversion } from '../src/sse-streamer.mjs';
import { StatsTracker } from '../src/stats.mjs';
import { FALLBACK_THOUGHT_SIGNATURE } from '../src/signature-cache.mjs';

let passed = 0;
const ok = async (name, fn) => { await fn(); passed++; console.log('  ✓', name); };

const MAIN = 'gemini-3.8-flash-high';
const D = 'https://daily.example', A = 'https://autopush.example';
const mgr = email => ({ tokenData: { email, projectId: 'proj-' + email } });
const resp = (status, body = '') => ({ ok: status >= 200 && status < 300, status, text: async () => body, headers: { get: () => null } });
const Q429 = (delay) => JSON.stringify({ error: { code: 429, status: 'RESOURCE_EXHAUSTED', details: delay ? [{ '@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay: delay }] : [] } });

/** 模拟上游：rule(model, email, host, n) → status 或 Error */
function harness({ accounts = ['a', 'b', 'c'], active = 'a', rule, cooldowns = null, allowDowngrade = true, clock = null, deadlineMs = 45000 }) {
  const calls = [];
  let t = 0;
  const now = clock || (() => t);
  const cd = cooldowns || new Cooldowns(now);
  const mgrs = accounts.map(mgr);
  const req = { model: MAIN, max_tokens: 100, messages: [{ role: 'user', content: 'hi' }], _gwSessionKey: 'k' };
  return {
    calls, cooldowns: cd, advance: ms => { t += ms; },
    run: () => runWithPolicy({
      model: MAIN, anthropicReq: req, upstreamOf: mapToUpstreamModel,
      accounts: () => mgrs, activeEmail: active, quotaOf: () => null, cooldowns: cd,
      buildPayload: (model, m) => ({ model: mapToUpstreamModel(model), request: { sessionId: 's', contents: [] }, project: m.tokenData.projectId }),
      send: async (p, m, host, timeoutMs) => {
        const n = calls.length;
        calls.push({ model: p.model, email: m.tokenData.email, host, timeoutMs });
        const r = rule(p.model, m.tokenData.email, host, n);
        if (r instanceof Error) throw r;
        if (typeof r === 'number') return resp(r, r === 429 ? Q429() : r >= 400 ? '{"error":"x"}' : '');
        return r;
      },
      hosts: [D, A], chain: MODEL_FALLBACK_CHAINS[MAIN], allowDowngrade, headerTimeoutMs: 60000, deadlineMs,
      now, sleep: async ms => { t += ms; }, startedAt: now(),
    }),
  };
}

console.log('policy');
await ok('降级链：3.8-flash-high → 3.6-flash-high → 3-flash（去掉 2.5）', () => {
  assert.deepEqual(MODEL_FALLBACK_CHAINS[MAIN], ['gemini-3.6-flash-high', 'gemini-3-flash']);
});

await ok('单个账号 429、其余正常：不降级，换号，model_used = 主模型', async () => {
  const h = harness({ rule: (m, e) => (e === 'a' ? 429 : 200) });
  const r = await h.run();
  assert.ok(r.ok);
  assert.equal(r.modelUsed, MAIN);
  assert.equal(r.downgraded, false);
  assert.equal(r.mgr.tokenData.email, 'b');
  assert.equal(r.switchedAccount, true);
  assert.ok(h.calls.every(c => c.host === D), '429 不换 host');
  assert.ok(h.cooldowns.isCooling('a', 'gemini-3.8-flash-tiered'));
});

await ok('所有账号 429：降级到 3.6-flash-high，reason = quota_all_accounts', async () => {
  const h = harness({ rule: (m) => (m === 'gemini-3.8-flash-tiered' ? 429 : 200) });
  const r = await h.run();
  assert.ok(r.ok);
  assert.equal(r.modelUsed, 'gemini-3.6-flash-high');
  assert.equal(r.downgraded, true);
  assert.equal(r.reason, 'quota_all_accounts');
  assert.equal(h.calls.filter(c => c.model === 'gemini-3.8-flash-tiered').length, 3);
});

await ok('冷却期内新请求直接走降级；冷却到期后自动用回主模型', async () => {
  let t = 0; const clock = () => t;
  const cd = new Cooldowns(clock);
  const rule = (m) => (m === 'gemini-3.8-flash-tiered' ? 429 : 200);
  const h1 = harness({ rule, cooldowns: cd, clock });
  await h1.run();
  const h2 = harness({ rule: () => 200, cooldowns: cd, clock });
  const r2 = await h2.run();
  assert.equal(r2.modelUsed, 'gemini-3.6-flash-high');
  assert.equal(h2.calls.length, 1, '不再逐个试冷却中的账号');
  t += 61000;
  const h3 = harness({ rule: () => 200, cooldowns: cd, clock });
  const r3 = await h3.run();
  assert.equal(r3.modelUsed, MAIN);
  assert.equal(r3.downgraded, false);
});

await ok('400：不换号、不降级，直接返回', async () => {
  const h = harness({ rule: () => 400 });
  const r = await h.run();
  assert.equal(r.ok, false);
  assert.equal(r.error.kind, 'bad_request');
  assert.equal(h.calls.length, 1);
});

await ok('429 且 retryDelay ≤ 5s：等待后原账号重试 1 次', async () => {
  let n = 0;
  const h = harness({ rule: () => (n++ === 0 ? resp(429, Q429('2.5s')) : 200) });
  const r = await h.run();
  assert.ok(r.ok);
  assert.deepEqual(h.calls.map(c => c.email), ['a', 'a']);
  assert.equal(r.switchedAccount, false);
});

await ok('5xx：换 host 1 次，再换账号 1 次，然后降级（不再三 host 串行全轮询）', async () => {
  const h = harness({ rule: (m) => (m === 'gemini-3.8-flash-tiered' ? 503 : 200) });
  const r = await h.run();
  assert.deepEqual(h.calls.slice(0, 3).map(c => [c.email, c.host]), [['a', D], ['a', A], ['b', D]]);
  assert.equal(r.modelUsed, 'gemini-3.6-flash-high');
  assert.equal(r.reason, 'upstream_5xx');
});

await ok('响应头超时归为 timeout，同样换 host', async () => {
  const to = Object.assign(new Error('upstream header timeout 60000ms'), { name: 'TimeoutError' });
  const h = harness({ rule: (m, e, host) => (host === D && e === 'a' ? to : 200) });
  const r = await h.run();
  assert.ok(r.ok);
  assert.equal(r.modelUsed, MAIN);
  assert.deepEqual(h.calls.map(c => c.host), [D, A]);
});

await ok('ALLOW_DOWNGRADE 关闭：全部 429 时返回 quota 错误，不试降级模型', async () => {
  const h = harness({ rule: () => 429, allowDowngrade: false });
  const r = await h.run();
  assert.equal(r.ok, false);
  assert.equal(r.error.kind, 'quota');
  assert.ok(h.calls.every(c => c.model === 'gemini-3.8-flash-tiered'));
});

await ok('上游全挂：超过总截止不再发起重试，单次尝试享有完整首包超时', async () => {
  let t = 0; const clock = () => t;
  const h = harness({ clock, deadlineMs: 45000, rule: () => { t += 30000; return 503; } });
  const r = await h.run();
  assert.equal(r.ok, false);
  assert.equal(h.calls.length, 2, '30s + 30s 后已过 45s 截止');
  assert.equal(h.calls[0].timeoutMs, 60000);
  assert.equal(h.calls[1].timeoutMs, 60000, '重试享有完整 headerTimeoutMs，不被总期限截短');
});

await ok('只是凭据失效（401）：换号，全部失效时不降级', async () => {
  const h = harness({ rule: () => 401 });
  const r = await h.run();
  assert.equal(r.ok, false);
  assert.equal(r.error.kind, 'auth');
  assert.ok(h.calls.every(c => c.model === 'gemini-3.8-flash-tiered'));
  assert.deepEqual(h.calls.map(c => c.email), ['a', 'b', 'c']);
});

await ok('错误分类与 retryDelay 解析', () => {
  assert.equal(classifyFailure({ status: 400 }), 'bad_request');
  assert.equal(classifyFailure({ status: 403, body: 'RESOURCE_EXHAUSTED' }), 'quota');
  assert.equal(classifyFailure({ status: 403, body: 'denied' }), 'auth');
  assert.equal(classifyFailure({ status: 500 }), 'server');
  assert.equal(classifyFailure({ error: new TypeError('fetch failed') }), 'network');
  assert.equal(parseRetryDelayMs(Q429('3.5s')), 3500);
  assert.equal(parseRetryDelayMs('', { 'retry-after': '7' }), 7000);
  assert.equal(parseRetryDelayMs('{}'), null);
});

console.log('payload');
const convo = () => ({
  model: MAIN, max_tokens: 1000, _gwSessionKey: 'dg-conv',
  messages: [
    { role: 'user', content: 'start dg' },
    { role: 'assistant', content: [{ type: 'thinking', thinking: 'th', signature: 'REAL_SIG' }, { type: 'text', text: 'answer one' }] },
    { role: 'user', content: 'next' },
  ],
});
const noReqId = p => { const c = { ...p }; delete c.requestId; return JSON.stringify(c); };

await ok('主模型 payload 字节不变（thinkingLevel=high、上游模型名不动）', () => {
  const p = buildCloudCodePayload(convo(), 'proj');
  assert.equal(p.model, 'gemini-3.8-flash-tiered');
  assert.deepEqual(p.request.generationConfig.thinkingConfig, { includeThoughts: true, thinkingLevel: 'high' });
  assert.equal(noReqId(p), noReqId(buildCloudCodePayload(convo(), 'proj')));
});

await ok('换号重试只换 sessionId/project，与对该账号全新构建一致', () => {
  const r1 = { ...convo(), _gwEmail: 'a@x' };
  const p = buildCloudCodePayload(r1, 'proj-a');
  swapAccountInPayload(p, r1, 'b@x', 'proj-b');
  const fresh = buildCloudCodePayload({ ...convo(), _gwEmail: 'b@x' }, 'proj-b');
  assert.equal(noReqId(p), noReqId(fresh));
});

await ok('降级 payload 用通用签名、Gemini 3 系用 thinkingLevel=high', () => {
  const p = stripSignaturesForDowngrade(buildCloudCodePayload({ ...convo(), model: 'gemini-3.6-flash-high' }, 'proj'));
  assert.equal(p.model, 'gemini-3.6-flash-high');
  assert.equal(p.request.generationConfig.thinkingConfig.thinkingLevel, 'high');
  const sigs = p.request.contents.flatMap(c => c.parts).filter(x => x.thoughtSignature).map(x => x.thoughtSignature);
  assert.ok(sigs.length > 0 && sigs.every(s => s === FALLBACK_THOUGHT_SIGNATURE));
  // 主模型 payload 不受影响
  const main = buildCloudCodePayload(convo(), 'proj');
  assert.ok(main.request.contents.flatMap(c => c.parts).some(x => x.thoughtSignature === 'REAL_SIG'));
});

await ok('历史里的降级提示行被精确剔掉，payload 与从未插入时字节一致', () => {
  const notice = buildDowngradeNotice(MAIN, 'gemini-3.6-flash-high', 'quota_all_accounts');
  assert.ok(notice.startsWith(DOWNGRADE_NOTICE_PREFIX) && notice.endsWith('\n\n'));
  const withNotice = convo();
  withNotice._gwSessionKey = 'dg-strip';
  withNotice.messages[1].content[1].text = notice + 'answer one';
  const clean = convo();
  clean._gwSessionKey = 'dg-strip2';
  const a = buildCloudCodePayload(withNotice, 'proj'), b = buildCloudCodePayload(clean, 'proj');
  assert.equal(JSON.stringify(a.request.contents), JSON.stringify(b.request.contents));
  assert.equal(stripDowngradeNotice('普通文本'), '普通文本');
  assert.equal(stripDowngradeNotice(notice), '');
});

await ok('带 tools / JSON 输出 / DOWNGRADE_NOTICE=0 时不插提示行', () => {
  assert.equal(shouldInsertNotice({}, {}), true);
  assert.equal(shouldInsertNotice({ tools: [{ name: 'x' }] }, {}), false);
  assert.equal(shouldInsertNotice({ output_format: { type: 'json_schema' } }, {}), false);
  assert.equal(shouldInsertNotice({}, { DOWNGRADE_NOTICE: '0' }), false);
});

console.log('stream / stats');
function mockRes() {
  const r = new EventEmitter();
  r.out = ''; r.writableFinished = false;
  r.setHeader = () => {}; r.flushHeaders = () => {};
  r.write = s => { r.out += s; return true; };
  r.end = () => { r.writableFinished = true; r.emit('close'); };
  return r;
}
function upstream(chunks) {
  const enc = new TextEncoder(); let i = 0;
  return { body: { getReader: () => ({ read: async () => (i >= chunks.length ? { done: true } : { done: false, value: enc.encode(chunks[i++]) }), cancel: async () => {} }) } };
}
const sse = obj => `data: ${JSON.stringify({ response: obj })}\n\n`;
const events = out => out.split('\n\n').filter(Boolean).map(b => JSON.parse(b.split('\n')[1].slice(6)));

await ok('流式：提示行进第一个 text block，不进 thinking；message.model 为实际模型', async () => {
  const notice = buildDowngradeNotice(MAIN, 'gemini-3.6-flash-high', 'timeout');
  const res = mockRes();
  await handleStreamConversion(upstream([
    sse({ candidates: [{ content: { parts: [{ text: 'think', thought: true, thoughtSignature: 'S' }] } }] }),
    sse({ candidates: [{ content: { parts: [{ text: 'hello' }] } }] }),
    sse({ candidates: [{ content: { parts: [{ text: ' world' }] } }] }),
  ]), res, 'gemini-3.6-flash-high', null, Date.now(), { notice });
  const ev = events(res.out);
  assert.equal(ev[0].message.model, 'gemini-3.6-flash-high');
  const deltas = ev.filter(e => e.type === 'content_block_delta');
  const thinking = deltas.filter(d => d.delta.type === 'thinking_delta').map(d => d.delta.thinking).join('');
  const text = deltas.filter(d => d.delta.type === 'text_delta').map(d => d.delta.text).join('');
  assert.equal(thinking, 'think');
  assert.equal(text, notice + 'hello world');
  assert.equal(deltas.filter(d => d.delta.type === 'signature_delta')[0].delta.signature, 'S');
});

await ok('流式无 notice 时输出与原来一致', async () => {
  const chunks = [sse({ candidates: [{ content: { parts: [{ text: 'hello' }] } }] })];
  const a = mockRes(), b = mockRes();
  await handleStreamConversion(upstream(chunks), a, MAIN, null, Date.now());
  await handleStreamConversion(upstream(chunks), b, MAIN, null, Date.now(), { notice: null });
  const norm = s => s.replace(/msg_[0-9a-f]+/g, 'msg_X');
  assert.equal(norm(a.out), norm(b.out));
});

await ok('stats：记录 model_used / downgraded / reason，汇总近 24h 降级次数、降级率、原因分布', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dg-'));
  const st = new StatsTracker(dir, { autoFlushOnExit: false });
  const now = new Date();
  st.recordRequest({ email: 'a', model: MAIN, latency_ms: 10, model_used: MAIN, now });
  st.recordRequest({ email: 'a', model: MAIN, latency_ms: 10, model_used: 'gemini-3.6-flash-high', downgraded: true, downgrade_reason: 'quota_all_accounts', now });
  st.recordRequest({ email: 'b', model: MAIN, latency_ms: 10, model_used: 'gemini-3-flash', downgraded: true, downgrade_reason: 'timeout', now });
  st.recordRequest({ email: 'b', model: MAIN, latency_ms: 10, model_used: MAIN, now });
  const s = st.getStats();
  assert.equal(s.downgrade_24h.count, 2);
  assert.equal(s.downgrade_24h.requests, 4);
  assert.equal(s.downgrade_24h.rate, 0.5);
  assert.deepEqual(s.downgrade_24h.reasons, { quota_all_accounts: 1, timeout: 1 });
  const log = st.getUserLogs('a')[0];
  assert.equal(log.downgraded, true);
  assert.equal(log.model_used, 'gemini-3.6-flash-high');
  fs.rmSync(dir, { recursive: true, force: true });
});

console.log(`\n${passed} passed`);
