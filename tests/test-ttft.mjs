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

console.log('3. 集群顺序 / 首块超时切换 / host 粘滞与健康度');
{
  const { parseEndpoints, configuredEndpoints, loadTuning, setTuning, tuning } = await import('../src/ag-tuning.mjs');
  const { HostRouter, DEMOTE_MS } = await import('../src/host-router.mjs');
  const { runWithPolicy, Cooldowns } = await import('../src/upstream-policy.mjs');
  const { mapToUpstreamModel } = await import('../src/cloudcode.mjs');
  const { resolveSessionId } = await import('../src/session-router.mjs');
  const fs = await import('fs'); const os = await import('os'); const path = await import('path');
  const DAILY = 'https://daily-cloudcode-pa.sandbox.googleapis.com', AUTO = 'https://autopush-cloudcode-pa.sandbox.googleapis.com', PROD = 'https://cloudcode-pa.googleapis.com';

  await ok('AG_ENDPOINTS 解析：别名、完整 URL、大小写、去重、无效项忽略', () => {
    assert.deepEqual(parseEndpoints('prod,daily,autopush'), [PROD, DAILY, AUTO]);
    assert.deepEqual(parseEndpoints(' PROD , https://x.example.com/ ,bogus,prod,ftp://y'), [PROD, 'https://x.example.com']);
    assert.deepEqual(parseEndpoints(''), []);
  });
  await ok('默认顺序保持 daily,autopush,prod；无效环境变量回退默认；控制台覆盖优先并可清除', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tune-'));
    loadTuning(path.join(dir, 't.json'));
    const old = process.env.AG_ENDPOINTS;
    delete process.env.AG_ENDPOINTS;
    assert.deepEqual(configuredEndpoints(), [DAILY, AUTO, PROD]);
    process.env.AG_ENDPOINTS = 'bogus';
    assert.deepEqual(configuredEndpoints(), [DAILY, AUTO, PROD]);
    process.env.AG_ENDPOINTS = 'prod,daily';
    assert.deepEqual(configuredEndpoints(), [PROD, DAILY]);
    assert.equal(setTuning('AG_ENDPOINTS', 'autopush').ok, true);
    assert.deepEqual(configuredEndpoints(), [AUTO]);
    assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 't.json'), 'utf8')).AG_ENDPOINTS, 'autopush');
    assert.equal(setTuning('AG_ENDPOINTS', 'nope').ok, false);
    setTuning('AG_ENDPOINTS', '');
    assert.deepEqual(configuredEndpoints(), [PROD, DAILY]);
    if (old === undefined) delete process.env.AG_ENDPOINTS; else process.env.AG_ENDPOINTS = old;
    assert.equal(tuning('AG_FIRST_CHUNK_FAILOVER_MS'), '0', '默认关闭');
  });

  const mk = email => ({ tokenData: { email, projectId: 'p' } });
  const okResp = () => ({ ok: true, status: 200, text: async () => '', headers: { get: () => null } });
  const timeoutErr = ms => Object.assign(new Error(`upstream header timeout ${ms}ms`), { name: 'TimeoutError' });
  function run({ rule, failoverMs = 30000, hosts = [DAILY, AUTO, PROD], allowDowngrade = true }) {
    const calls = [];
    let t = 0;
    const cd = new Cooldowns(() => t);
    const req = { model: 'gemini-3.8-flash-high', messages: [{ role: 'user', content: 'hi' }] };
    const p = runWithPolicy({
      model: req.model, anthropicReq: req, upstreamOf: mapToUpstreamModel,
      accounts: () => ['a', 'b'].map(mk), activeEmail: 'a', quotaOf: () => null, cooldowns: cd,
      buildPayload: (model, m) => ({ model: mapToUpstreamModel(model), requestId: 'r', request: { sessionId: resolveSessionId(req, m.tokenData.email), contents: [] } }),
      send: async (payload, m, host, timeoutMs) => {
        calls.push({ host, email: m.tokenData.email, sid: payload.request.sessionId, model: payload.model, timeoutMs });
        const r = rule(calls.length - 1, host, timeoutMs);
        if (r instanceof Error) { t += timeoutMs; throw r; }
        return r;
      },
      hosts, chain: ['gemini-3.6-flash-high'], allowDowngrade, headerTimeoutMs: 180000, deadlineMs: 90000, failoverMs,
      now: () => t, sleep: async ms => { t += ms; }, startedAt: 0,
    });
    return p.then(r => ({ r, calls }));
  }

  await ok('首块超时：第一次尝试用短超时，超时后同账号、同 sessionId 换下一个 host，成功', async () => {
    const { r, calls } = await run({ rule: (n, host, to) => (n === 0 ? timeoutErr(to) : okResp()) });
    assert.equal(r.ok, true);
    assert.equal(r.failover, true);
    assert.deepEqual(calls.map(c => c.host), [DAILY, AUTO]);
    assert.deepEqual(calls.map(c => c.timeoutMs), [30000, 180000]);
    assert.ok(calls.every(c => c.email === 'a' && c.sid === calls[0].sid));
    assert.equal(r.switchedAccount, false);
  });
  await ok('首块超时只切换一次：第二个 host 也超时 → 返回错误，不换号、不降级、不再换 host', async () => {
    const { r, calls } = await run({ rule: (n, host, to) => timeoutErr(to) });
    assert.equal(r.ok, false);
    assert.equal(calls.length, 2);
    assert.deepEqual(calls.map(c => c.host), [DAILY, AUTO]);
    assert.ok(calls.every(c => c.email === 'a' && c.model === 'gemini-3.8-flash-tiered'));
    assert.equal(r.downgraded, false);
  });
  await ok('已开始吐字后绝不重发：拿到响应头即返回，流再慢也只发 1 次', async () => {
    let pulls = 0;
    const slowBody = new ReadableStream({ async pull(c) { pulls++; await new Promise(x => setTimeout(x, 20)); if (pulls > 3) c.close(); else c.enqueue(new TextEncoder().encode('data: {}\n\n')); } });
    const { r, calls } = await run({ failoverMs: 5, rule: () => ({ ...okResp(), body: slowBody }) });
    assert.equal(r.ok, true);
    assert.equal(r.failover, false);
    assert.equal(calls.length, 1);
    const reader = r.response.body.getReader();
    while (!(await reader.read()).done) { /* 消费完 */ }
    assert.equal(calls.length, 1, '读流期间没有任何重发');
  });
  await ok('failoverMs=0（默认）：行为与原来一致，单次超时用原超时', async () => {
    const { calls } = await run({ failoverMs: 0, rule: (n, h, to) => (n === 0 ? timeoutErr(to) : okResp()) });
    assert.equal(calls[0].timeoutMs, 180000);
  });
  await ok('只有一个 host 时不触发切换', async () => {
    const { calls } = await run({ hosts: [PROD], rule: () => okResp() });
    assert.equal(calls[0].timeoutMs, 180000);
  });

  await ok('host 粘滞：同会话固定 host，TTL 过期后回到配置顺序；未绑定会话按配置顺序', () => {
    let t = 0;
    const hr = new HostRouter({ now: () => t, endpoints: () => [DAILY, AUTO, PROD], healthEnabled: () => false, ttlMs: 1000 });
    assert.deepEqual(hr.orderFor('k'), [DAILY, AUTO, PROD]);
    hr.bind('k', AUTO);
    assert.deepEqual(hr.orderFor('k'), [AUTO, DAILY, PROD]);
    assert.deepEqual(hr.orderFor('other'), [DAILY, AUTO, PROD]);
    t += 1001;
    assert.deepEqual(hr.orderFor('k'), [DAILY, AUTO, PROD]);
  });
  await ok('健康度：同体积档中位数 > 2 倍时降权 10 分钟（只影响未粘滞会话），恢复后取消', () => {
    let t = 0, on = true;
    const hr = new HostRouter({ now: () => t, endpoints: () => [DAILY, AUTO, PROD], healthEnabled: () => on, ttlMs: 60 * 60 * 1000 });
    hr.bind('sticky', DAILY);
    const big = 2 * 1024 * 1024;
    for (let i = 0; i < 3; i++) hr.record(AUTO, 10000, big);
    for (let i = 0; i < 3; i++) hr.record(DAILY, 60000, big);
    assert.deepEqual(hr.orderFor('new'), [AUTO, PROD, DAILY]);
    assert.deepEqual(hr.orderFor('sticky')[0], DAILY, '粘滞会话不受降权影响');
    for (let i = 0; i < 3; i++) hr.record(DAILY, 1000, 1000);
    assert.deepEqual(hr.orderFor('new'), [AUTO, PROD, DAILY], '小请求样本不参与大请求档比较');
    t += DEMOTE_MS + 1;
    assert.deepEqual(hr.orderFor('new'), [DAILY, AUTO, PROD]);
    on = false;
    for (let i = 0; i < 5; i++) hr.record(DAILY, 999999, big);
    assert.deepEqual(hr.orderFor('new'), [DAILY, AUTO, PROD], 'AG_HOST_HEALTH=0 不降权');
  });
}

