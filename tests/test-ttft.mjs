/**
 * fix/ttft 单元测试：node tests/test-ttft.mjs
 * 每个 describe 对应 PR 的一个 commit。
 */
import assert from 'assert/strict';

let passed = 0;
const ok = (name, fn) => Promise.resolve().then(fn).then(() => { passed++; console.log('  ✓', name); });

console.log('1. 分段打点');
{
  const { splitHeaderTiming, thinkingLevelOf } = await import('../src/timing-split.mjs');
  await ok('wait_headers = 头 − 上传', () => {
    assert.deepEqual(splitHeaderTiming(5000, 1200), { upload_ms: 1200, wait_headers_ms: 3800 });
  });
  await ok('Bun 下上传未知：upload_ms=null，wait 等于头', () => {
    assert.deepEqual(splitHeaderTiming(5000, null), { upload_ms: null, wait_headers_ms: 5000 });
    assert.deepEqual(splitHeaderTiming(5000, undefined), { upload_ms: null, wait_headers_ms: 5000 });
  });
  await ok('上传大于头（时钟抖动）时 wait 不为负', () => {
    assert.equal(splitHeaderTiming(100, 120).wait_headers_ms, 0);
  });
  await ok('thinking_level 从 payload 读出', () => {
    assert.equal(thinkingLevelOf({ request: { generationConfig: { thinkingConfig: { thinkingLevel: 'high' } } } }), 'high');
    assert.equal(thinkingLevelOf({ request: { generationConfig: { thinkingConfig: { thinkingBudget: 0 } } } }), 'budget:0');
    assert.equal(thinkingLevelOf({ request: { generationConfig: {} } }), null);
  });
  const { StatsTracker } = await import('../src/stats.mjs');
  const fs = await import('fs'); const os = await import('os'); const path = await import('path');
  await ok('StatsTracker 保存新字段并给出中位数', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ttft-'));
    const st = new StatsTracker(dir, { autoFlushOnExit: false });
    for (const [up, wait] of [[100, 4000], [200, 6000], [300, 5000]]) {
      st.recordRequest({ email: 'a@x', model: 'm', latency_ms: 9000, status: 200, timing: {
        t_headers: up + wait, upload_ms: up, wait_headers_ms: wait, first_chunk_ms: 7000, first_thought_ms: 7000, first_text_ms: 8000,
        body_bytes: 1400000, host: 'daily-cloudcode-pa.sandbox.googleapis.com', attempts: 1, thinking_level: 'high' } });
    }
    const s = st.getTimingSummary(20);
    assert.equal(s.upload_ms, 200);
    assert.equal(s.wait_headers_ms, 5000);
    assert.equal(s.first_text_ms, 8000);
    assert.equal(s.body_bytes, 1400000);
    const log = st.getAllLogs(1)[0];
    assert.equal(log.timing.thinking_level, 'high');
  });
}

