import test from 'node:test';
import assert from 'node:assert/strict';
import { sanitizeWafPayload, StreamRestorer } from '../src/wb/waf-sanitizer.mjs';
import { DEFAULT_SYSTEM_PROMPT } from '../src/wb/constants.mjs';
import { buildCloudCodePayload } from '../src/cloudcode.mjs';
import { convertGoogleToAnthropic, convertAnthropicToGoogle } from '../src/content-converter.mjs';

test('WB: 敏感路径尾斜杠、通配符、tool_calls 参数与 11128 可逆脱敏', () => {
  const payload = {
    model: 'deepseek-v4.1-flash-1017',
    messages: [
      { role: 'user', content: '查看命令：ls /root/ 以及 cd /etc/nginx/ 和 /root/*.log' },
      {
        role: 'assistant',
        content: '我来读取系统配置',
        tool_calls: [
          {
            id: 'call_1',
            type: 'function',
            function: {
              name: 'read_file',
              arguments: JSON.stringify({ path: '/etc/shadow', port: 11128 }),
            },
          },
        ],
      },
    ],
  };

  const { payload: sanitized, restorer } = sanitizeWafPayload(payload);
  const sysMsg = sanitized.messages.find(m => m.role === 'system');
  const userMsg = sanitized.messages.find(m => m.role === 'user');
  const asstMsg = sanitized.messages.find(m => m.role === 'assistant');
  const userContent = userMsg.content;
  const toolArgs = asstMsg.tool_calls[0].function.arguments;

  // 1. 验证尾斜杠与通配符全部被脱敏
  assert.ok(!userContent.includes('/root/'), '尾斜杠 /root/ 必须被脱敏');
  assert.ok(!userContent.includes('/etc/nginx/'), '尾斜杠 /etc/nginx/ 必须被脱敏');
  assert.ok(!userContent.includes('/root/*.log'), '通配符 /root/*.log 必须被脱敏');
  assert.ok(userContent.includes('⟦PATH_'));

  // 2. 验证 tool_calls[].function.arguments 里的高危路径与 11128 被脱敏
  assert.ok(!toolArgs.includes('/etc/shadow'), 'tool_calls 参数里的 /etc/shadow 必须被脱敏');
  assert.ok(!toolArgs.includes('11128'), 'tool_calls 参数里的 11128 必须被脱敏');
  assert.ok(toolArgs.includes('⟦PATH_'));
  assert.ok(toolArgs.includes('⟦SIG_'));

  // 3. 验证没有 system 时自动补齐 DEFAULT_SYSTEM_PROMPT
  assert.ok(sysMsg, '系统提示词必须存在');
  assert.ok(sysMsg.content.startsWith(DEFAULT_SYSTEM_PROMPT), '必须保留 WorkBuddy 默认官方身份');

  // 4. 验证完全可逆还原（含 11128 与参数）
  const restoredUser = restorer.restoreAll(userContent);
  assert.ok(restoredUser.includes('ls /root/'));
  assert.ok(restoredUser.includes('cd /etc/nginx/'));
  assert.ok(restoredUser.includes('/root/*.log'));

  const restoredArgs = restorer.restoreAll(toolArgs);
  assert.ok(restoredArgs.includes('/etc/shadow'));
  assert.ok(restoredArgs.includes('11128'));
});

test('WB: 流式跨 chunk 边界占位符还原 (含 args 与 content)', () => {
  const revMap = new Map([
    ['⟦PATH_test_1⟧', '/root/workbuddy-app/src/'],
  ]);
  const restorer = new StreamRestorer(revMap);

  // 模拟 content 分片
  const chunks = ['这是位于 ', '⟦PA', 'TH_te', 'st_1⟧ 的', '目录。'];
  let contentOut = '';
  for (const c of chunks) contentOut += restorer.processContent(c);
  contentOut += restorer.flushContent();
  assert.equal(contentOut, '这是位于 /root/workbuddy-app/src/ 的目录。');

  // 模拟 args 分片
  const argChunks = ['{"path":"', '⟦PATH_te', 'st_1⟧"}'];
  let argsOut = '';
  for (const a of argChunks) argsOut += restorer.processArgs(a);
  argsOut += restorer.flushArgs();
  assert.equal(argsOut, '{"path":"/root/workbuddy-app/src/"}');
});

test('AG: 边界轮次规范化（空轮次清理、相邻合并与 user 起始）', () => {
  // 用例 A：首条只有空格的 user，后接 assistant 和 user
  const reqA = {
    model: 'gemini-3.8-flash',
    messages: [
      { role: 'user', content: '   ' },
      { role: 'assistant', content: '回复' },
      { role: 'user', content: '新问题' },
    ],
  };
  const { contents: contentsA } = convertAnthropicToGoogle(reqA);
  assert.equal(contentsA[0].role, 'user', '第一条必须是 user');
  assert.equal(contentsA[0].parts[0].text, 'Hello', '空 user 被删后，模型前必须补有效的 user 轮次');
  assert.equal(contentsA[1].role, 'model');
  assert.equal(contentsA[2].role, 'user');

  // 用例 B：中间夹杂空文本 assistant 的情况
  const reqB = {
    model: 'gemini-3.8-flash',
    messages: [
      { role: 'user', content: '第一问' },
      { role: 'assistant', content: ' ' },
      { role: 'user', content: '第二问' },
    ],
  };
  const { contents: contentsB } = convertAnthropicToGoogle(reqB);
  // 空 assistant 被删后，两个 user 应该合并为 1 条 user
  assert.equal(contentsB.length, 1);
  assert.equal(contentsB[0].role, 'user');
  assert.equal(contentsB[0].parts.length, 2);
});

test('AG: Cloud Code 请求体注入 safetySettings (BLOCK_NONE)', () => {
  const anthropicReq = {
    model: 'gemini-3.8-flash',
    max_tokens: 1024,
    messages: [{ role: 'user', content: '测试路径 /root/workbuddy-app' }],
  };

  const payload = buildCloudCodePayload(anthropicReq, 'test-project');
  assert.ok(payload.request, 'request 必须存在包裹层');
  assert.ok(Array.isArray(payload.request.safetySettings), 'request.safetySettings 必须是数组');
  assert.equal(payload.request.safetySettings.length, 4);
  assert.ok(payload.request.safetySettings.every(s => s.threshold === 'BLOCK_NONE'));
});

test('AG: SAFETY 截断时提供明确中文提示而非崩溃', () => {
  const googleData = {
    candidates: [{
      finishReason: 'SAFETY',
      content: { parts: [] },
    }],
  };

  const converted = convertGoogleToAnthropic(googleData, 'gemini-3.8-flash');
  assert.ok(converted.content[0].text.includes('安全策略拦截'));
});