console.log('4. safetySettings 可选');
{
  const { buildCloudCodePayload } = await import('../src/cloudcode.mjs');
  const { setTuning } = await import('../src/ag-tuning.mjs');
  const req = { model: 'gemini-3.8-flash-high', max_tokens: 1000, messages: [{ role: 'user', content: 'hello' }] };
  await ok('默认 block_none：与原来一样发送 5 条 BLOCK_NONE', () => {
    setTuning('AG_SAFETY_SETTINGS', '');
    const p = buildCloudCodePayload(req, 'proj');
    assert.equal(p.request.safetySettings.length, 5);
    assert.ok(p.request.safetySettings.every(x => x.threshold === 'BLOCK_NONE'));
  });
  await ok('off：payload 里没有 safetySettings（序列化后也没有）', () => {
    setTuning('AG_SAFETY_SETTINGS', 'off');
    const p = buildCloudCodePayload(req, 'proj');
    assert.equal('safetySettings' in p.request, false);
    assert.ok(!JSON.stringify(p).includes('safetySettings'));
    setTuning('AG_SAFETY_SETTINGS', '');
  });
  await ok('环境变量生效，无效值回退默认', () => {
    process.env.AG_SAFETY_SETTINGS = 'off';
    assert.equal('safetySettings' in buildCloudCodePayload(req, 'proj').request, false);
    process.env.AG_SAFETY_SETTINGS = 'weird';
    assert.equal(buildCloudCodePayload(req, 'proj').request.safetySettings.length, 5);
    delete process.env.AG_SAFETY_SETTINGS;
  });
}

console.log(`\n${passed} passed`);
