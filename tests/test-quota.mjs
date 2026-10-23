import assert from 'assert/strict';
import { fetchRealQuota } from '../src/quota-fetcher.mjs';

console.log('🧪 运行 AG 额度解析与周约束单元测试...');

// 1. 测试未登录账号时的防御
{
  const res = await fetchRealQuota(null);
  assert.equal(res.ok, false);
  assert.equal(res.gemini_5h, null);
  assert.equal(res.gemini_7d, null);
  console.log('  ✓ 未登录账号时安全返回 ok: false 且无虚假数据');
}

// 2. 测试 mock tokenManager 下周限额约束自动映射
{
  const mockTokenManager = {
    tokenData: {
      email: 'test@example.com',
      refreshToken: 'fake_refresh_token',
      projectId: 'test-project-123',
    },
    async getValidAccessToken() {
      return 'fake_access_token';
    },
    async ensureProjectId() {
      return 'test-project-123';
    },
  };

  // 保存并替换全局 fetch
  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = async (url, options) => {
      const u = String(url);
      if (u.includes('fetchAvailableModels')) {
        // 模拟返回：Gemini 模型的 resetTime 为 27 小时后（超过 5.5h），只有单条周约束数据
        const futureReset = new Date(Date.now() + 27 * 3600 * 1000).toISOString();
        return {
          ok: true,
          status: 200,
          async json() {
            return {
              models: {
                'gemini-3.1-pro': {
                  name: 'gemini-3.1-pro',
                  quotaInfo: {
                    remainingFraction: 0.15,
                    resetTime: futureReset,
                  },
                },
              },
            };
          },
        };
      }
      if (u.includes('retrieveUserQuotaSummary')) {
        // 模拟 retrieveUserQuotaSummary 只有 Claude 组，缺少 Gemini 组
        return {
          ok: true,
          status: 200,
          async json() {
            return {
              groups: [
                {
                  displayName: 'Claude and GPT models',
                  buckets: [
                    { bucketId: '3p-5h', window: '5h', remainingFraction: 0.8 },
                    { bucketId: '3p-weekly', window: 'weekly', remainingFraction: 0.9 },
                  ],
                },
              ],
            };
          },
        };
      }
      return { ok: false, status: 404 };
    };

    const quota = await fetchRealQuota(mockTokenManager);
    assert.equal(quota.ok, true);
    assert.equal(quota.email, 'test@example.com');
    // Gemini 7d 正常获取（15%）
    assert.equal(quota.gemini_7d.percentage, 15);
    // Gemini 5h 不再为 null，而是带有 constrained_by_weekly 标记
    assert.ok(quota.gemini_5h, 'gemini_5h 不应为 null');
    assert.equal(quota.gemini_5h.percentage, 15);
    assert.equal(quota.gemini_5h.constrained_by_weekly, true);
    assert.equal(quota.gemini_5h.bound, 'constrained');
    assert.equal(quota.gemini_5h.reset_time, null); // 绝不抄周额度的重置时间
    assert.equal(quota.gemini_5h.reset_text, '受周限额约束');
    // Claude 正确从 summary 拿到
    assert.equal(quota.claude_5h.percentage, 80);
    assert.equal(quota.claude_7d.percentage, 90);
    console.log('  ✓ Gemini 5h 缺失时平滑继承 7d 周限额约束标记 (constrained_by_weekly: true, bound: constrained)');
    console.log('  ✓ Claude 正常从 retrieveUserQuotaSummary 提取 5h 与 7d');
  } finally {
    globalThis.fetch = originalFetch;
  }
}

// 3. 测试新号/未超额账号：5h 是 100% 且 4.9 小时内，7d 缺失时自动产生 bound: 'gte' (未触发周限)
{
  const mockTokenManager = {
    tokenData: {
      email: 'newuser@example.com',
      refreshToken: 'fake_refresh_token',
      projectId: 'test-project-123',
    },
    async getValidAccessToken() {
      return 'fake_access_token';
    },
    async ensureProjectId() {
      return 'test-project-123';
    },
  };

  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = async (url) => {
      const u = String(url);
      if (u.includes('fetchAvailableModels')) {
        // 模拟返回：5h 重置时间在 4.9 小时后（小于 5.5h）
        const futureReset = new Date(Date.now() + 4.9 * 3600 * 1000).toISOString();
        return {
          ok: true,
          status: 200,
          async json() {
            return {
              models: {
                'gemini-3.1-pro': {
                  name: 'gemini-3.1-pro',
                  quotaInfo: {
                    remainingFraction: 1.0,
                    resetTime: futureReset,
                  },
                },
              },
            };
          },
        };
      }
      if (u.includes('retrieveUserQuotaSummary')) {
        // 只有 Claude 组，缺少 Gemini 组
        return {
          ok: true,
          status: 200,
          async json() {
            return {
              groups: [
                {
                  displayName: 'Claude and GPT models',
                  buckets: [
                    { bucketId: '3p-5h', window: '5h', remainingFraction: 1.0 },
                    { bucketId: '3p-weekly', window: 'weekly', remainingFraction: 1.0 },
                  ],
                },
              ],
            };
          },
        };
      }
      return { ok: false, status: 404 };
    };

    const quota = await fetchRealQuota(mockTokenManager);
    assert.equal(quota.ok, true);
    // 5h 是真实 100%
    assert.equal(quota.gemini_5h.percentage, 100);
    assert.equal(quota.gemini_5h.bound, null);
    // 7d 自动推断为 bound: 'gte', 未触发周限，绝不为 null！
    assert.ok(quota.gemini_7d, 'gemini_7d 不应为 null');
    assert.equal(quota.gemini_7d.percentage, 100);
    assert.equal(quota.gemini_7d.bound, 'gte');
    assert.equal(quota.gemini_7d.reset_text, '未触发周限');
    assert.equal(quota.gemini_7d.reset_time, null); // 绝不抄 5h 的重置时间
    console.log('  ✓ 新号 7d 缺失时平滑推断下限 (bound: gte, reset_text: 未触发周限)，绝不显示暂无数据！');
  } finally {
    globalThis.fetch = originalFetch;
  }
}

console.log('🎉 所有 AG 额度解析与周约束单元测试全部通过！\n');
