/**
 * 配额解析与人工验证封禁测试：node tests/test-quota-verify.mjs
 */
import assert from 'assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  extractFromEntry,
  mergeModelQuotas,
  parseSummary,
  buildBuckets,
  normalizeTier,
  toPublic,
} from '../src/quota-fetcher.mjs';
import { AccountPool } from '../src/account-pool.mjs';
import {
  isValidationRequired,
  extractValidationUrl,
  classifyFailure,
  runWithPolicy,
  Cooldowns,
} from '../src/upstream-policy.mjs';
import { mapToUpstreamModel, MODEL_FALLBACK_CHAINS } from '../src/cloudcode.mjs';

let passed = 0;
const ok = async (name, fn) => {
  await fn();
  passed++;
  console.log('  ✓', name);
};

console.log('quota & verification telemetry tests');

// ==================== 1. 缺失 remainingFraction 视为 0 ====================
await ok('extractFromEntry：有 resetTime 缺 remainingFraction 时视为 0', () => {
  const entry = { resetTime: '2026-10-29T18:00:00Z' };
  const r = extractFromEntry(entry);
  assert.ok(r);
  assert.equal(r.fraction, 0);
  assert.equal(r.reset, '2026-10-29T18:00:00Z');
  assert.equal(r.source, 'remainingFraction');
});

await ok('parseSummary：桶有 resetTime 缺 remainingFraction 时视为 0', () => {
  const body = {
    groups: [
      {
        displayName: 'Claude and GPT models',
        buckets: [
          { bucketId: '3p-5h', window: '5h', resetTime: '2026-10-29T18:00:00Z' },
        ],
      },
    ],
  };
  const summary = parseSummary(body);
  assert.ok(summary.claude_5h);
  assert.equal(summary.claude_5h.fraction, 0);
  assert.equal(summary.claude_5h.reset, '2026-10-29T18:00:00Z');
});

await ok('mergeModelQuotas：模型 quotaInfo 有 resetTime 缺 remainingFraction 时视为 0 且忽略 chat_/tab_', () => {
  const models = {
    'gemini-2.5-pro': {
      quotaInfo: { resetTime: '2026-10-29T18:00:00Z' },
    },
    'chat_internal_2026': {
      quotaInfo: { remainingFraction: 1, resetTime: '2026-10-29T18:00:00Z' },
    },
    'tab_autocomplete': {
      quotaInfo: { remainingFraction: 1, resetTime: '2026-10-29T18:00:00Z' },
    },
  };
  const merged = mergeModelQuotas(models);
  assert.ok(merged.gemini_5h);
  assert.equal(merged.gemini_5h.fraction, 0);
  assert.equal(merged.gemini_7d, null);
});

// ==================== 2. Argon 单独成组 ====================
await ok('parseSummary：组名/bucketId 含 argon 单独成组，不并入 gemini', () => {
  const body = {
    groups: [
      {
        displayName: 'Argon Models Preview',
        buckets: [
          { bucketId: 'argon-5h', window: '5h', remainingFraction: 0.85, resetTime: '2026-10-29T20:00:00Z' },
          { bucketId: 'argon-weekly', window: 'weekly', remainingFraction: 0.9, resetTime: '2026-11-05T00:00:00Z' },
        ],
      },
      {
        displayName: 'Claude and GPT models',
        buckets: [
          { bucketId: '3p-5h', window: '5h', remainingFraction: 0.5 },
        ],
      },
    ],
  };
  const summary = parseSummary(body);
  assert.ok(summary.argon_5h);
  assert.equal(summary.argon_5h.fraction, 0.85);
  assert.ok(summary.argon_7d);
  assert.equal(summary.argon_7d.fraction, 0.9);
  assert.equal(summary.gemini_5h, undefined, 'argon 不应并入 gemini');
  assert.ok(summary.claude_5h);
  assert.equal(summary.claude_5h.fraction, 0.5);
});

await ok('mergeModelQuotas：包含 argon 模型的识别为 argon', () => {
  const models = {
    'gemini-2.5-flash': { quotaInfo: { remainingFraction: 0.8 } },
    'gemini-argon-experimental': { quotaInfo: { remainingFraction: 0.6 } },
  };
  const merged = mergeModelQuotas(models);
  assert.equal(merged.gemini_5h.fraction, 0.8);
  assert.equal(merged.argon_5h.fraction, 0.6);
});

