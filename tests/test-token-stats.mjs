/**
 * Token 消费统计测试：node tests/test-token-stats.mjs
 * 校验 getTokenStats 在不同时间粒度（hour/day/week/month/all）下的聚合、
 * 模型分布与 share、账号排行与 top_model、峰值时段 peak、91 天热力图及旧格式容错。
 */
import assert from 'assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { StatsTracker, utcHourKey, utcDayKey } from '../src/stats.mjs';

let passed = 0;
const ok = (name, fn) => Promise.resolve().then(fn).then(() => { passed++; console.log('  ✓', name); });

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-token-stats-'));
const st = new StatsTracker(tmp, { autoFlushOnExit: false });

// 固定基准时间：2026-10-29 12:30:00 UTC
const now = new Date('2026-10-29T12:30:00.000Z');
const tMinus10m = new Date(now.getTime() - 10 * 60 * 1000); // 12:20 (在同一 hour 窗口内，不同 5m 桶)
const tMinus2h  = new Date(now.getTime() - 2 * 3600 * 1000); // 10:30 (超出 1h，在 24h 内)
const tMinus2d  = new Date(now.getTime() - 2 * 86400000);    // 2 天前 (在 week / month / all 内)

// 注入测试数据
// 1. alice: 最近请求 (12:30)，model_used 优先
st.recordRequest({
  email: 'alice@test.com',
  model: 'claude-3-5-sonnet',
  model_used: 'claude-3-5-sonnet-20241022',
  status: 200,
  latency_ms: 400,
  ttft_ms: 150,
  input_tokens: 100,
  cached_tokens: 50,
  output_tokens: 200,
  thoughts_tokens: 50, // total = 350
  now,
});

// 2. bob: 10 分钟前请求 (12:20)，较大 token 量
st.recordRequest({
  email: 'bob@test.com',
  model: 'gemini-1.5-pro',
  model_used: 'gemini-1.5-pro',
  status: 200,
  latency_ms: 600,
  ttft_ms: 200,
  input_tokens: 300,
  cached_tokens: 100,
  output_tokens: 600,
  thoughts_tokens: 0, // total = 1000
  now: tMinus10m,
});

// 3. alice: 2 小时前一条错误请求 (10:30)
st.recordRequest({
  email: 'alice@test.com',
  model: 'claude-3-5-sonnet',
  model_used: 'claude-3-5-sonnet-20241022',
  status: 500,
  error: 'upstream_error',
  latency_ms: 100,
  input_tokens: 50,
  cached_tokens: 0,
  output_tokens: 100,
  thoughts_tokens: 0, // total = 150
  now: tMinus2h,
});

// 4. charlie: 2 天前请求
st.recordRequest({
  email: 'charlie@test.com',
  model: 'gpt-4o',
  status: 200,
  latency_ms: 500,
  input_tokens: 400,
  cached_tokens: 100,
  output_tokens: 500,
  thoughts_tokens: 0, // total = 1000
  now: tMinus2d,
});

console.log('token stats series & range');
await ok('series 长度：hour=12, day=24, week=7, month=30, all 自适应', () => {
  const h = st.getTokenStats({ range: 'hour', now });
  assert.equal(h.series.length, 12);
  assert.equal(h.range, 'hour');
  assert.equal(h.timezone, 'UTC');

  const d = st.getTokenStats({ range: 'day', now });
  assert.equal(d.series.length, 24);
  assert.equal(d.range, 'day');

  const w = st.getTokenStats({ range: 'week', now });
  assert.equal(w.series.length, 7);
  assert.equal(w.range, 'week');

  const m = st.getTokenStats({ range: 'month', now });
  assert.equal(m.series.length, 30);
  assert.equal(m.range, 'month');

  const a = st.getTokenStats({ range: 'all', now });
  assert.ok(a.series.length >= 2 && a.series.length <= 92);
  assert.equal(a.range, 'all');
});

console.log('models breakdown & share');
await ok('models 排序与 share 占比降序计算正确（优先取 model_used）', () => {
  const d = st.getTokenStats({ range: 'day', now });
  // 近 24 小时总 token：bob (1000) + alice (350 + 150 = 500) = 1500
  assert.equal(d.summary.tokens, 1500);
  assert.equal(d.models.length, 2);

  // 第一名：gemini-1.5-pro (1000 tokens)
  const m1 = d.models[0];
  assert.equal(m1.model, 'gemini-1.5-pro');
  assert.equal(m1.tokens, 1000);
  assert.equal(m1.requests, 1);
  assert.equal(m1.errors, 0);
  assert.equal(m1.share, Math.round((1000 / 1500) * 10000) / 10000); // 0.6667

  // 第二名：claude-3-5-sonnet-20241022 (500 tokens)
  const m2 = d.models[1];
  assert.equal(m2.model, 'claude-3-5-sonnet-20241022');
  assert.equal(m2.tokens, 500);
  assert.equal(m2.requests, 2);
  assert.equal(m2.errors, 1);
  assert.equal(m2.share, Math.round((500 / 1500) * 10000) / 10000); // 0.3333
});

