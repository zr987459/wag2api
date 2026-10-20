/**
 * Unit Tests for OpenAI <-> AG Protocol Converter & Streamer
 */

import assert from 'assert';
import { signatureCache } from '../src/signature-cache.mjs';
import {
  openaiRequestToAnthropic,
  convertGoogleToOpenAI,
  handleOpenAIStreamConversion,
} from '../src/openai-ag-converter.mjs';

console.log('🧪 开始运行 AG 引擎 OpenAI 双协议兼容测试（包含 Hark 审查硬伤防御）...');

// 1. 测试请求转换：OpenAI -> Anthropic (含 response_format 与历史 assistant)
{
  const oaiReq = {
    model: 'gemini-3.8-flash-high',
    messages: [
      { role: 'system', content: 'You are a helpful assistant.' },
      { role: 'developer', content: 'Always speak politely.' },
      { role: 'user', content: 'Hello' },
      { role: 'assistant', content: 'Hi there!', reasoning_content: 'This should not create fake thinking blocks' },
      { role: 'user', content: 'What is 1+1?' },
    ],
    max_tokens: 4096,
    temperature: 0.7,
    reasoning_effort: 'high',
    response_format: { type: 'json_object' },
    tools: [
      {
        type: 'function',
        function: {
          name: 'get_weather',
          description: 'Get weather in city',
          parameters: {
            type: 'object',
            properties: { city: { type: 'string' } },
            required: ['city'],
          },
        },
      },
    ],
  };

  const antReq = openaiRequestToAnthropic(oaiReq);

  assert.strictEqual(antReq.model, 'gemini-3.8-flash-high');
  assert.strictEqual(antReq.system, 'You are a helpful assistant.\n\nAlways speak politely.');
  assert.strictEqual(antReq.messages.length, 3);
  assert.strictEqual(antReq.thinking?.type, 'enabled');
  assert.strictEqual(antReq.thinking?.budget_tokens, 24576);
  assert.deepStrictEqual(antReq.response_format, { type: 'json_object' }, 'response_format 必须透传');

  // P2 审查：assistant 消息中不能构造带假签名的 thinking 块
  const asst = antReq.messages[1];
  assert.strictEqual(asst.role, 'assistant');
  const hasThinking = asst.content.some(b => b.type === 'thinking');
  assert.strictEqual(hasThinking, false, '历史 assistant 不应包含无签名的 thinking 块');
  assert.strictEqual(asst.content[0].type, 'text');
  assert.strictEqual(asst.content[0].text, 'Hi there!');

  // 工具定义
  assert.strictEqual(antReq.tools.length, 1);
  assert.strictEqual(antReq.tools[0].name, 'get_weather');

  console.log('✅ 1. OpenAI -> Anthropic 请求体结构转换、response_format 透传与防假签名通过');
}

// 2. 测试非流式响应转换：Google -> OpenAI
{
  const googleJson = {
    response: {
      candidates: [
        {
          content: {
            parts: [
              { text: 'Analyzing math question...', thought: true },
              { text: '1 + 1 equals 2.' },
            ],
            role: 'model',
          },
          finishReason: 'STOP',
        },
      ],
      usageMetadata: {
        promptTokenCount: 15,
        candidatesTokenCount: 8,
        totalTokenCount: 23,
        thoughtsTokenCount: 4,
      },
    },
  };

  const oaiResp = convertGoogleToOpenAI(googleJson, 'gemini-3.8-flash-high');

  assert.strictEqual(oaiResp.object, 'chat.completion');
  assert.strictEqual(oaiResp.model, 'gemini-3.8-flash-high');
  assert.strictEqual(oaiResp.choices[0].finish_reason, 'stop');
  assert.strictEqual(oaiResp.choices[0].message.content, '1 + 1 equals 2.');
  assert.strictEqual(oaiResp.choices[0].message.reasoning_content, 'Analyzing math question...');
  assert.strictEqual(oaiResp.usage.completion_tokens_details.reasoning_tokens, 4);

  console.log('✅ 2. Google -> OpenAI 非流式响应与 reasoning_content 提取通过');
}

// 3. 测试流式响应转换：包含 Hark 指出的 P0 真实签名继承防御
{
  const REAL_SIGNATURE = 'REAL_TEST_SIGNATURE_ABC_123';
  const googleChunks = [
    JSON.stringify({
      response: {
        candidates: [{
          content: {
            parts: [
              { text: 'Thinking step...', thought: true, thoughtSignature: REAL_SIGNATURE },
            ],
          },
        }],
      },
    }),
    JSON.stringify({
      response: {
        candidates: [{
          content: {
            parts: [
              // functionCall part 本身没有带 thoughtSignature，必须继承上一帧的真实签名
              { functionCall: { id: 'call_test_123', name: 'search_db', args: { q: 'hello' } } },
            ],
          },
        }],
      },
    }),
    JSON.stringify({
      response: {
        candidates: [{ finishReason: 'STOP' }],
        usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5, thoughtsTokenCount: 3 },
      },
    }),
  ];

  const streamBody = new ReadableStream({
    start(controller) {
      for (const c of googleChunks) {
        controller.enqueue(new TextEncoder().encode(`data: ${c}\n\n`));
      }
      controller.close();
    },
  });

  const writtenChunks = [];
  const fakeClientRes = {
    setHeader() {},
    write(str) { writtenChunks.push(str); },
    flush() {},
    end() {},
    on() {},
    off() {},
  };

  let finishedUsage = null;
  await handleOpenAIStreamConversion(
    { body: streamBody },
    fakeClientRes,
    'gemini-3.8-flash-high',
    (u) => { finishedUsage = u; },
    Date.now()
  );

  const fullOutput = writtenChunks.join('');
  assert.ok(fullOutput.includes('reasoning_content'));
  assert.ok(fullOutput.includes('search_db'));
  assert.ok(fullOutput.includes('data: [DONE]'));
  assert.strictEqual(finishedUsage.outcome, 'ok');

  // P0 核心验证：检查 signatureCache 中保存的是否继承了真实签名
  const cachedSig = signatureCache.get('call_test_123');
  assert.strictEqual(cachedSig, REAL_SIGNATURE, 'functionCall 必须继承前面 thought 的真实签名');

  console.log('✅ 3. [P0 验证] 流式工具调用成功继承上文真实的 thoughtSignature');
}

// 4. 测试流式响应客户端中途断开：P1 审查验证
{
  const streamBody = new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ response: { candidates: [{ content: { parts: [{ text: 'Hi', thought: false }] } }] } })}\n\n`));
      // 故意不关闭，模拟中途挂起
    },
  });

  let closeCb = null;
  const fakeClientRes = {
    setHeader() {},
    write() {},
    flush() {},
    end() {},
    on(event, cb) {
      if (event === 'close') closeCb = cb;
    },
    off() {},
  };

  let clientAbortOutcome = null;
  const streamPromise = handleOpenAIStreamConversion(
    { body: streamBody },
    fakeClientRes,
    'gemini-3.8-flash-high',
    (u) => { clientAbortOutcome = u.outcome; },
    Date.now()
  );

  // 模拟客户端中途主动断开
  if (closeCb) closeCb();

  await streamPromise;
  assert.strictEqual(clientAbortOutcome, 'client_abort', '客户端主动断开必须准确记录为 client_abort，绝不能算作 ok');

  console.log('✅ 4. [P1 验证] 客户端中途断开准确识别为 client_abort 兜底通过');
}

console.log('🎉 所有针对 Hark 审查意见的加固用例全部 100% 通过！');
