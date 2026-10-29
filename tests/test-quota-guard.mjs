/**
 * Tests for Quota Guard: Quota Protection, Weekly Pre-warm, and Scheduling Persistence
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { AccountPool } from '../src/account-pool.mjs';
import {
  shouldPrewarmFamily,
  prewarmAccountFamily,
  refreshAllQuotasOnce,
  setLastPrewarm,
  getLastPrewarm,
  clearLastPrewarms,
  findClaudeSonnetModel,
  PREWARM_DEDUPE_MS,
} from '../src/quota-refresher.mjs';

function makeTempDir() {
  const d = path.join(os.tmpdir(), `test-quota-guard-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  fs.mkdirSync(d, { recursive: true });
  return d;
}

function mockManager(email, refreshToken = 'fake-refresh-token', projectId = 'proj-test') {
  return {
    tokenData: {
      email,
      refreshToken,
      projectId,
      accessToken: 'mock-access-token',
      expiresAt: Date.now() + 3600000,
    },
    getValidAccessToken: async () => 'mock-access-token',
    getStatus: () => ({
      email,
      hasRefreshToken: true,
      hasAccessToken: true,
      expiresInMinutes: 60,
      projectId,
    }),
  };
}

let passed = 0;
async function test(name, fn) {
  try {
    await fn();
    console.log(`  ✓ ${name}`);
    passed++;
  } catch (err) {
    console.error(`  ✗ ${name}`);
    console.error(err);
    process.exit(1);
  }
}

console.log('🧪 开始运行配额保护与周额度预热单元测试...');

// ==================== 1. 配额保护跳过与恢复 ====================
await test('配额保护：<= 2% 的账号直接跳过，未受保护账号正常被选', () => {
  const dir = makeTempDir();
  const pool = new AccountPool(dir);
  pool.managers.set('acc1@test.com', mockManager('acc1@test.com'));
  pool.managers.set('acc2@test.com', mockManager('acc2@test.com'));
  pool.setScheduling({ mode: 'balance' });

  // acc1 Gemini 配额 1% (<= 2%)，acc2 Gemini 配额 50%
  pool.updateQuota('acc1@test.com', { gemini: 0.01 });
  pool.updateQuota('acc2@test.com', { gemini: 0.50 });

  assert.equal(pool.isFamilyProtected('acc1@test.com', 'gemini'), true);
  assert.equal(pool.isFamilyProtected('acc2@test.com', 'gemini'), false);
  assert.deepEqual(pool.getProtectedFamilies('acc1@test.com'), ['gemini']);
  assert.deepEqual(pool.getProtectedFamilies('acc2@test.com'), []);

  // 调度必须直接跳过 acc1，选择 acc2
  const picked = pool.pickManager('', new Set(), { model: 'gemini-3.8-flash' });
  assert.equal(picked.tokenData.email, 'acc2@test.com');

  // poolStatus 包含 protected_families
  const st = pool.poolStatus();
  const stAcc1 = st.find(s => s.email === 'acc1@test.com');
  const stAcc2 = st.find(s => s.email === 'acc2@test.com');
  assert.deepEqual(stAcc1.protected_families, ['gemini']);
  assert.deepEqual(stAcc2.protected_families, []);
});

await test('配额保护：固定账号与会话粘滞均不得选用受保护账号', () => {
  const dir = makeTempDir();
  const pool = new AccountPool(dir);
  pool.managers.set('acc1@test.com', mockManager('acc1@test.com'));
  pool.managers.set('acc2@test.com', mockManager('acc2@test.com'));

  pool.updateQuota('acc1@test.com', { gemini: 0.01 });
  pool.updateQuota('acc2@test.com', { gemini: 0.60 });

  // 模式 1: fixed 锁定 acc1，但 acc1 受保护 -> 降级跳过选 acc2
  pool.setScheduling({ mode: 'fixed', fixed_email: 'acc1@test.com' });
  const pickedFixed = pool.pickManager('', new Set(), { model: 'gemini-3.8-flash' });
  assert.equal(pickedFixed.tokenData.email, 'acc2@test.com');

  // 模式 2: cache_first 会话粘滞绑定 acc1，但 acc1 受保护 -> 跳过选 acc2
  pool.setScheduling({ mode: 'cache_first' });
  pool.bindSession('session-123', 'acc1@test.com');
  const pickedSess = pool.pickManager('session-123', new Set(), { model: 'gemini-3.8-flash' });
  assert.equal(pickedSess.tokenData.email, 'acc2@test.com');
});

await test('配额保护：重置时间过去后自动解除保护，刷新回升后解除保护', () => {
  const dir = makeTempDir();
  const pool = new AccountPool(dir);
  pool.managers.set('acc1@test.com', mockManager('acc1@test.com'));
  pool.managers.set('acc2@test.com', mockManager('acc2@test.com'));
  pool.setScheduling({ mode: 'fixed', fixed_email: 'acc1@test.com' });

  const resetTime = '2026-10-29T18:00:00.000Z';
  const resetMs = new Date(resetTime).getTime();

  // acc1 5h 桶 <= 2%，带 reset_time
  pool.updateQuota('acc1@test.com', {
    gemini_5h: { remaining_fraction: 0.01, reset_time: resetTime },
    gemini_7d: { remaining_fraction: 0.90 },
  });
  pool.updateQuota('acc2@test.com', { gemini: 0.50 });

  // 重置时间前：acc1 受保护
  assert.equal(pool.isFamilyProtected('acc1@test.com', 'gemini', resetMs - 1000), true);

  // 重置时间后：acc1 自动解除保护，返回 1.0
  assert.equal(pool.isFamilyProtected('acc1@test.com', 'gemini', resetMs + 1000), false);
  assert.equal(pool.getQuota('acc1@test.com', 'gemini', resetMs + 1000), 0.90);

  // 刷新后额度回升至 10%：解除保护
  pool.updateQuota('acc1@test.com', { gemini: 0.10 });
  assert.equal(pool.isFamilyProtected('acc1@test.com', 'gemini'), false);
  const picked = pool.pickManager('', new Set(), { model: 'gemini-3.8-flash' });
  assert.equal(picked.tokenData.email, 'acc1@test.com');
});

// ==================== 2. 全保护时兜底 ====================
await test('全保护时兜底：若所有账号都被保护，选择额度最高者', () => {
  const dir = makeTempDir();
  const pool = new AccountPool(dir);
  pool.managers.set('acc1@test.com', mockManager('acc1@test.com'));
  pool.managers.set('acc2@test.com', mockManager('acc2@test.com'));
  pool.managers.set('acc3@test.com', mockManager('acc3@test.com'));

  // 全员 <= 2%
  pool.updateQuota('acc1@test.com', { gemini: 0.005 });
  pool.updateQuota('acc2@test.com', { gemini: 0.018 });
  pool.updateQuota('acc3@test.com', { gemini: 0.010 });

  assert.equal(pool.isFamilyProtected('acc1@test.com', 'gemini'), true);
  assert.equal(pool.isFamilyProtected('acc2@test.com', 'gemini'), true);
  assert.equal(pool.isFamilyProtected('acc3@test.com', 'gemini'), true);

  // 兜底必须选额度最高的 acc2 (0.018)
  const picked = pool.pickManager('', new Set(), { model: 'gemini-3.8-flash' });
  assert.ok(picked);
  assert.equal(picked.tokenData.email, 'acc2@test.com');
});

// ==================== 3. 预热判定条件与 6 天去重 ====================
await test('周额度预热判定条件：开关、满额/重置与 reset_time 校验', () => {
  const now = 1793200000000;

  // 1. 开关关闭 -> false
  assert.equal(shouldPrewarmFamily({
    email: 'a@test.com',
    family: 'gemini',
    quotaData: { gemini_7d: { fraction: 1.0, reset_time: null } },
    prewarmWeeklyEnabled: false,
    now,
  }), false);

  // 2. 7d 满额且 reset_time 为空 -> true
  assert.equal(shouldPrewarmFamily({
    email: 'a@test.com',
    family: 'gemini',
    quotaData: { gemini_7d: { fraction: 1.0, reset_time: null } },
    prewarmWeeklyEnabled: true,
    now,
  }), true);

  // 3. 7d 满额且 reset_time 已过 -> true
  assert.equal(shouldPrewarmFamily({
    email: 'a@test.com',
    family: 'gemini',
    quotaData: { gemini_7d: { remaining_fraction: 1.0, reset_time: new Date(now - 3600000).toISOString() } },
    prewarmWeeklyEnabled: true,
    now,
  }), true);

  // 4. 7d 满额但 reset_time 仍在未来（周期已经在计时） -> false
  assert.equal(shouldPrewarmFamily({
    email: 'a@test.com',
    family: 'gemini',
    quotaData: { gemini_7d: { fraction: 1.0, reset_time: new Date(now + 86400000).toISOString() } },
    prewarmWeeklyEnabled: true,
    now,
  }), false);

  // 5. 7d 未满额 (0.8) -> false
  assert.equal(shouldPrewarmFamily({
    email: 'a@test.com',
    family: 'gemini',
    quotaData: { gemini_7d: { fraction: 0.8, reset_time: null } },
    prewarmWeeklyEnabled: true,
    now,
  }), false);

  // 6. 7d 缺失 -> false
  assert.equal(shouldPrewarmFamily({
    email: 'a@test.com',
    family: 'gemini',
    quotaData: {},
    prewarmWeeklyEnabled: true,
    now,
  }), false);

  // 7. Claude 家族 7d 满额且 reset 为空 -> true
  assert.equal(shouldPrewarmFamily({
    email: 'a@test.com',
    family: 'claude',
    quotaData: { claude_7d: { fraction: 1.0, reset: null } },
    prewarmWeeklyEnabled: true,
    now,
  }), true);
});

await test('周额度预热：6 天防重复判定', () => {
  const t0 = 1793200000000;
  clearLastPrewarms();

  const quota = {
    gemini_7d: { fraction: 1.0, reset_time: null },
    claude_7d: { fraction: 1.0, reset_time: null },
  };

  // 首次应满足预热
  assert.equal(shouldPrewarmFamily({
    email: 'a@test.com',
    family: 'gemini',
    quotaData: quota,
    lastPrewarmAt: 0,
    prewarmWeeklyEnabled: true,
    now: t0,
  }), true);

  // 记录预热于 t0
  setLastPrewarm('a@test.com', 'gemini', t0);
  assert.equal(getLastPrewarm('a@test.com', 'gemini'), t0);

  // 5 天后：未满 6 天，拒绝重复预热
  const t5d = t0 + 5 * 24 * 3600 * 1000;
  assert.equal(shouldPrewarmFamily({
    email: 'a@test.com',
    family: 'gemini',
    quotaData: quota,
    lastPrewarmAt: getLastPrewarm('a@test.com', 'gemini'),
    prewarmWeeklyEnabled: true,
    now: t5d,
  }), false);

  // 6 天零 1 秒后：满足 6 天间隔，允许再次预热
  const t6d = t0 + PREWARM_DEDUPE_MS + 1000;
  assert.equal(shouldPrewarmFamily({
    email: 'a@test.com',
    family: 'gemini',
    quotaData: quota,
    lastPrewarmAt: getLastPrewarm('a@test.com', 'gemini'),
    prewarmWeeklyEnabled: true,
    now: t6d,
  }), true);

  // 同账号 Claude 家族独立计算：t0 + 1天时依然可以预热
  assert.equal(shouldPrewarmFamily({
    email: 'a@test.com',
    family: 'claude',
    quotaData: quota,
    lastPrewarmAt: getLastPrewarm('a@test.com', 'claude'),
    prewarmWeeklyEnabled: true,
    now: t0 + 86400000,
  }), true);

  // 不同账号独立计算：b 账号不受 a 限制
  assert.equal(shouldPrewarmFamily({
    email: 'b@test.com',
    family: 'gemini',
    quotaData: quota,
    lastPrewarmAt: getLastPrewarm('b@test.com', 'gemini'),
    prewarmWeeklyEnabled: true,
    now: t0 + 86400000,
  }), true);
});

// ==================== 4. 预热请求与模型路由 (mock fetch) ====================
await test('预热请求：Gemini 使用 flash，Claude 选用 sonnet，无真实网络', async () => {
  const dir = makeTempDir();
  const pool = new AccountPool(dir);
  pool.managers.set('a@test.com', mockManager('a@test.com'));

  const calls = [];
  const mockFetch = async (url, opts) => {
    const body = JSON.parse(opts.body);
    calls.push({ url, body });
    return {
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ candidates: [{ content: { parts: [{ text: 'pong' }] } }] }),
    };
  };

  // 1. Gemini 预热 -> 使用默认 gemini-3.8-flash 模型，maxOutputTokens 很小
  const rGemini = await prewarmAccountFamily({
    email: 'a@test.com',
    family: 'gemini',
    accountPool: pool,
    fetchImpl: mockFetch,
    now: Date.now(),
  });
  assert.equal(rGemini.ok, true);
  assert.equal(rGemini.model, 'gemini-3.8-flash');
  assert.equal(calls.length, 1);
  const genConfig = calls[0].body.request?.generationConfig || calls[0].body.generationConfig;
  assert.equal(genConfig.maxOutputTokens, 16);

  // 2. Claude 预热 -> 选用 claude-sonnet-4-6
  const sonnetModel = findClaudeSonnetModel([
    { id: 'gemini-3.8-flash' },
    { id: 'claude-sonnet-4-6' },
  ]);
  assert.equal(sonnetModel, 'claude-sonnet-4-6');

  const rClaude = await prewarmAccountFamily({
    email: 'a@test.com',
    family: 'claude',
    accountPool: pool,
    models: [{ id: 'claude-sonnet-4-6' }],
    fetchImpl: mockFetch,
    now: Date.now(),
  });
  assert.equal(rClaude.ok, true);
  assert.equal(rClaude.model, 'claude-sonnet-4-6');
  assert.equal(calls.length, 2);

  // 3. Claude 家族无 sonnet 模型时跳过
  const rNoSonnet = await prewarmAccountFamily({
    email: 'a@test.com',
    family: 'claude',
    accountPool: pool,
    models: [{ id: 'claude-haiku-4-5' }],
    fetchImpl: mockFetch,
    now: Date.now(),
  });
  assert.equal(rNoSonnet.ok, false);
  assert.equal(rNoSonnet.skipped, true);
});

// ==================== 5. scheduling.json 持久化 prewarm_weekly ====================
await test('scheduling.json 持久化 prewarm_weekly 与 quota_refresh', () => {
  const dir = makeTempDir();
  const pool = new AccountPool(dir);

  // 默认 prewarm_weekly 为 false
  const s0 = pool.getScheduling();
  assert.equal(s0.prewarm_weekly, false);
  assert.equal(s0.quota_refresh.interval_min, 15);
  assert.equal(s0.quota_refresh.last_run_at, null);

  // 设置 prewarm_weekly = true
  pool.setScheduling({ prewarm_weekly: true });
  assert.equal(pool.getScheduling().prewarm_weekly, true);

  // 检查磁盘上的 scheduling.json
  const raw = fs.readFileSync(pool.schedulingFile, 'utf8');
  const disk = JSON.parse(raw);
  assert.equal(disk.prewarm_weekly, true);

  // 新实例加载验证持久化
  const pool2 = new AccountPool(dir);
  assert.equal(pool2.prewarmWeekly, true);
  assert.equal(pool2.getScheduling().prewarm_weekly, true);

  // 切换回 false
  pool2.setScheduling({ prewarm_weekly: false });
  assert.equal(pool2.getScheduling().prewarm_weekly, false);
  const disk2 = JSON.parse(fs.readFileSync(pool.schedulingFile, 'utf8'));
  assert.equal(disk2.prewarm_weekly, false);
});

// ==================== 6. 定时刷新与预热集成纯函数测试 ====================
await test('refreshAllQuotasOnce 刷新额度、触发预热并更新 quota_refresh 状态', async () => {
  const dir = makeTempDir();
  const pool = new AccountPool(dir);
  pool.managers.set('a@test.com', mockManager('a@test.com'));
  pool.setScheduling({ prewarm_weekly: true });
  clearLastPrewarms();

  const mockQuotaFetcher = async (mgr) => ({
    ok: true,
    email: mgr.tokenData.email,
    gemini_5h: { remaining_fraction: 0.8 },
    gemini_7d: { remaining_fraction: 1.0, reset_time: null },
    claude_5h: { remaining_fraction: 0.8 },
    claude_7d: { remaining_fraction: 0.5, reset_time: '2026-10-30T00:00:00Z' },
  });

  const prewarmCalls = [];
  const mockFetch = async (url, opts) => {
    prewarmCalls.push(url);
    return {
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ candidates: [{ content: { parts: [{ text: 'pong' }] } }] }),
    };
  };

  const quotaCache = new Map();
  const now = 1793200000000;

  const result = await refreshAllQuotasOnce({
    accountPool: pool,
    quotaCache,
    quotaFetcher: mockQuotaFetcher,
    fetchImpl: mockFetch,
    sleep: async () => {},
    now,
  });

  assert.equal(result.count, 1);
  assert.deepEqual(result.refreshed, ['a@test.com']);
  assert.ok(quotaCache.has('a@test.com'));

  // Gemini 7d 满额且无 reset_time -> 应触发 1 次预热请求
  assert.equal(prewarmCalls.length, 1);

  // 验证 scheduling 的 quota_refresh 状态已更新
  const s = pool.getScheduling();
  assert.equal(s.quota_refresh.interval_min, 15);
  assert.equal(s.quota_refresh.last_run_at, new Date(now).toISOString());
  assert.equal(s.quota_refresh.next_run_at, new Date(now + 15 * 60 * 1000).toISOString());
});

console.log(`\n🎉 test-quota-guard passed: ${passed} / 7\n`);