console.log('accounts breakdown & top_model');
await ok('accounts 聚合、排序与 top_model 准确性', () => {
  const d = st.getTokenStats({ range: 'day', now });
  assert.equal(d.accounts.length, 2);

  // bob tokens 1000 > alice tokens 500
  const a1 = d.accounts[0];
  assert.equal(a1.email, 'bob@test.com');
  assert.equal(a1.tokens, 1000);
  assert.equal(a1.top_model, 'gemini-1.5-pro');
  assert.equal(a1.share, Math.round((1000 / 1500) * 10000) / 10000);
  assert.equal(a1.cache_hit_rate, 100 / 400);

  const a2 = d.accounts[1];
  assert.equal(a2.email, 'alice@test.com');
  assert.equal(a2.tokens, 500);
  assert.equal(a2.errors, 1);
  assert.equal(a2.top_model, 'claude-3-5-sonnet-20241022');
});

console.log('peak detection');
await ok('peak 峰值时段检测', () => {
  // hour 范围内，bob 在 12:20 产生 1000 tokens，alice 在 12:30 产生 350 tokens
  const h = st.getTokenStats({ range: 'hour', now });
  assert.ok(h.peak);
  assert.equal(h.peak.tokens, 1000);
  assert.equal(h.peak.requests, 1);

  // 无数据范围 peak 为 null
  const emptyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-empty-'));
  const emptySt = new StatsTracker(emptyDir, { autoFlushOnExit: false });
  const emptyRes = emptySt.getTokenStats({ range: 'day', now });
  assert.equal(emptyRes.peak, null);
  assert.equal(emptyRes.summary.tokens, 0);
  fs.rmSync(emptyDir, { recursive: true, force: true });
});

console.log('heatmap 91 days');
await ok('heatmap 长度恒定 91 天，无数据天填 0，当天有数据', () => {
  const d = st.getTokenStats({ range: 'day', now });
  assert.equal(d.heatmap.length, 91);
  const todayEntry = d.heatmap[d.heatmap.length - 1];
  assert.equal(todayEntry.day, '2026-10-29');
  assert.equal(todayEntry.tokens, 1500);
  assert.equal(todayEntry.requests, 3);

  // 90 天前没有数据
  const oldestEntry = d.heatmap[0];
  assert.equal(oldestEntry.tokens, 0);
  assert.equal(oldestEntry.requests, 0);
});

console.log('legacy slot tolerance');
await ok('旧格式槽（无 models 字段）容错不报错，数据正常汇总', () => {
  // 注入旧版槽数据（缺少 models 字段）
  st.userStats['legacy@test.com'] = {
    schema: 2,
    total_requests: 1,
    success_requests: 1,
    error_requests: 0,
    input_tokens: 50,
    cached_tokens: 50,
    output_tokens: 100,
    thoughts_tokens: 0,
    total_tokens: 200,
    latency_sum_ms: 100,
    latency_count: 1,
    avg_latency_ms: 100,
    ttft_sum_ms: 50,
    ttft_count: 1,
    avg_ttft_ms: 50,
    logs: [],
    downgrades: [],
    minutely: {
      '2026-10-29T12:29': { requests: 1, errors: 0, input: 50, cached: 50, output: 100, tokens: 200, thoughts: 0, lat_sum: 100, lat_n: 1, ttft_sum: 50, ttft_n: 1 }
    },
    hourly: {
      [utcHourKey(now)]: { requests: 1, errors: 0, input: 50, cached: 50, output: 100, tokens: 200, thoughts: 0, lat_sum: 100, lat_n: 1, ttft_sum: 50, ttft_n: 1 }
    },
    daily: {
      [utcDayKey(now)]: { requests: 1, errors: 0, input: 50, cached: 50, output: 100, tokens: 200, thoughts: 0, lat_sum: 100, lat_n: 1, ttft_sum: 50, ttft_n: 1 }
    }
  };

  const d = st.getTokenStats({ range: 'day', now });
  assert.ok(d);
  // legacy 账号也能正常统计到 accounts 里，top_model 为 null，不抛异常
  const legacyAcc = d.accounts.find(a => a.email === 'legacy@test.com');
  assert.ok(legacyAcc);
  assert.equal(legacyAcc.tokens, 200);
  assert.equal(legacyAcc.top_model, null);
});

fs.rmSync(tmp, { recursive: true, force: true });
console.log(`\n${passed} passed`);
