/**
 * Unit Tests for OpenAI <-> AG Protocol Converter & Streamer (Strict)
 */

import assert from 'assert';
import {
  openaiRequestToAnthropic,
  convertGoogleToOpenAI,
  handleOpenAIStreamConversion,
} from '../src/openai-ag-converter.mjs';
import { signatureCache } from '../src/signature-cache.mjs';

console.log('🧪 开始运行 AG 引擎 OpenAI 双协议兼容测试 (含 Hark 审查加固)...');

// 1. 测试请求转换：OpenAI -> Anthropic (含 P1/P2 修复验证)
{
  const schema = { type: 'json_schema', json_schema: { name: 'test', schema: { type: 'object' } } };
  const oaiReq = {
    model: 'gemini-3.8-flash-high',
    messages: [
      { role: 'system', content: 'You are a helpful assistant.' },
      { role: 'developer', content: 'Always speak politely.' },
      { role: 'user', content: 'Hello' },
      { role: 'assistant', content: 'Hi there!', reasoning_content: 'Let me think about how to greet.' },
      { role: 'user', content: 'What is 1+1?' },
    ],
    max_tokens: 4096,
    temperature: 0.7,
    reasoning_effort: 'high',
    response_format: schema,
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

  // P1: response_format 透传
  assert.deepStrictEqual(antReq.response_format, schema, 'response_format 必须透传给 downstream');

  // P2: 历史 assistant 消息不构造带假签名的 thinking 块
  const asst = antReq.messages[1];
  assert.strictEqual(asst.role, 'assistant');
  assert.ok(!asst.content.some(b => b.type === 'thinking'), '历史 reasoning_content 不应生成 thinking 块');
  const textBlock = asst.content.find(b => b.type === 'text');
  assert.strictEqual(textBlock.text, 'Hi there!');

  // 检查工具定义
  assert.strictEqual(antReq.tools.length, 1);
  assert.strictEqual(antReq.tools[0].name, 'get_weather');

  console.log('✅ 1. OpenAI -> Anthropic 请求转换、response_format 透传与 P2 思考隔离通过');
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

// 3. 测试流式响应转换：Google SSE -> OpenAI SSE
{
  const googleChunks = [
    JSON.stringify({
      response: {
        candidates: [{
          content: { parts: [{ text: 'Think step 1...', thought: true }] },
        }],
      },
    }),
    JSON.stringify({
      response: {
        candidates: [{
          content: { parts: [{ text: 'The answer is 42.' }] },
        }],
      },
    }),
    JSON.stringify({
      response: {
        candidates: [{ finishReason: 'STOP' }],
        usageMetadata: {
          promptTokenCount: 10,
          candidatesTokenCount: 12,
          thoughtsTokenCount: 6,
        },
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

  const upstreamRes = { body: streamBody };
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
    upstreamRes,
    fakeClientRes,
    'gemini-3.8-flash-high',
    (u) => { finishedUsage = u; },
    Date.now()
  );

  const fullOutput = writtenChunks.join('');
  assert.ok(fullOutput.includes('chat.completion.chunk'), '必须包含 chat.completion.chunk');
  assert.ok(fullOutput.includes('reasoning_content'), '必须包含 reasoning_content');
  assert.ok(fullOutput.includes('Think step 1...'), '必须包含思考内容');
  assert.ok(fullOutput.includes('The answer is 42.'), '必须包含正文回复');
  assert.ok(fullOutput.includes('data: [DONE]'), '必须以 [DONE] 正常闭合');
  assert.strictEqual(finishedUsage?.outcome, 'ok');

  console.log('✅ 3. Google SSE -> OpenAI SSE 流式打字机与 [DONE] 帧测试通过');
}

// 4. [P0 重点用例] 流式工具调用签名继承：真实 thoughtSignature 必须继承至 functionCall
{
  const chunks = [
    JSON.stringify({
      response: {
        candidates: [{
          content: { parts: [{ text: 'Looking up weather...', thought: true, thoughtSignature: 'REAL_THOUGHT_SIGNATURE_999' }] },
        }],
      },
    }),
    JSON.stringify({
      response: {
        candidates: [{
          content: {
            parts: [
              { functionCall: { id: 'call_weather_1', name: 'get_weather', args: { city: 'Tokyo' } } },
            ],
          },
        }],
      },
    }),
    JSON.stringify({ response: { candidates: [{ finishReason: 'STOP' }] } }),
  ];

  const upstreamRes = {
    body: new ReadableStream({
      start(c) {
        for (const s of chunks) c.enqueue(new TextEncoder().encode(`data: ${s}\n\n`));
        c.close();
      },
    }),
  };

  const written = [];
  const fakeClientRes = {
    setHeader() {}, flush() {}, end() {}, on() {}, off() {},
    write(s) { written.push(s); },
  };

  let finishInfo = null;
  await handleOpenAIStreamConversion(upstreamRes, fakeClientRes, 'test-model', u => { finishInfo = u; });
  assert.strictEqual(finishInfo?.outcome, 'ok');

  // 断言签名缓存里成功拿到了真实签名，而不是 FALLBACK
  const cachedSig = signatureCache.get('call_weather_1');
  assert.strictEqual(cachedSig, 'REAL_THOUGHT_SIGNATURE_999', 'P0: functionCall 必须成功继承前序 thought 的真实签名');
  console.log('✅ 4. [P0] 真实 thoughtSignature 继承至 functionCall 验证通过');
}

// 5. [P1 重点用例] 客户端中途断开：必须记录 client_abort，绝不记录 ok
{
  let cancelled = false;
  const upstreamRes = {
    body: new ReadableStream({
      start(c) {
        c.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({
          response: { candidates: [{ content: { parts: [{ text: 'chunk 1' }] } }] },
        })}\n\n`));
      },
      cancel() { cancelled = true; },
    }),
  };

  let closeHandler = null;
  const written = [];
  const fakeClientRes = {
    setHeader() {}, flush() {}, end() {},
    on(ev, fn) { if (ev === 'close') closeHandler = fn; },
    off() {},
    write(s) { written.push(s); },
  };

  let finishInfo = null;
  const p = handleOpenAIStreamConversion(upstreamRes, fakeClientRes, 'test-model', u => { finishInfo = u; });

  await new Promise(r => setTimeout(r, 25));
  assert.ok(closeHandler, '必须监听 clientRes close 事件');
  closeHandler(); // 触发客户端主动断开
  await p;

  assert.strictEqual(finishInfo?.outcome, 'client_abort', 'P1: 客户端断开必须严格记录为 client_abort，不能误记为 ok');
  assert.ok(cancelled, '客户端断开必须主动 cancel 上游 reader 避免流量浪费');
  assert.ok(!written.join('').includes('data: [DONE]'), '客户端断开不应再补写 [DONE]');
  console.log('✅ 5. [P1] 客户端断开严格熔断并记录 client_abort 验证通过');
}

console.log('🎉 所有 Hark 审查加固用例全部 100% 通过！');