console.log('2. 长上下文回放测速');
{
  const store = await import('../src/replay-store.mjs');
  const { buildReplayPayload, summarizeReplay, parseLevels, parseSafety, hostBench, hostLabel, REPLAY_MAX_OUTPUT_TOKENS } = await import('../src/host-bench.mjs');
  const { ANTIGRAVITY_ENDPOINTS } = await import('../src/constants.mjs');
  const base = { model: 'gemini-3.8-flash-tiered', userAgent: 'antigravity', requestId: 'agent-1', project: 'p',
    request: { contents: [{ role: 'user', parts: [{ text: 'hello' }] }], generationConfig: { maxOutputTokens: 8192, temperature: 0.7, thinkingConfig: { includeThoughts: true, thinkingLevel: 'high' } },
      safetySettings: [{ category: 'HARM_CATEGORY_HARASSMENT', threshold: 'BLOCK_NONE' }], sessionId: '-123', systemInstruction: { parts: [{ text: 'sys' }] } } };

  await ok('replay info 只给元信息，不含内容', () => {
    store.clearReplay();
    assert.equal(store.replayInfo().available, false);
    store.rememberPayload(JSON.stringify(base), { email: 'a@x', model: 'gemini-3.8-flash-high' });
    const info = store.replayInfo();
    assert.equal(info.available, true);
    assert.ok(!JSON.stringify(info).includes('hello'));
    assert.ok(info.body_bytes > 0);
  });
  await ok('回放 payload：只改 requestId 与 maxOutputTokens(≤256)，sessionId/contents 原样', () => {
    const p = buildReplayPayload(base);
    assert.notEqual(p.requestId, base.requestId);
    assert.equal(p.request.generationConfig.maxOutputTokens, REPLAY_MAX_OUTPUT_TOKENS);
    assert.equal(p.request.sessionId, '-123');
    assert.deepEqual(p.request.contents, base.request.contents);
    assert.deepEqual(p.request.safetySettings, base.request.safetySettings);
    assert.equal(base.request.generationConfig.maxOutputTokens, 8192, '不改原对象');
  });
  await ok('level / safety 变体', () => {
    const low = buildReplayPayload(base, { level: 'low', safety: 'off' });
    assert.equal(low.request.generationConfig.thinkingConfig.thinkingLevel, 'low');
    assert.equal(low.request.generationConfig.thinkingConfig.thinkingBudget, 0);
    assert.equal('safetySettings' in low.request, false);
    const on = buildReplayPayload({ ...base, request: { ...base.request, safetySettings: undefined } }, { safety: 'on' });
    assert.equal(on.request.safetySettings.length, 5);
    assert.deepEqual(parseLevels('low,high,bogus'), ['low', 'high']);
    assert.deepEqual(parseLevels(''), [null]);
    assert.deepEqual(parseSafety('off'), ['off']);
  });
  await ok('hostLabel：自定义 URL 显示主机名，不再一律标成 prod', () => {
    assert.deepEqual(ANTIGRAVITY_ENDPOINTS.map(hostLabel), ['daily', 'autopush', 'prod']);
    assert.equal(hostLabel('https://my-proxy.example.com'), 'my-proxy.example.com');
  });
  await ok('startReplay：daily→autopush→prod 交替各 2 轮，同账号同 sessionId，汇总含缓存命中率', async () => {
    const seen = [];
    const enc = new TextEncoder();
    const fetchImpl = async (url, opts) => {
      const body = JSON.parse(opts.body);
      seen.push({ host: hostLabel(url.split('/v1internal')[0]), sid: body.request.sessionId, max: body.request.generationConfig.maxOutputTokens, auth: opts.headers.Authorization });
      const chunks = [
        { candidates: [{ content: { parts: [{ text: 't', thought: true }] } }] },
        { candidates: [{ content: { parts: [{ text: 'x' }] } }], usageMetadata: { promptTokenCount: 1000, cachedContentTokenCount: 990, candidatesTokenCount: 1 } },
      ];
      return { ok: true, status: 200, body: new ReadableStream({ start(c) { for (const ch of chunks) c.enqueue(enc.encode(`data: ${JSON.stringify({ response: ch })}\n\n`)); c.close(); } }) };
    };
    const mgr = { tokenData: { email: 'a@x' }, getValidAccessToken: async () => 'tok-a' };
    const r = hostBench.startReplay(e => (e === 'a@x' ? mgr : null), { fetchImpl });
    assert.equal(r.ok, true);
    while (hostBench.status().running) await new Promise(x => setTimeout(x, 5));
    assert.deepEqual(seen.map(x => x.host), ['daily', 'autopush', 'prod', 'daily', 'autopush', 'prod']);
    assert.ok(seen.every(x => x.sid === '-123' && x.max <= 256 && x.auth === 'Bearer tok-a'));
    const st = hostBench.status();
    assert.equal(st.mode, 'replay');
    assert.equal(st.summary.length, 3);
    assert.equal(st.summary[0].cache_hit_rate, 0.99);
  });
  await ok('原账号不在池里时拒绝回放（不换号）', () => {
    const r = hostBench.startReplay(() => null, {});
    assert.equal(r.ok, false);
  });
  await ok('summarizeReplay 按 host×level×safety 分组', () => {
    const s = summarizeReplay([
      { host: 'daily', level: 'low', safety: 'off', ok: true, t_headers: 10, cache_hit_rate: 0.9 },
      { host: 'daily', level: 'low', safety: 'off', ok: true, t_headers: 30, cache_hit_rate: 0.9 },
      { host: 'daily', level: 'high', safety: 'off', ok: false, status: 500, error: 'x' },
    ]);
    assert.equal(s.length, 2);
    assert.equal(s.find(x => x.level === 'low').t_headers, 20);
  });
}

console.log(`\n${passed} passed`);