// ==================== 3. buckets 列表只含有数据的桶并排序 ====================
await ok('buildBuckets：只包含真实拿到数据的桶并按 gemini, claude, argon（5h 在前）排序', () => {
  const merged = {
    gemini_5h: { fraction: 0.45, reset: '2026-10-29T15:00:00Z', source: 'remainingFraction' },
    gemini_7d: null, // 无数据，不包含在列表中
    claude_7d: { fraction: 1, reset: '2026-11-05T00:00:00Z', source: 'summary' },
    claude_5h: { fraction: 0.8, reset: '2026-10-29T15:00:00Z', source: 'summary' },
    argon_5h: { fraction: 0, reset: '2026-10-29T16:00:00Z', source: 'remainingFraction' },
    argon_7d: null, // 无数据
  };
  const buckets = buildBuckets(merged);
  assert.equal(buckets.length, 4);
  assert.deepEqual(buckets.map(b => `${b.group}:${b.window}`), [
    'gemini:5h',
    'claude:5h',
    'claude:7d',
    'argon:5h',
  ]);
  assert.deepEqual(buckets.map(b => b.label), [
    'Gemini',
    'Claude / GPT',
    'Claude / GPT',
    'Argon',
  ]);
  assert.equal(buckets[0].percentage, 45);
  assert.equal(buckets[0].remaining_fraction, 0.45);
  assert.equal(buckets[3].percentage, 0);
  assert.equal(buckets[3].remaining_fraction, 0);
});

await ok('toPublic：reset 为空时 reset_text 返回空字符串（不再返回动态自适应）', () => {
  const pub = toPublic({ fraction: 0.5, reset: null, source: 'test' });
  assert.equal(pub.reset_text, '');
});

// ==================== 4. normalizeTier ====================
await ok('normalizeTier：正确归一化 ULTRA | PRO | FREE | null', () => {
  assert.equal(normalizeTier('g1-pro-tier'), 'PRO');
  assert.equal(normalizeTier('tier-pro'), 'PRO');
  assert.equal(normalizeTier('g1-ultra-tier'), 'ULTRA');
  assert.equal(normalizeTier('tier-ultra-2026'), 'ULTRA');
  assert.equal(normalizeTier('free-tier'), 'FREE');
  assert.equal(normalizeTier('standard-plan'), 'FREE');
  assert.equal(normalizeTier('legacy-user'), 'FREE');
  assert.equal(normalizeTier('unknown-tier'), null);
  assert.equal(normalizeTier(null), null);
  assert.equal(normalizeTier(''), null);
  assert.equal(normalizeTier(undefined), null);
});

// ==================== 5. isValidationRequired & extractValidationUrl ====================
await ok('isValidationRequired：识别验证封禁关键字', () => {
  assert.ok(isValidationRequired('Verify your account immediately'));
  assert.ok(isValidationRequired('{"message":"further action is required"}'));
  assert.ok(isValidationRequired('validation_url: https://...'));
  assert.ok(isValidationRequired('appeal_url'));
  assert.ok(isValidationRequired('VALIDATION_REQUIRED'));
  assert.equal(isValidationRequired('Normal error: 404 not found'), false);
  assert.equal(isValidationRequired('RESOURCE_EXHAUSTED'), false);
});

await ok('extractValidationUrl：提取验证 URL，优先 metadata 字段并还原 \\u0026', () => {
  const jsonWithDetails = JSON.stringify({
    error: {
      message: 'Verify your account',
      details: [
        {
          '@type': 'type.googleapis.com/google.rpc.ErrorInfo',
          metadata: {
            validation_url: 'https://accounts.google.com/challenge?token=abc\\u0026client=antigravity\\u0026hl=zh-CN',
          },
        },
      ],
    },
  });
  assert.equal(
    extractValidationUrl(jsonWithDetails),
    'https://accounts.google.com/challenge?token=abc&client=antigravity&hl=zh-CN'
  );

  const jsonWithAppeal = JSON.stringify({
    error: {
      details: [{ metadata: { appeal_url: 'https://support.google.com/appeal?id=123' } }],
    },
  });
  assert.equal(extractValidationUrl(jsonWithAppeal), 'https://support.google.com/appeal?id=123');

  const jsonWithLinks = JSON.stringify({
    error: {
      details: [{ links: [{ url: 'https://accounts.google.com/signin/challenge' }] }],
    },
  });
  assert.equal(extractValidationUrl(jsonWithLinks), 'https://accounts.google.com/signin/challenge');

  const rawTextWithEscapedUrl = 'Please visit https://accounts.google.com/verify?step=1\\u0026hl=en to verify';
  assert.equal(extractValidationUrl(rawTextWithEscapedUrl), 'https://accounts.google.com/verify?step=1&hl=en');
});

