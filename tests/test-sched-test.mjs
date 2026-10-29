import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { AccountPool, SCHEDULING_MODES } from '../src/account-pool.mjs';
import { TokenManager } from '../src/token-manager.mjs';
import { buildBuckets, getModelFamily, extractFamilyFraction, computeAccountQuotas } from '../src/quota-fetcher.mjs';
import { calculateCooldownMs, parseRetryDelayMs, Cooldowns } from '../src/upstream-policy.mjs';
import { testAccount, testAllAccounts } from '../src/account-tester.mjs';

function ok(title, fn) {
  try {
    const res = fn();
    if (res instanceof Promise) {
      return res.then(
        () => console.log(`  ✓ ${title}`),
        err => { console.error(`  ✗ ${title}`); throw err; }
      );
    }
    console.log(`  ✓ ${title}`);
  } catch (err) {
    console.error(`  ✗ ${title}`);
    throw err;
  }
}

console.log('🧪 开始运行调度策略与账号测试综合测试...');

// 创建测试用临时目录
function makeTempDir() {
  const tmp = path.join(os.tmpdir(), `wag-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  fs.mkdirSync(tmp, { recursive: true });
  return tmp;
}

function mockManager(email, tokenData = {}) {
  const tm = Object.create(TokenManager.prototype);
  tm.tokenData = {
    email,
    refreshToken: 'mock-rt',
    accessToken: 'mock-at',
    expiresAt: Date.now() + 3600000,
    projectId: 'test-project',
    ...tokenData,
  };
  tm.getValidAccessToken = async () => 'mock-at';
  tm.getStatus = () => ({ email, status: 'ready' });
  return tm;
}

// ==================== 1. 调度模式（4种模式选号） ====================
await ok('调度模式：4种模式切换与 scheduling.json 持久化', () => {
  const dir = makeTempDir();
  const pool = new AccountPool(path.join(dir, 'accounts'));
  pool.init();

  assert.equal(pool.getSchedulingMode(), 'cache_first');
  const s0 = pool.getScheduling();
  assert.equal(s0.mode, 'cache_first');
  assert.equal(s0.modes.length, 4);

  // 切换为 balance
  pool.setScheduling({ mode: 'balance' });
  assert.equal(pool.getSchedulingMode(), 'balance');

  // 重启读取持久化文件
  const pool2 = new AccountPool(path.join(dir, 'accounts'));
  pool2.init();
  assert.equal(pool2.getSchedulingMode(), 'balance');

  // 切换为 fixed 模式
  pool2.setScheduling({ mode: 'fixed', fixed_email: 'acc1@test.com' });
  assert.equal(pool2.getSchedulingMode(), 'fixed');
  assert.equal(pool2.getFixedEmail(), 'acc1@test.com');

  // 无效模式抛错
  assert.throws(() => pool2.setScheduling({ mode: 'unknown' }));
});

await ok('调度选号：cache_first（会话粘滞优先，未命中走最久未用）', () => {
  const pool = new AccountPool(makeTempDir());
  pool.managers.set('acc1@test.com', mockManager('acc1@test.com'));
  pool.managers.set('acc2@test.com', mockManager('acc2@test.com'));

  // 初始 cache_first 模式
  pool.setScheduling({ mode: 'cache_first' });
  const m1 = pool.pickManager('sess-1');
  assert.equal(m1.tokenData.email, 'acc1@test.com');

  // 相同 sessionKey 命中粘滞
  const m2 = pool.pickManager('sess-1');
  assert.equal(m2.tokenData.email, 'acc1@test.com');

  // 遇冷时自动迁移粘滞
  pool.markCooling('acc1@test.com', 5000);
  const m3 = pool.pickManager('sess-1');
  assert.equal(m3.tokenData.email, 'acc2@test.com');
});

await ok('调度选号：balance（不粘性，按配额差距与 LRU 均衡）', () => {
  const pool = new AccountPool(makeTempDir());
  pool.managers.set('acc1@test.com', mockManager('acc1@test.com'));
  pool.managers.set('acc2@test.com', mockManager('acc2@test.com'));
  pool.setScheduling({ mode: 'balance' });

  // acc1 配额 90%，acc2 配额 40% -> 差距 > 15%，应选配额高的 acc1
  pool.updateQuota('acc1@test.com', { gemini: 0.9 });
  pool.updateQuota('acc2@test.com', { gemini: 0.4 });

  const picked = pool.pickManager('sess-xyz', new Set(), { model: 'gemini-3.8-flash' });
  assert.equal(picked.tokenData.email, 'acc1@test.com');

  // 当配额接近 (0.8 vs 0.85)，按最久未使用 (LRU) 轮询
  pool.updateQuota('acc1@test.com', { gemini: 0.85 });
  pool.updateQuota('acc2@test.com', { gemini: 0.8 });
  pool.lastUsed.set('acc1@test.com', 1000);
  pool.lastUsed.set('acc2@test.com', 500); // acc2 更久未用

  const pickedLru = pool.pickManager('sess-xyz', new Set(), { model: 'gemini-3.8-flash' });
  assert.equal(pickedLru.tokenData.email, 'acc2@test.com');
});

await ok('调度选号：performance（不粘性，优先最近成功率高、低连败、低延迟）', () => {
  const pool = new AccountPool(makeTempDir());
  pool.managers.set('acc1@test.com', mockManager('acc1@test.com'));
  pool.managers.set('acc2@test.com', mockManager('acc2@test.com'));
  pool.setScheduling({ mode: 'performance' });

  // acc1 有失败，acc2 全成功
  pool.recordResult('acc1@test.com', false, 800);
  pool.recordResult('acc2@test.com', true, 500);

  const picked = pool.pickManager('', new Set());
  assert.equal(picked.tokenData.email, 'acc2@test.com');

  // 验证 poolStatus 包含了 performance 统计
  const st = pool.poolStatus().find(s => s.email === 'acc2@test.com');
  assert.equal(st.success_rate, 1);
  assert.equal(st.avg_latency_ms, 500);
  assert.equal(st.fail_streak, 0);
});

await ok('调度选号：fixed（固定账号，遇冷/排除时平滑换号）', () => {
  const pool = new AccountPool(makeTempDir());
  pool.managers.set('acc1@test.com', mockManager('acc1@test.com'));
  pool.managers.set('acc2@test.com', mockManager('acc2@test.com'));
  pool.setScheduling({ mode: 'fixed', fixed_email: 'acc2@test.com' });

  const picked = pool.pickManager('');
  assert.equal(picked.tokenData.email, 'acc2@test.com');

  // acc2 遇冷，平滑换到 acc1
  pool.markCooling('acc2@test.com', 5000);
  const pickedFailover = pool.pickManager('');
  assert.equal(pickedFailover.tokenData.email, 'acc1@test.com');
});

await ok('调度选号：任何模式均绝不选择人工验证封禁的账号', () => {
  const pool = new AccountPool(makeTempDir());
  pool.managers.set('acc1@test.com', mockManager('acc1@test.com'));
  pool.managers.set('acc2@test.com', mockManager('acc2@test.com'));

  pool.markValidationBlocked('acc1@test.com', 'need captcha');

  for (const mode of ['cache_first', 'balance', 'performance', 'fixed']) {
    pool.setScheduling({ mode, fixed_email: 'acc1@test.com' });
    const picked = pool.pickManager('sess-test');
    assert.equal(picked.tokenData.email, 'acc2@test.com', `模式 ${mode} 不应选择被封禁账号`);
  }
});

// ==================== 2. 模型家族配额选号与中性处理 ====================
await ok('模型家族与配额：按家族分别缓存并取 5h/7d 较小已知值，null 为中性', () => {
  assert.equal(getModelFamily('gemini-3.8-flash-high'), 'gemini');
  assert.equal(getModelFamily('claude-sonnet-4-6'), 'claude');
  assert.equal(getModelFamily('gpt-5.6-sol'), 'claude');
  assert.equal(getModelFamily('gemini-4-argon'), 'argon');

  const quotaObj = {
    gemini_5h: { remaining_fraction: 0.8 },
    gemini_7d: null,
    claude_5h: { remaining_fraction: 0.7 },
    claude_7d: { remaining_fraction: 0.3 },
    argon_5h: 0.5,
  };
  const summary = computeAccountQuotas(quotaObj);
  assert.equal(summary.gemini, 0.8); // 7d 为 null，取唯一已知值 0.8
  assert.equal(summary.claude, 0.3); // 取 min(0.7, 0.3) = 0.3
  assert.equal(summary.argon, 0.5);

  const pool = new AccountPool(makeTempDir());
  pool.managers.set('acc1@test.com', mockManager('acc1@test.com'));
  pool.managers.set('acc2@test.com', mockManager('acc2@test.com'));
  pool.setScheduling({ mode: 'balance' });

  // acc1 的 Claude 配额高 (0.8)，Gemini 配额低 (0.2)
  // acc2 的 Claude 配额低 (0.2)，Gemini 配额高 (0.9)
  pool.updateQuota('acc1@test.com', { claude: 0.8, gemini: 0.2 });
  pool.updateQuota('acc2@test.com', { claude: 0.2, gemini: 0.9 });

  // 请求 Claude 模型 -> 应选 acc1
  const pickedClaude = pool.pickManager('', new Set(), { model: 'claude-sonnet-4-6' });
  assert.equal(pickedClaude.tokenData.email, 'acc1@test.com');

  // 请求 Gemini 模型 -> 应选 acc2
  const pickedGemini = pool.pickManager('', new Set(), { model: 'gemini-3.8-flash' });
  assert.equal(pickedGemini.tokenData.email, 'acc2@test.com');

  // 额度 <5% 的号排后（acc1 额度 0.02 < 0.05，acc2 额度 null 为中性 0.5）
  pool.updateQuota('acc1@test.com', { gemini: 0.02 });
  pool.quotaMap.delete('acc2@test.com'); // acc2 为未知 null
  const pickedNonLow = pool.pickManager('', new Set(), { model: 'gemini-3.8-flash' });
  assert.equal(pickedNonLow.tokenData.email, 'acc2@test.com');
});

// ==================== 3. 429 冷却与重置时间解析 ====================
await ok('429 冷却：parseRetryDelayMs 与 calculateCooldownMs 精准计算', () => {
  // 1. Retry-After 头 (秒数)
  assert.equal(parseRetryDelayMs('', { 'retry-after': '35' }), 35000);
  assert.equal(parseRetryDelayMs('', { 'retry-after': '35s' }), 35000);

  // 2. body retryDelay
  assert.equal(parseRetryDelayMs('{"error":{"details":[{"retryDelay":"4.5s"}]}}'), 4500);
  assert.equal(calculateCooldownMs('{"error":{"details":[{"retryDelay":"35s"}]}}'), 35000);

  // 3. quotaResetDelay 带单位
  const cd2h = calculateCooldownMs('{"error":{"details":[{"reason":"QUOTA_EXHAUSTED","metadata":{"quotaResetDelay":"2h"}}]}}');
  assert.equal(cd2h, 2 * 3600 * 1000);

  const cd10m = calculateCooldownMs('{"error":{"details":[{"reason":"RESOURCE_EXHAUSTED","metadata":{"quotaResetDelay":"10m"}}]}}');
  assert.equal(cd10m, 10 * 60 * 1000);

  // 4. 自然语言 resets in
  const cdNatural = calculateCooldownMs('Resource exhausted. Quota will reset in 120 sec.');
  assert.equal(cdNatural, 120000);

  // 5. 超过 5 小时上限封顶到 5 小时
  const cdLong = calculateCooldownMs('{"error":{"details":[{"reason":"QUOTA_EXHAUSTED","metadata":{"quotaResetDelay":"72h"}}]}}');
  assert.equal(cdLong, 5 * 3600 * 1000);

  // 6. 无任何重置信息时默认 60s
  assert.equal(calculateCooldownMs('Unknown 429 rate limit'), 60000);
});

// ==================== 4. 账号测试接口参数校验与 mock fetch ====================
await ok('账号测试：testAccount 参数校验与成功流程 (mock fetch)', async () => {
  const pool = new AccountPool(makeTempDir());
  pool.managers.set('good@test.com', mockManager('good@test.com'));
  pool.markCooling('good@test.com', 10000);
  pool.markValidationBlocked('good@test.com', 'old block');

  // 1. 缺少 email
  const rMissing = await testAccount({ email: '', accountPool: pool });
  assert.equal(rMissing.ok, false);
  assert.equal(rMissing.status, 400);

  // 2. 账号不存在
  const rNotExist = await testAccount({ email: 'none@test.com', accountPool: pool });
  assert.equal(rNotExist.ok, false);
  assert.equal(rNotExist.status, 404);

  // 3. 正常测试通过 (强制绕过冷却和封禁，测试成功后解除)
  const mockSuccessFetch = async (url, opts) => {
    return {
      ok: true,
      status: 200,
      json: async () => ({
        candidates: [{ content: { parts: [{ text: 'PONG from Google' }] } }],
      }),
      text: async () => JSON.stringify({
        candidates: [{ content: { parts: [{ text: 'PONG from Google' }] } }],
      }),
    };
  };

  const rSuccess = await testAccount({
    email: 'good@test.com',
    model: 'gemini-3.8-flash',
    accountPool: pool,
    fetchImpl: mockSuccessFetch,
  });

  assert.equal(rSuccess.ok, true);
  assert.equal(rSuccess.email, 'good@test.com');
  assert.equal(rSuccess.model, 'gemini-3.8-flash');
  assert.equal(rSuccess.reply, 'PONG from Google');
  assert.equal(typeof rSuccess.latency_ms, 'number');

  // 验证解除了冷却和封禁
  assert.equal(pool.isCooling('good@test.com'), false);
  assert.equal(pool.isValidationBlocked('good@test.com'), false);
});

await ok('账号测试：testAccount 捕获验证封禁与错误流程 (mock fetch)', async () => {
  const pool = new AccountPool(makeTempDir());
  pool.managers.set('bad@test.com', mockManager('bad@test.com'));

  const mockValidationFetch = async () => {
    return {
      ok: false,
      status: 403,
      text: async () => '{"error":{"message":"User verification required","details":[{"metadata":{"validation_url":"https://accounts.google.com/verify"}}]}}',
    };
  };

  const rFail = await testAccount({
    email: 'bad@test.com',
    accountPool: pool,
    fetchImpl: mockValidationFetch,
  });

  assert.equal(rFail.ok, false);
  assert.equal(rFail.status, 403);
  assert.equal(rFail.kind, 'validation');
  assert.equal(rFail.validation_url, 'https://accounts.google.com/verify');
  assert.equal(pool.isValidationBlocked('bad@test.com'), true);
});

await ok('账号测试：testAllAccounts 并发测试', async () => {
  const pool = new AccountPool(makeTempDir());
  pool.managers.set('a1@test.com', mockManager('a1@test.com'));
  pool.managers.set('a2@test.com', mockManager('a2@test.com'));
  pool.managers.set('a3@test.com', mockManager('a3@test.com'));

  let activeConcur = 0;
  let maxConcur = 0;

  const mockConcurrentFetch = async () => {
    activeConcur++;
    maxConcur = Math.max(maxConcur, activeConcur);
    await new Promise(r => setTimeout(r, 20));
    activeConcur--;
    return {
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ candidates: [{ content: { parts: [{ text: 'ok' }] } }] }),
    };
  };

  const res = await testAllAccounts({
    accountPool: pool,
    fetchImpl: mockConcurrentFetch,
    concurrency: 3,
  });

  assert.equal(res.results.length, 3);
  assert.ok(maxConcur <= 3);
  assert.ok(res.results.every(r => r.ok));
});

// ==================== 5. 配额桶 4 核心桶总是出现且 missing 标记准确 ====================
await ok('配额桶：4个核心桶总是出现，无数据 missing: true 并带 note，Argon 仅在有数据时出现', () => {
  // 完全空数据
  const bucketsEmpty = buildBuckets({});
  assert.equal(bucketsEmpty.length, 4);
  assert.deepEqual(bucketsEmpty.map(b => `${b.group}:${b.window}`), [
    'gemini:5h',
    'gemini:7d',
    'claude:5h',
    'claude:7d',
  ]);
  assert.ok(bucketsEmpty.every(b => b.missing === true && b.percentage === null));
  assert.ok(bucketsEmpty.find(b => b.group === 'gemini' && b.window === '7d').note.includes('Gemini 周额度'));

  // 部分数据 (Gemini 5h + Claude 5h + Argon 5h)
  const bucketsPartial = buildBuckets({
    gemini_5h: { remaining_fraction: 0.6, reset_time: '2026-10-29T15:00:00Z' },
    claude_5h: { remaining_fraction: 0.9, reset_time: '2026-10-29T16:00:00Z' },
    argon_5h: { remaining_fraction: 0.4, reset_time: '2026-10-29T17:00:00Z' },
  });

  assert.equal(bucketsPartial.length, 5); // 4 核心桶 + 1 个有数据的 Argon 桶
  const g5h = bucketsPartial.find(b => b.group === 'gemini' && b.window === '5h');
  assert.equal(g5h.percentage, 60);
  assert.equal(g5h.missing, false);

  const g7d = bucketsPartial.find(b => b.group === 'gemini' && b.window === '7d');
  assert.equal(g7d.percentage, null);
  assert.equal(g7d.missing, true);

  const argon5h = bucketsPartial.find(b => b.group === 'argon' && b.window === '5h');
  assert.equal(argon5h.percentage, 40);
  assert.equal(argon5h.missing, false);
});

console.log('\n🎉 test-sched-test 全部测试通过！');
