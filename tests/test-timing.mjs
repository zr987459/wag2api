/**
 * PR2 分段打点单元测试：node tests/test-timing.mjs
 * - sse-streamer 记录 t_first_thought / t_first_text，且不改变输出事件流
 * - StatsTracker 保存 timing、getTimingSummary 求最近 n 条中位数
 */
import assert from 'assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { EventEmitter } from 'events';
import { handleStreamConversion } from '../src/sse-streamer.mjs';
import { StatsTracker, median } from '../src/stats.mjs';

let passed = 0;
const ok = (name, fn) => Promise.resolve().then(fn).then(() => { passed++; console.log('  ✓', name); });

function mockRes() {
  const r = new EventEmitter();
  r.out = ''; r.writableFinished = false;
  r.setHeader = () => {}; r.flushHeaders = () => {};
  r.write = s => { r.out += s; return true; };
  r.end = () => { r.writableFinished = true; r.emit('close'); };
  return r;
}
const sleep = ms => new Promise(r => setTimeout(r, ms));
function upstream(chunks, gapMs = 0) {
  const enc = new TextEncoder();
  let i = 0;
  return { body: { getReader: () => ({
    read: async () => { if (i >= chunks.length) return { done: true }; if (gapMs) await sleep(gapMs); return { done: false, value: enc.encode(chunks[i++]) }; },
    cancel: async () => {},
  }) } };
}
const sse = obj => `data: ${JSON.stringify({ response: obj })}\n\n`;
const strip = out => out.replace(/msg_[0-9a-f]+/g, 'msg_X');

console.log('stream timing');
await ok('t_first_thought < t_first_text，均相对 startTime', async () => {
  const chunks = [
    sse({ candidates: [{ content: { parts: [{ text: 'hmm', thought: true }] } }] }),
    sse({ candidates: [{ content: { parts: [{ text: 'Hi' }] }, finishReason: 'STOP' }] }),
  ];
  const calls = [];
  const t0 = Date.now();
  await handleStreamConversion(upstream(chunks, 15), mockRes(), 'm', u => calls.push(u), t0);
  const u = calls[0];
  assert.ok(u.t_first_thought >= 10, 'thought ' + u.t_first_thought);
  assert.ok(u.t_first_text > u.t_first_thought, 'text after thought');
  assert.ok(u.ttft_ms <= u.t_first_thought);
});

await ok('没有思考的响应：t_first_thought 为 null', async () => {
  const calls = [];
  await handleStreamConversion(upstream([sse({ candidates: [{ content: { parts: [{ text: 'Hi' }] } }] })]), mockRes(), 'm', u => calls.push(u), Date.now());
  assert.equal(calls[0].t_first_thought, null);
  assert.ok(calls[0].t_first_text >= 0);
});

await ok('空 text part 不算首字；输出事件流与时间无关（打点不改输出）', async () => {
  const chunks = [
    sse({ candidates: [{ content: { parts: [{ text: '', thought: true, thoughtSignature: 'sig1' }] } }] }),
    sse({ candidates: [{ content: { parts: [{ text: 'a', thought: true }] } }] }),
    sse({ candidates: [{ content: { parts: [{ text: 'b' }] }, finishReason: 'STOP' }] }),
  ];
  const r1 = mockRes(), r2 = mockRes(); const c1 = [];
  await handleStreamConversion(upstream(chunks, 5), r1, 'm', u => c1.push(u), Date.now());
  await handleStreamConversion(upstream(chunks), r2, 'm', () => {}, Date.now());
  assert.equal(strip(r1.out), strip(r2.out));
  assert.ok(c1[0].t_first_thought >= 8, 'empty part skipped: ' + c1[0].t_first_thought);
});

console.log('stats timing');
await ok('median', () => {
  assert.equal(median([]), null);
  assert.equal(median([null, 3, undefined, 1, 2]), 2);
  assert.equal(median([1, 2, 3, 10]), 2.5);
});

await ok('recordRequest 保存 timing，getTimingSummary 取最近 n 条成功请求中位数', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agtiming-'));
  const st = new StatsTracker(tmp, { autoFlushOnExit: false });
  const base = Date.now() - 100000;
  for (let i = 0; i < 25; i++) {
    st.recordRequest({
      email: i % 2 ? 'a@x.com' : 'b@x.com', model: 'gemini-3.8-flash-high', latency_ms: 1000 + i, status: 200, is_stream: true,
      input_tokens: 100, cached_tokens: 900, ttft_ms: 500 + i, now: new Date(base + i * 1000),
      timing: { t_token: i, t_payload: 10 + i, t_headers: 300 + i, t_first_thought: 500 + i, t_first_text: 900 + i,
        host: 'daily-cloudcode-pa.sandbox.googleapis.com', attempts: 1, switched_account: i === 24, switched_host: false, junk: 'x' },
    });
  }
  st.recordRequest({ email: 'a@x.com', model: 'm', latency_ms: 5, status: 502, now: new Date(base + 30000), timing: { attempts: 3 } });
  st.recordRequest({ email: 'a@x.com', model: 'm', latency_ms: 5, status: 200, now: new Date(base + 31000) }); // 无 timing：不计入

  const log = st.getAllLogs(1)[0];
  assert.equal(log.timing, undefined);
  const withT = st.getAllLogs(100).find(l => l.timing && l.status === 200);
  assert.deepEqual(Object.keys(withT.timing).sort(), ['attempts', 'host', 'switched_account', 'switched_host', 't_first_text', 't_first_thought', 't_headers', 't_payload', 't_token']);

  const s = st.getTimingSummary(20); // 最近 20 条成功的：i = 5..24
  assert.equal(s.n, 20);
  assert.equal(s.t_token, 14.5);
  assert.equal(s.t_headers, 314.5);
  assert.equal(s.t_first_text, 914.5);
  assert.equal(s.attempts, 1);
  assert.equal(s.cache_hit_rate, 0.9);
  assert.deepEqual(s.hosts, { 'daily-cloudcode-pa.sandbox.googleapis.com': 20 });
  assert.equal(s.switched_account, 1);
  assert.equal(st.getStats().timing_recent.n, 20);
  fs.rmSync(tmp, { recursive: true, force: true });
});

console.log(`\n${passed} passed`);
