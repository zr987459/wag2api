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

console.log(`\n${passed} passed`);