// ==================== 6. classifyFailure 返回 validation ====================
await ok('classifyFailure：403 或 503 遇验证错误均返回 validation', () => {
  const body403 = JSON.stringify({ error: { message: 'Verify your account' } });
  assert.equal(classifyFailure({ status: 403, body: body403 }), 'validation');

  const body503 = 'Service Unavailable: VALIDATION_REQUIRED';
  assert.equal(classifyFailure({ status: 503, body: body503 }), 'validation');

  // 普通 403 / 503 不应误判
  assert.equal(classifyFailure({ status: 403, body: '{"error":"Permission denied"}' }), 'auth');
  assert.equal(classifyFailure({ status: 503, body: '{"error":"Backend timeout"}' }), 'server');
});

// ==================== 7. pickManager 跳过被封号 ====================
await ok('pickManager：跳过被封禁的号，全封时返回 null，clearAllCooldowns 不解封', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-verify-test-'));
  try {
    const pool = new AccountPool(tmpDir);
    pool.addAccount('rt-1', 'acc1@gmail.com');
    pool.addAccount('rt-2', 'acc2@gmail.com');

    // 两个账号都在池中
    const picked1 = pool.pickManager();
    assert.ok(picked1);

    // 封禁 acc1
    pool.markValidationBlocked('acc1@gmail.com', 'Captcha required', 'https://verify.url', 60000);
    assert.equal(pool.isValidationBlocked('acc1@gmail.com'), true);
    assert.equal(pool.isValidationBlocked('acc2@gmail.com'), false);

    const info = pool.validationInfo('acc1@gmail.com');
    assert.equal(info.blocked, true);
    assert.equal(info.reason, 'Captcha required');
    assert.equal(info.url, 'https://verify.url');

    // pickManager 应当避开 acc1
    for (let i = 0; i < 5; i++) {
      const picked = pool.pickManager();
      assert.equal(picked?.tokenData?.email, 'acc2@gmail.com');
    }

    // 即使管理员锁定了 acc1，也会跳过
    pool.setSelectedEmail('acc1@gmail.com');
    assert.equal(pool.pickManager()?.tokenData?.email, 'acc2@gmail.com');
    pool.setSelectedEmail('');

    // poolStatus 带出 validation 字段
    const statuses = pool.poolStatus();
    const st1 = statuses.find(s => s.email === 'acc1@gmail.com');
    const st2 = statuses.find(s => s.email === 'acc2@gmail.com');
    assert.equal(st1.validation_blocked, true);
    assert.equal(st1.validation_url, 'https://verify.url');
    assert.equal(st1.validation_reason, 'Captcha required');
    assert.equal(st2.validation_blocked, false);

    // 封禁 acc2，此时全员被封禁，应返回 null
    pool.markValidationBlocked('acc2@gmail.com', 'Need verify', 'https://verify2.url', 60000);
    assert.equal(pool.pickManager(), null);

    // clearAllCooldowns 不得解封验证封禁
    pool.clearAllCooldowns();
    assert.equal(pool.isValidationBlocked('acc1@gmail.com'), true);
    assert.equal(pool.pickManager(), null);

    // clearAllValidationBlocks 解封
    pool.clearAllValidationBlocks();
    assert.equal(pool.isValidationBlocked('acc1@gmail.com'), false);
    assert.equal(pool.isValidationBlocked('acc2@gmail.com'), false);
    assert.ok(pool.pickManager() !== null);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

// ==================== 8. runWithPolicy 遇 validation 换号且调用回调 ====================
await ok('runWithPolicy：遇 validation 换号、调用 onValidationRequired、排除 isBlocked 账号、不降级', async () => {
  const MAIN = 'gemini-3.8-flash-high';
  const D = 'https://daily.example', A = 'https://autopush.example';
  const mgr = email => ({ tokenData: { email, projectId: 'proj-' + email } });
  const resp = (status, body = '') => ({
    ok: status >= 200 && status < 300,
    status,
    text: async () => body,
    headers: { get: () => null },
  });

  const valBody = JSON.stringify({
    error: {
      code: 403,
      message: 'Verify your account',
      details: [{ metadata: { validation_url: 'https://accounts.google.com/check?a=1\\u0026b=2' } }],
    },
  });

  const blockedMap = new Set();
  const recordedValidationEvents = [];

  const calls = [];
  let t = 0;
  const now = () => t;
  const cd = new Cooldowns(now);
  const mgrs = ['a@gmail.com', 'b@gmail.com'].map(mgr);
  const req = { model: MAIN, max_tokens: 100, messages: [{ role: 'user', content: 'hi' }] };

  const result = await runWithPolicy({
    model: MAIN,
    anthropicReq: req,
    upstreamOf: mapToUpstreamModel,
    accounts: () => mgrs,
    activeEmail: 'a@gmail.com',
    quotaOf: () => null,
    cooldowns: cd,
    isBlocked: e => blockedMap.has(e),
    onValidationRequired: (m, body) => {
      recordedValidationEvents.push({ email: m.tokenData.email, body });
      blockedMap.add(m.tokenData.email);
    },
    buildPayload: (model, m) => ({ model: mapToUpstreamModel(model), request: { sessionId: 's', contents: [] }, project: m.tokenData.projectId }),
    send: async (p, m, host, timeoutMs) => {
      calls.push({ email: m.tokenData.email, host });
      if (m.tokenData.email === 'a@gmail.com') {
        return resp(403, valBody);
      }
      return resp(200, '{"candidates":[]}');
    },
    hosts: [D, A],
    chain: MODEL_FALLBACK_CHAINS[MAIN],
    allowDowngrade: true,
    headerTimeoutMs: 60000,
    deadlineMs: 45000,
    now,
    sleep: async ms => { t += ms; },
    startedAt: now(),
  });

  assert.equal(result.ok, true);
  assert.equal(result.modelUsed, MAIN);
  assert.equal(result.downgraded, false);
  assert.equal(result.switchedAccount, true);
  assert.equal(result.mgr.tokenData.email, 'b@gmail.com');
  assert.equal(recordedValidationEvents.length, 1);
  assert.equal(recordedValidationEvents[0].email, 'a@gmail.com');
  assert.ok(recordedValidationEvents[0].body.includes('Verify your account'));
  assert.deepEqual(calls.map(c => c.email), ['a@gmail.com', 'b@gmail.com']);

  // 下一次请求由于 a 已在 blockedMap 中，order() 直接过滤，首选 b
  const calls2 = [];
  const result2 = await runWithPolicy({
    model: MAIN,
    anthropicReq: req,
    upstreamOf: mapToUpstreamModel,
    accounts: () => mgrs,
    activeEmail: 'a@gmail.com',
    cooldowns: cd,
    isBlocked: e => blockedMap.has(e),
    buildPayload: (model, m) => ({ model: mapToUpstreamModel(model), request: { sessionId: 's', contents: [] }, project: m.tokenData.projectId }),
    send: async (p, m) => {
      calls2.push(m.tokenData.email);
      return resp(200, '{}');
    },
    hosts: [D, A],
    chain: MODEL_FALLBACK_CHAINS[MAIN],
    now,
    sleep: async () => {},
  });
  assert.equal(result2.ok, true);
  assert.deepEqual(calls2, ['b@gmail.com']);

  // 全部账号被 validation 封禁时：不降级，直接返回 validation 错误
  const resultAllBlocked = await runWithPolicy({
    model: MAIN,
    anthropicReq: req,
    upstreamOf: mapToUpstreamModel,
    accounts: () => mgrs,
    activeEmail: 'b@gmail.com',
    cooldowns: cd,
    buildPayload: (model, m) => ({ model: mapToUpstreamModel(model), request: { sessionId: 's', contents: [] } }),
    send: async () => resp(403, valBody),
    hosts: [D, A],
    chain: MODEL_FALLBACK_CHAINS[MAIN],
    allowDowngrade: true,
    now,
    sleep: async () => {},
  });
  assert.equal(resultAllBlocked.ok, false);
  assert.equal(resultAllBlocked.downgraded, false);
  assert.equal(resultAllBlocked.error.kind, 'validation');
  assert.equal(resultAllBlocked.reason, 'validation');
});

console.log(`\n🎉 test-quota-verify passed: ${passed} / ${passed}`);
