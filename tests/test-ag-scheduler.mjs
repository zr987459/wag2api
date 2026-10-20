/**
 * Unit Tests for AG Smart Multi-Account Scheduler
 * (Session Affinity, Least Used Load Distribution, 429 Cooldown)
 */

import assert from 'assert';
import fs from 'fs';
import path from 'path';
import { AccountPool } from '../src/account-pool.mjs';

console.log('🧪 开始运行 AG 智能多账号并发调度器测试...');

const testDir = path.resolve('data/test-ag-scheduler-' + Date.now());
fs.mkdirSync(testDir, { recursive: true });

try {
  const pool = new AccountPool(testDir);

  // 添加三个测试账号
  pool.addAccount('fake-token-1', 'account1@gmail.com');
  pool.addAccount('fake-token-2', 'account2@gmail.com');
  pool.addAccount('fake-token-3', 'account3@gmail.com');

  assert.strictEqual(pool.managers.size, 3);
  console.log('✅ 1. 成功初始化 3 个 Google 测试账号');

  // 1. 自动智能轮询测试 (LRU 均摊负载)
  const a1 = pool.pickManager();
  const a2 = pool.pickManager();
  const a3 = pool.pickManager();
  assert.ok(a1 && a2 && a3);
  const pickedEmails = new Set([a1.tokenData.email, a2.tokenData.email, a3.tokenData.email]);
  assert.strictEqual(pickedEmails.size, 3, '连续调度新请求必须均摊分派到不同账号');
  console.log('✅ 2. 多账号并发自动分发 (负载均摊) 验证通过');

  // 2. 会话粘滞测试 (Session Affinity 保住 KV-Cache)
  const sessionA = 'session-user-alice-chat-1';
  const mgrA1 = pool.pickManager(sessionA);
  const assignedEmail = mgrA1.tokenData.email;

  // 连续多次以相同 sessionKey 访问，必须 100% 返回同一个账号！
  for (let i = 0; i < 5; i++) {
    const mgr = pool.pickManager(sessionA);
    assert.strictEqual(mgr.tokenData.email, assignedEmail, '同一会话必须严格锁定同一账号以保持 KV-Cache');
  }
  console.log('✅ 3. [核心能力] 会话亲和表 (Session Affinity) 验证通过，100% 锁定同一账号');

  // 3. 手动选择账号测试 (强制锁定)
  pool.setSelectedEmail('account2@gmail.com');
  assert.strictEqual(pool.getSelectedEmail(), 'account2@gmail.com');
  for (let i = 0; i < 3; i++) {
    const mgr = pool.pickManager('new-random-session-' + i);
    assert.strictEqual(mgr.tokenData.email, 'account2@gmail.com', '手动指定账号时必须优先使用');
  }
  // 切回自动轮询
  pool.setSelectedEmail('');
  assert.strictEqual(pool.getSelectedEmail(), '');
  console.log('✅ 4. 手动锁定与「自动轮询」双模式切换验证通过');

  // 4. 429 智能冷却与自动避障测试
  pool.markCooling('account1@gmail.com', 5000);
  assert.strictEqual(pool.isCooling('account1@gmail.com'), true);
  assert.ok(pool.cooldownRemainSec('account1@gmail.com') > 0);

  // 调度时不应选中冷却中的 account1
  for (let i = 0; i < 6; i++) {
    const mgr = pool.pickManager('random-session-' + i);
    assert.notStrictEqual(mgr.tokenData.email, 'account1@gmail.com', '冷却中的账号必须被自动跳过');
  }
  console.log('✅ 5. [429 避障] 冷却账号自动绕行验证通过');

  // 5. 会话绑定的账号遇冷却自动换号并重新粘滞测试
  pool.bindSession('test-session-bob', 'account1@gmail.com');
  // 此时 account1 正在冷却，Bob 发起提问，必须被重派到未冷却账号
  const bobNewMgr = pool.pickManager('test-session-bob');
  assert.notStrictEqual(bobNewMgr.tokenData.email, 'account1@gmail.com', '绑定的账号冷却时必须自动换号重试');
  // 下一次 Bob 再次提问，亲和表已更新为新账号
  const bobNextMgr = pool.pickManager('test-session-bob');
  assert.strictEqual(bobNextMgr.tokenData.email, bobNewMgr.tokenData.email, '换号后会话亲和表必须无缝更新');
  console.log('✅ 6. 会话遇冷自动换号与亲和表延迟重绑验证通过');

  // 6. 兼容性测试：switchAccount 不报 500
  pool.switchAccount('account3@gmail.com');
  assert.strictEqual(pool.getActiveManager().tokenData.email, 'account3@gmail.com');
  pool.switchAccount('');
  console.log('✅ 7. [P0 验证] switchAccount 兼容别名调用正常');

  // 清除冷却
  pool.clearAllCooldowns();
  assert.strictEqual(pool.isCooling('account1@gmail.com'), false);
  console.log('✅ 8. 清除冷却验证通过');

} finally {
  try { fs.rmSync(testDir, { recursive: true, force: true }); } catch (e) {}
}

console.log('🎉 所有 AG 智能多账号并发调度器测试 100% 全部通过！');
