import test from 'node:test';
import assert from 'node:assert/strict';
import { sanitizeWafPayload, StreamRestorer } from '../src/wb/waf-sanitizer.mjs';
import { buildCloudCodePayload } from '../src/cloudcode.mjs';
import { convertGoogleToAnthropic, convertAnthropicToGoogle } from '../src/content-converter.mjs';

test('WB: 敏感路径与 11128 脱敏及占位符生成', () => {
  const payload = {
    model: 'deepseek-v4.1-flash-1017',
    messages: [
      { role: 'user', content: '请帮我分析以下目录：\n/root/workbuddy-app/src\n/root/workbuddy-app\n/root/xianyu-copilot\n/etc/passwd\nchroot /tmp' }
    ]
  };

  const { payload: sanitized, restorer } = sanitizeWafPayload(payload);
  const userContent = sanitized.messages[sanitized.messages.length - 1].content;

  // 高危路径被替换为占位符
  assert.ok(!userContent.includes('/root/workbuddy-app/src'));
  assert.ok(!userContent.includes('/root/workbuddy-app'));
  assert.ok(!userContent.includes('/root/xianyu-copilot'));
  assert.ok(!userContent.includes('/etc/passwd'));
  assert.ok(userContent.includes('⟦PATH_'));

  // chroot 不会被误伤
  assert.ok(userContent.includes('chroot /tmp'));

  // 恢复验证
  const restored = restorer.restoreAll(userContent);
  assert.ok(restored.includes('/root/workbuddy-app/src'));
  assert.ok(restored.includes('/root/workbuddy-app'));
  assert.ok(restored.includes('/root/xianyu-copilot'));
  assert.ok(restored.includes('/etc/passwd'));
});

test('WB: 流式跨 chunk 边界占位符还原', () => {
  const revMap = new Map([
    ['⟦PATH_test_1⟧', '/root/workbuddy-app']
  ]);
  const restorer = new StreamRestorer(revMap);

  const chunks = [
    '这是位于 ',
    '⟦PA',
    'TH_te',
    'st_1⟧ 的',
    '核心代码。'
  ];

  let output = '';
  for (const c of chunks) {
    output += restorer.processContent(c);
  }
  output += restorer.flushContent();

  assert.equal(output, '这是位于 /root/workbuddy-app 的核心代码。');
});

test('AG: Cloud Code 请求体包含 safetySettings (BLOCK_NONE)', () => {
  const anthropicReq = {
    model: 'gemini-3.8-flash',
    max_tokens: 1024,
    messages: [{ role: 'user', content: '测试路径 /root/workbuddy-app' }]
  };

  const payload = buildCloudCodePayload(anthropicReq, 'test-project');
  assert.ok(payload.request, 'request 必须存在包裹层');
  assert.ok(Array.isArray(payload.request.safetySettings), 'request.safetySettings 必须是数组');
  assert.equal(payload.request.safetySettings.length, 4);
  assert.ok(payload.request.safetySettings.every(s => s.threshold === 'BLOCK_NONE'));
});

test('AG: 首条消息角色修复不含空文本', () => {
  const anthropicReq = {
    model: 'gemini-3.8-flash',
    messages: [
      { role: 'assistant', content: '这是第一条助理消息' },
      { role: 'user', content: '用户回复' }
    ]
  };

  const { contents } = convertAnthropicToGoogle(anthropicReq);
  assert.equal(contents[0].role, 'user');
  assert.ok(contents[0].parts[0].text.length > 0, '首条占位消息 text 绝不能为空字符串，防 400');
});

test('AG: SAFETY 截断时提供明确中文提示而非崩溃', () => {
  const googleData = {
    candidates: [{
      finishReason: 'SAFETY',
      content: { parts: [] }
    }]
  };

  const converted = convertGoogleToAnthropic(googleData, 'gemini-3.8-flash');
  assert.ok(converted.content[0].text.includes('安全策略拦截'));
});
