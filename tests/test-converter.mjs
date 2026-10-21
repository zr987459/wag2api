import assert from 'assert';
import { sanitizeSchema } from '../src/schema-sanitizer.mjs';
import { scrubIdentity } from '../src/scrub.mjs';
import { convertAnthropicToGoogle } from '../src/content-converter.mjs';
import { signatureCache } from '../src/signature-cache.mjs';
import { buildCloudCodePayload } from '../src/cloudcode.mjs';

console.log('🧪 开始运行协议转换与清洗单元测试...');

// 1. 测试 Schema 清洗
const rawSchema = {
  type: 'object',
  $schema: 'http://json-schema.org/draft-07/schema#',
  properties: {
    command: { type: 'string', description: 'Bash command' },
    mode: { const: 'fast' },
    nested: {
      type: 'object',
      properties: {
        flag: { type: 'boolean' }
      }
    }
  },
  required: ['command']
};

const cleaned = sanitizeSchema(rawSchema);
assert.strictEqual(cleaned.type, 'OBJECT');
assert.strictEqual(cleaned.$schema, undefined, '$schema 必须被剔除');
assert.deepStrictEqual(cleaned.properties.mode.enum, ['fast'], 'const 必须转换为 enum');
assert.strictEqual(cleaned.properties.nested.type, 'OBJECT');
console.log('✅ 1. JSON Schema 白名单清洗与类型大写转换测试通过');

// 2. 测试身份脱敏
const systemPrompt = 'You are Claude Code developed by Anthropic. Team: Hermes Agent.';
const scrubbed = scrubIdentity(systemPrompt);
assert(!scrubbed.includes('Claude Code'));
assert(!scrubbed.includes('Hermes Agent'));
console.log('✅ 2. 系统提示词身份指纹脱敏测试通过');

// 3. 测试思考签名回填 (Thought Signature Injection)
signatureCache.set('call_test_123', 'SIG_GOOGLE_CIPHER_ABC');

const anthropicReq = {
  model: 'gemini-3.8-flash-high',
  system: 'You are an engineer.',
  messages: [
    {
      role: 'user',
      content: 'Run ls'
    },
    {
      role: 'assistant',
      content: [
        {
          type: 'tool_use',
          id: 'call_test_123',
          name: 'bash',
          input: { command: 'ls' }
        }
      ]
    },
    {
      role: 'user',
      content: [
        {
          type: 'tool_result',
          tool_use_id: 'call_test_123',
          content: 'file1.txt\nfile2.txt'
        }
      ]
    }
  ],
  tools: [
    {
      name: 'bash',
      description: 'Run bash',
      input_schema: rawSchema
    }
  ]
};

const googleReq = convertAnthropicToGoogle(anthropicReq);
assert.strictEqual(googleReq.contents.length, 3);
// 验证 assistant 的 tool_use 中是否被成功注入了思考签名 (Google 要求在 assistant 的 functionCall 上附带 thoughtSignature)
const assistantToolUsePart = googleReq.contents[1].parts[0];
assert.strictEqual(assistantToolUsePart.thoughtSignature, 'SIG_GOOGLE_CIPHER_ABC', '思考签名必须被自动缝合在 assistant tool_use');
console.log('✅ 3. 工具调用上下文的思考签名回填测试通过');

// 4. 测试 functionResponse 单份 output（消除双倍上传开销）
const userResultPart = googleReq.contents[2].parts[0];
assert(userResultPart.functionResponse, '必须存在 functionResponse');
assert.strictEqual(userResultPart.functionResponse.response.output, 'file1.txt\nfile2.txt');
assert.strictEqual(userResultPart.functionResponse.response.content, undefined, '冗余的 content 必须已被剔除');
console.log('✅ 4. functionResponse 冗余 content 消除测试通过 (体积直降 50%)');

// 5. Hark 审查要求的 4 种思考档位断言
// 5.1 Flash 默认无后缀 -> low + budget 0 (极速秒出字)
const pFlashDefault = buildCloudCodePayload({ model: 'gemini-3.8-flash', messages: [{ role: 'user', content: 'hi' }] });
assert.strictEqual(pFlashDefault.request.generationConfig.thinkingConfig.thinkingLevel, 'low');
assert.strictEqual(pFlashDefault.request.generationConfig.thinkingConfig.thinkingBudget, 0);

// 5.2 Flash + budget_tokens=16000 -> high (尊重显式高预算)
const pFlashBudget = buildCloudCodePayload({ model: 'gemini-3.8-flash', thinking: { type: 'enabled', budget_tokens: 16000 }, messages: [{ role: 'user', content: 'hi' }] });
assert.strictEqual(pFlashBudget.request.generationConfig.thinkingConfig.thinkingLevel, 'high');

// 5.3 Flash + reasoning_effort=high -> high (尊重显式 effort)
const pFlashEffort = buildCloudCodePayload({ model: 'gemini-3.8-flash', reasoning_effort: 'high', messages: [{ role: 'user', content: 'hi' }] });
assert.strictEqual(pFlashEffort.request.generationConfig.thinkingConfig.thinkingLevel, 'high');

// 5.4 Pro 系列模型默认不降级 -> high (保持旗舰质量)
const pProDefault = buildCloudCodePayload({ model: 'gemini-3.1-pro', messages: [{ role: 'user', content: 'hi' }] });
assert.strictEqual(pProDefault.request.generationConfig.thinkingConfig.thinkingLevel, 'high');
console.log('✅ 5. Hark 思考档位 4 种边界测试全部通过 (显式思考全量满足，Flash 默认极速)');

console.log('🎉 所有协议转换核心验证全部通过！');
