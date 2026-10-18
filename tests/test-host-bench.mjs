// PR3 前置：集群测速模块测试（注入 mock fetch，不访问网络）
import assert from 'assert';
import { measureOnce, summarize, hostLabel, hostBench } from '../src/host-bench.mjs';
import { ANTIGRAVITY_ENDPOINTS } from '../src/constants.mjs';

const sleep = ms => new Promise(r => setTimeout(r, ms));
const enc = new TextEncoder();

function sseResponse(chunks, delay = 20) {
  const body = new ReadableStream({
    async start(c) {
      for (const ch of chunks) { await sleep(delay); c.enqueue(enc.encode(`data: ${JSON.stringify({ response: ch })}\n\n`)); }
      c.close();
    },
  });
  return { ok: true, status: 200, body, text: async () => '' };
}

const okChunks = [
  { candidates: [{ content: { parts: [{ text: '想', thought: true }] } }] },
  { candidates: [{ content: { parts: [{ text: '正文一' }] } }] },
  { candidates: [{ content: { parts: [{ text: '正文二' }] } }], usageMetadata: { promptTokenCount: 50, candidatesTokenCount: 300, thoughtsTokenCount: 100 } },
];

let passed = 0;
const t = async (name, fn) => { await fn(); passed++; console.log('  ✓', name); };

console.log('test-host-bench');

await t('hostLabel', () => {
  assert.deepStrictEqual(ANTIGRAVITY_ENDPOINTS.map(hostLabel), ['daily', 'autopush', 'prod']);
});

await t('measureOnce 成功流：打点与速度', async () => {
  const r = await measureOnce({ host: ANTIGRAVITY_ENDPOINTS[0], payload: {}, accessToken: 'x', fetchImpl: async () => sseResponse(okChunks) });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.status, 200);
  assert.ok(r.t_first_thought <= r.t_first_text);
  assert.strictEqual(r.t_first_chunk, r.t_first_thought);
  assert.strictEqual(r.output_tokens, 400);
  assert.strictEqual(r.thoughts_tokens, 100);
  assert.strictEqual(r.text_tokens, 300);
  assert.ok(r.gen_tps > 0 && r.text_tps > 0);
});

await t('measureOnce 429 记录状态与错误', async () => {
  const r = await measureOnce({ host: ANTIGRAVITY_ENDPOINTS[2], payload: {}, accessToken: 'x', fetchImpl: async () => ({ ok: false, status: 429, text: async () => 'RESOURCE_EXHAUSTED quota' }) });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.status, 429);
  assert.match(r.error, /RESOURCE_EXHAUSTED/);
  assert.strictEqual(r.host, 'prod');
});

await t('measureOnce 超时', async () => {
  const r = await measureOnce({ host: ANTIGRAVITY_ENDPOINTS[1], payload: {}, accessToken: 'x', timeoutMs: 50,
    fetchImpl: (u, o) => new Promise((_, rej) => o.signal.addEventListener('abort', () => { const e = new Error('aborted'); e.name = 'AbortError'; rej(e); })) });
  assert.strictEqual(r.ok, false);
  assert.match(r.error, /超时/);
});

await t('summarize 取中位数、失败集群带错误', () => {
  const s = summarize([
    { host: 'daily', ok: true, status: 200, t_first_chunk: 100, t_first_text: 200, total_ms: 1000, gen_tps: 100, text_tps: 90 },
    { host: 'daily', ok: true, status: 200, t_first_chunk: 300, t_first_text: 400, total_ms: 3000, gen_tps: 120, text_tps: 110 },
    { host: 'prod', ok: false, status: 403, error: 'PERMISSION_DENIED' },
  ]);
  const d = s.find(x => x.host === 'daily');
  assert.strictEqual(d.t_first_chunk, 200);
  assert.strictEqual(d.gen_tps, 110);
  const p = s.find(x => x.host === 'prod');
  assert.strictEqual(p.ok, 0);
  assert.strictEqual(p.error, 'PERMISSION_DENIED');
});

await t('hostBench 交替轮询三个集群、主模型 payload 不变', async () => {
  const seen = [];
  const mgr = { tokenData: { email: 'a@b.c', projectId: 'proj-1' }, getValidAccessToken: async () => 'tok' };
  const fetchImpl = async (url, opts) => { seen.push({ url, body: JSON.parse(opts.body) }); return sseResponse(okChunks, 1); };
  assert.strictEqual(hostBench.start(mgr, { rounds: 2, fetchImpl }), true);
  assert.strictEqual(hostBench.start(mgr, { rounds: 2, fetchImpl }), false); // 并发保护
  while (hostBench.status().running) await sleep(10);
  const st = hostBench.status();
  assert.strictEqual(st.runs.length, 6);
  assert.deepStrictEqual(st.runs.map(r => r.host), ['daily', 'autopush', 'prod', 'daily', 'autopush', 'prod']);
  for (const { url, body } of seen) {
    assert.ok(url.endsWith('/v1internal:streamGenerateContent?alt=sse'));
    assert.strictEqual(body.model, 'gemini-3.8-flash-tiered');
    assert.strictEqual(body.project, 'proj-1');
    assert.deepStrictEqual(body.request.generationConfig.thinkingConfig, { includeThoughts: true, thinkingLevel: 'high' });
  }
  assert.strictEqual(st.summary.length, 3);
  assert.ok(st.summary.every(s => s.ok === 2));
});

console.log(`  ${passed} passed`);
