/**
 * Unit Tests for OpenAI <-> AG Protocol Converter & Streamer
 */

import assert from 'assert';
import {
  openaiRequestToAnthropic,
  convertGoogleToOpenAI,
  handleOpenAIStreamConversion,
} from '../src/openai-ag-converter.mjs';

console.log('🧪 开始运行 AG 引擎 OpenAI 双协议兼容测试...');

// 1. 测试请求转换：OpenAI -> Anthropic
{
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
  assert.strictEqual(antReq.messages.length, 3); // 2 user, 1 assistant
  assert.strictEqual(antReq.thinking?.type, 'enabled');
  assert.strictEqual(antReq.thinking?.budget_tokens, 24576);

  // 检查 assistant 消息中的 thinking 块
  const asst = antReq.messages[1];
  assert.strictEqual(asst.role, 'assistant');
  assert.strictEqual(asst.content[0].type, 'thinking');
  assert.strictEqual(asst.content[0].thinking, 'Let me think about how to greet.');
  assert.strictEqual(asst.content[1].type, 'text');
  assert.strictEqual(asst.content[1].text, 'Hi there!');

  // 检查工具定义
  assert.strictEqual(antReq.tools.length, 1);
  assert.strictEqual(antReq.tools[0].name, 'get_weather');
  assert.deepStrictEqual(antReq.tools[0].input_schema.required, ['city']);

  console.log('✅ 1. OpenAI -> Anthropic 请求体结构转换与思维链提取通过');
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
          content: { parts: [{ text: 'Step 2 done.', thought: true }] },
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

  // 构造模拟的 upstream SSE 响应
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
    write(str) {
      writtenChunks.push(str);
    },
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
  assert.ok(fullOutput.includes('Think step 1...'), '必须包含思考内容第 1 块');
  assert.ok(fullOutput.includes('The answer is 42.'), '必须包含正文回复');
  assert.ok(fullOutput.includes('data: [DONE]'), '必须以 [DONE] 正常闭合');
  assert.ok(finishedUsage !== null, 'onFinish 回调必须被触发');
  assert.strictEqual(finishedUsage.thoughts_tokens, 6);

  console.log('✅ 3. Google SSE -> OpenAI SSE 流式打字机与 [DONE] 帧测试通过');
}

console.log('🎉 所有 OpenAI 双协议兼容测试全部通过！');
