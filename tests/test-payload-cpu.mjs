/**
 * PR5 组包 CPU：node tests/test-payload-cpu.mjs
 * - historyPin：字符串直存、对象首次命中后冻结复用；返回内容与改前一致，restored 计数一致
 * - cacheProbe：record 不在调用栈里做哈希（setImmediate 之后才出现在报告里），结果与同步计算一致
 * - buildCloudCodePayload 多轮（含客户端改写历史）输出稳定
 */
import assert from 'assert/strict';
import { historyPin } from '../src/history-pin.mjs';
import { cacheProbe } from '../src/cache-probe.mjs';
import { buildCloudCodePayload } from '../src/cloudcode.mjs';

let passed = 0;
const ok = async (name, fn) => { await fn(); passed++; console.log('  ✓', name); };

await ok('字符串：命中返回首见内容，改写计入 restored', () => {
  const r0 = historyPin.stats().restored;
  assert.equal(historyPin.pin('t:s', 'abc'), 'abc');
  assert.equal(historyPin.pin('t:s', 'abc'), 'abc');
  assert.equal(historyPin.pin('t:s', '[内容已清除]'), 'abc');
  assert.equal(historyPin.stats().restored, r0 + 1);
});

await ok('对象：命中返回同一个冻结对象，内容与首见一致', () => {
  const v = { b: 1, a: [1, { c: 'x' }] };
  assert.equal(historyPin.pin('t:o', v), v);
  const h1 = historyPin.pin('t:o', { b: 1, a: [1, { c: 'x' }] });
  const h2 = historyPin.pin('t:o', { b: 2 });
  assert.equal(h1, h2);
  assert.equal(JSON.stringify(h1), JSON.stringify(v));
  assert.ok(Object.isFrozen(h1) && Object.isFrozen(h1.a[1]));
  v.b = 99; // 首见对象之后被改，不影响已存内容
  assert.equal(historyPin.pin('t:o', {}).b, 1);
});

await ok('cacheProbe.record 推迟到 setImmediate，结果与同步一致', async () => {
  const p = buildCloudCodePayload({ model: 'gemini-3.8-flash-high', max_tokens: 100, messages: [{ role: 'user', content: 'hi probe' }, { role: 'assistant', content: 'yo' }, { role: 'user', content: 'again' }], _gwSessionKey: 'probe' }, 'proj');
  const before = cacheProbe.report().length;
  cacheProbe.record('p@x', 'm', p);
  assert.equal(cacheProbe.report().length, before);
  await new Promise(r => setImmediate(r));
  const a = cacheProbe.report()[0];
  cacheProbe.recordSync('p@x', 'm', p);
  const b = cacheProbe.report()[0];
  assert.equal(a.n, 3);
  assert.deepEqual(a.segs, undefined); // report 不带 segs
  assert.equal(b.match, 3);            // 第二次与第一次逐段一致
  assert.equal(a.sid, p.request.sessionId);
});

await ok('多轮 + 客户端改写工具结果：输出稳定', () => {
  const mk = (n, cut) => {
    const m = [{ role: 'user', content: 'start cpu' }];
    for (let i = 0; i < n; i++) {
      m.push({ role: 'assistant', content: [{ type: 'thinking', thinking: 'th' + i, signature: 's' + i }, { type: 'tool_use', id: 'u' + i, name: 'f', input: { i } }] });
      m.push({ role: 'user', content: [{ type: 'tool_result', tool_use_id: 'u' + i, content: cut && i === 0 ? '[内容已清除]' : 'r' + i }] });
    }
    return { model: 'gemini-3.8-flash-high', max_tokens: 100, messages: m, _gwSessionKey: 'cpu-conv' };
  };
  const s = p => { const c = { ...p }; delete c.requestId; return JSON.stringify(c); };
  const a = s(buildCloudCodePayload(mk(3), 'proj'));
  const b = s(buildCloudCodePayload(mk(3, true), 'proj'));
  const c = s(buildCloudCodePayload(mk(3), 'proj'));
  assert.equal(a, b);
  assert.equal(a, c);
});

console.log(`\n${passed} passed`);
