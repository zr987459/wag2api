/**
 * 历史锁定防串台：node tests/test-history-pin.mjs
 * - 没有真实会话 id 时用「首条用户消息 + 首条模型回复」做指纹（固定前缀的客户端不会撞 key）
 * - 同一会话 id 下，两个不同对话的模型回复/首条提示/系统提示不会互相替换
 * - 客户端剥掉思考块或签名、裁剪工具结果时，仍然能还原（原有的缓存保护还在）
 */
import assert from 'assert/strict';
import { buildCloudCodePayload } from '../src/cloudcode.mjs';
import { nearSameText, sameVisibleParts, looksTrimmed } from '../src/history-pin.mjs';
import { fallbackConvSeed } from '../src/content-converter.mjs';

let passed = 0;
const ok = (name, fn) => { fn(); passed++; console.log('  ✓', name); };
const M = 'gemini-3.8-flash-high';
const texts = p => JSON.stringify(p.request?.contents ?? p.contents ?? p);
const sysOf = p => JSON.stringify(p.request?.systemInstruction ?? p.systemInstruction ?? null);

ok('无会话 id + 相同首条消息：第二个对话不会拿到第一个对话的模型回复', () => {
  const prefix = '<env>cwd=/repo</env>';
  const a = { model: M, max_tokens: 100, system: 'SYS', messages: [
    { role: 'user', content: prefix }, { role: 'assistant', content: '签名密钥安全说明' }, { role: 'user', content: 'Q1' }] };
  const b = { model: M, max_tokens: 100, system: 'SYS', messages: [
    { role: 'user', content: prefix }, { role: 'assistant', content: 'Dockerfile 漏拷前端资源' }, { role: 'user', content: '可以，改完让hark审一下' }] };
  buildCloudCodePayload(a, 'proj');
  const out = texts(buildCloudCodePayload(b, 'proj'));
  assert.ok(out.includes('Dockerfile 漏拷前端资源'));
  assert.ok(!out.includes('签名密钥安全说明'));
});

ok('同一个固定会话 id、两个不同对话：模型回复与首条提示互不替换', () => {
  const mk = (first, reply, last) => ({ model: M, max_tokens: 100, system: 'SYS', _gwSessionKey: 'client:fixed-device',
    messages: [{ role: 'user', content: first }, { role: 'assistant', content: reply }, { role: 'user', content: last }] });
  buildCloudCodePayload(mk('聊签名', '签名密钥安全说明', 'Q1'), 'proj');
  const out = texts(buildCloudCodePayload(mk('聊部署', 'Dockerfile 漏拷前端资源', 'Q2'), 'proj'));
  assert.ok(out.includes('Dockerfile 漏拷前端资源') && out.includes('聊部署'));
  assert.ok(!out.includes('签名密钥安全说明') && !out.includes('聊签名'));
});

ok('同一会话：客户端剥掉思考块/签名时仍还原首见版本', () => {
  const base = { model: M, max_tokens: 100, system: 'SYS', _gwSessionKey: 'client:strip' };
  const full = { ...base, messages: [{ role: 'user', content: 'hi' },
    { role: 'assistant', content: [{ type: 'thinking', thinking: '想一想', signature: 'SIG1' }, { type: 'text', text: '答复' }] },
    { role: 'user', content: 'next' }] };
  const stripped = { ...base, messages: [{ role: 'user', content: 'hi' },
    { role: 'assistant', content: [{ type: 'text', text: '答复' }] }, { role: 'user', content: 'next' }] };
  const a = texts(buildCloudCodePayload(full, 'proj'));
  const b = texts(buildCloudCodePayload(stripped, 'proj'));
  assert.ok(b.includes('SIG1'));
  assert.equal(a, b);
});

ok('同一会话：系统提示只改时间戳 → 还原；整段换掉 → 用新的', () => {
  const long = '你是助手。'.repeat(60);
  const mk = sys => ({ model: M, max_tokens: 100, system: sys, _gwSessionKey: 'client:sys', messages: [{ role: 'user', content: 'x' }] });
  buildCloudCodePayload(mk(long + ' now=10:00'), 'proj');
  assert.ok(sysOf(buildCloudCodePayload(mk(long + ' now=10:05'), 'proj')).includes('now=10:00'));
  assert.ok(sysOf(buildCloudCodePayload(mk('完全不同的系统提示'), 'proj')).includes('完全不同的系统提示'));
});

ok('无会话 id：同一对话里客户端剥掉思考块/签名，仍能还原（OpenAI 客户端也有锁定保护）', () => {
  const base = { model: M, max_tokens: 100, system: 'SYS' };
  const full = { ...base, messages: [{ role: 'user', content: '<env>fixed</env>' },
    { role: 'assistant', content: [{ type: 'thinking', thinking: '想', signature: 'SIG-OAI' }, { type: 'text', text: '第一条回复A' }] },
    { role: 'user', content: 'go' }] };
  const stripped = { ...base, messages: [{ role: 'user', content: '<env>fixed</env>' },
    { role: 'assistant', content: '第一条回复A' }, { role: 'user', content: 'go' }] };
  const a = texts(buildCloudCodePayload(full, 'proj'));
  const b = texts(buildCloudCodePayload(stripped, 'proj'));
  assert.ok(b.includes('SIG-OAI'));
  assert.equal(a, b);
});

ok('会话指纹：首轮为空；剥思考块不变；首条回复不同则不同', () => {
  assert.equal(fallbackConvSeed([{ role: 'user', content: 'x' }]), '');
  const s1 = fallbackConvSeed([{ role: 'user', content: 'p' }, { role: 'assistant', content: [{ type: 'thinking', thinking: 't' }, { type: 'text', text: 'A ' }] }]);
  const s2 = fallbackConvSeed([{ role: 'user', content: 'p' }, { role: 'assistant', content: 'A' }, { role: 'user', content: 'more' }]);
  const s3 = fallbackConvSeed([{ role: 'user', content: 'p' }, { role: 'assistant', content: 'B' }]);
  assert.equal(s1, s2);
  assert.notEqual(s1, s3);
});

ok('校验函数', () => {
  assert.ok(nearSameText('a  b\r\n', 'a b'));
  assert.ok(!nearSameText('聊签名', '聊部署'));
  assert.ok(sameVisibleParts([{ thought: true, text: 't' }, { text: 'x' }], [{ text: 'x ' }]));
  assert.ok(!sameVisibleParts([{ text: 'x' }], [{ text: 'y' }]));
  assert.ok(looksTrimmed('long output', '[内容已清除]'));
  assert.ok(looksTrimmed('long output', 'long'));
  assert.ok(!looksTrimmed('ok', '完全不同而且更长的另一个工具结果内容，不应被替换成旧的'.repeat(10)));
});

console.log(`\n${passed} passed`);
