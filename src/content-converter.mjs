/**
 * Bidirectional Protocol Converter (Anthropic <-> Google Cloud Code)
 *
 * 针对长上下文、深度思考（Thinking）与多轮工具调用的完整加固版本
 */

import crypto from 'crypto';
import { signatureCache, FALLBACK_THOUGHT_SIGNATURE } from './signature-cache.mjs';
import { scrubIdentity } from './scrub.mjs';
import { sanitizeSchema } from './schema-sanitizer.mjs';
import { historyPin, nearSameText, sameVisibleParts, sameToolNames, looksTrimmed } from './history-pin.mjs';
import { stripDowngradeNotice } from './downgrade-notice.mjs';
import { pinToolDescriptions } from './session-router.mjs';
import { normalizeGeminiUsage, toAnthropicUsage } from './usage.mjs';

/** 无会话 id 时的会话指纹：首条用户消息 + 首条模型回复的可见内容（忽略 thinking / 签名 / 空白差异）。首轮返回 ''。 */
export function fallbackConvSeed(messages) {
  const msgs = Array.isArray(messages) ? messages : [];
  const firstUser = msgs.find(m => m?.role === 'user');
  const firstModel = msgs.find(m => m?.role === 'assistant');
  if (!firstUser || !firstModel) return '';
  const vis = m => {
    if (typeof m.content === 'string') return [stripDowngradeNotice(m.content)];
    return (Array.isArray(m.content) ? m.content : []).map(b => {
      if (!b || b.type === 'thinking' || b.type === 'redacted_thinking') return '';
      if (b.type === 'text') return m.role === 'assistant' ? stripDowngradeNotice(b.text || '') : (b.text || '');
      if (b.type === 'tool_use') return 'tu:' + (b.name || '') + ':' + (b.id || '');
      if (b.type === 'tool_result') return 'tr:' + (b.tool_use_id || '');
      if (b.type === 'image') return 'img:' + String(b.source?.data || b.source?.url || '').length;
      return '';
    });
  };
  const norm = a => a.join('\n').replace(/\s+/g, ' ').trim();
  const u = norm(vis(firstUser)), a = norm(vis(firstModel));
  if (!a) return '';
  return 'fp:' + u + '\u0000' + a;
}

/**
 * 转换 Anthropic Request 为 Google Cloud Code / Gemini Request
 */
export function convertAnthropicToGoogle(anthropicRequest) {
  let systemInstruction = null;
  // Claude 上下文窗口较小，恢复被客户端裁剪的内容可能超限，只对 Gemini 启用历史锁定
  // 会话 key：
  //  1) 客户端带了会话 id（Claude Code 等）→ 直接用；
  //  2) 没带（多数 OpenAI 客户端）→ 用「首条用户消息 + 首条模型回复的可见内容」做指纹。
  //     只用首条消息会让"首条是固定前缀"的客户端所有对话撞同一个 key，导致串台；
  //     加上首条模型回复后每个对话天然不同，且客户端剥思考块/签名不影响指纹。
  //     还没有模型回复（首轮）时没有历史可锁，直接关闭锁定。
  const sessionKey = anthropicRequest._gwSessionKey || fallbackConvSeed(anthropicRequest.messages);
  historyPin.active = !String(anthropicRequest.model || '').toLowerCase().includes('claude') && Boolean(sessionKey);
  const conv = crypto.createHash('sha1').update(sessionKey || JSON.stringify((anthropicRequest.messages || [])[0] || '')).digest('hex').slice(0, 12);

  // 1. 处理 System Prompt 并清洗竞品标识
  if (anthropicRequest.system) {
    let sysText = '';
    if (typeof anthropicRequest.system === 'string') {
      sysText = anthropicRequest.system;
    } else if (Array.isArray(anthropicRequest.system)) {
      sysText = anthropicRequest.system.map(p => p.text || '').join('\n');
    }
    // 注意：严禁修改 System Prompt 中的稳定前缀，避免破坏 Google 上下文哈希导致缓存击穿
    if (sysText.trim()) {
      systemInstruction = {
        role: 'user',
        parts: [{ text: sysText }],
      };
    }
  }

  // 提前预扫描整个对话历史中的所有 tool_use，构建 call_id -> name 映射表
  const toolNameMap = new Map();
  for (const msg of anthropicRequest.messages || []) {
    if (Array.isArray(msg.content)) {
      for (const item of msg.content) {
        if (item.type === 'tool_use' && item.id && item.name) {
          toolNameMap.set(item.id, item.name);
        }
      }
    }
  }

  // 2. 遍历历史消息并构建严格符合 Google 规范的 parts
  const rawContents = [];

  for (const msg of anthropicRequest.messages || []) {
    const role = msg.role === 'assistant' ? 'model' : 'user';
    const parts = [];

    if (typeof msg.content === 'string') {
      const t = role === 'model' ? stripDowngradeNotice(msg.content) : msg.content;
      if (t.length > 0) {
        parts.push({ text: t });
      }
    } else if (Array.isArray(msg.content)) {
      for (const item of msg.content) {
        if (item.type === 'text') {
          // PR1：剔掉网关插入的降级提示行，永不发回模型；剔完与从未插入时字节一致
          const t = role === 'model' ? stripDowngradeNotice(item.text) : item.text;
          if (t) parts.push({ text: t });
        } else if (item.type === 'thinking') {
          // 仅当思考块有文本时保留，附带合法思考签名
          if (item.thinking) {
            parts.push({
              thought: true,
              text: item.thinking,
              thoughtSignature: item.signature || FALLBACK_THOUGHT_SIGNATURE,
            });
          }
        } else if (item.type === 'tool_use') {
          // Assistant 工具调用：Google 强制要求携带 thoughtSignature
          // 注意：Google 原生 functionCall 结构体仅有 { name, args }，不能附带客户端私有的 id 字段，否则会改变 Canonical 前缀哈希导致缓存击穿
          const callId = item.id;
          const sig = signatureCache.get(callId) || FALLBACK_THOUGHT_SIGNATURE;
          parts.push({
            thoughtSignature: sig,
            functionCall: {
              name: item.name,
              args: historyPin.pinIf(conv + ':fc:' + callId + ':' + item.name, item.input || {}, (prev, cur) => JSON.stringify(prev) === JSON.stringify(cur) || JSON.stringify(cur).length < JSON.stringify(prev).length),
            },
          });
        } else if (item.type === 'tool_result') {
          // User 工具返回结果：确保 name 与之前的 functionCall 完全一致
          const toolCallId = item.tool_use_id;
          const actualName = item.name || toolNameMap.get(toolCallId) || signatureCache.getName(toolCallId) || 'tool_response';
          
          let responseContent = item.content;
          if (typeof responseContent !== 'string') {
            responseContent = JSON.stringify(responseContent);
          }
          responseContent = historyPin.pinIf(conv + ':fr:' + toolCallId + ':' + actualName, responseContent, looksTrimmed);

          parts.push({
            functionResponse: {
              name: actualName,
              response: {
                output: responseContent,
                content: responseContent,
              },
            },
          });
        } else if (item.type === 'image' && item.source?.data) {
          parts.push({
            inlineData: {
              mimeType: item.source.media_type || 'image/jpeg',
              data: item.source.data,
            },
          });
        }
      }
    }

    if (parts.length > 0) {
      rawContents.push({ role, parts });
    }
  }

  // 3. 规范化 contents：合并连续相同角色，确保以 user 开头
  const contents = [];
  for (const item of rawContents) {
    if (contents.length > 0 && contents[contents.length - 1].role === item.role) {
      // 连续相同 role，合并其 parts
      contents[contents.length - 1].parts.push(...item.parts);
    } else {
      contents.push(item);
    }
  }

  // 确保第一条消息必须是 user 角色
  if (contents.length > 0 && contents[0].role === 'model') {
    contents.unshift({
      role: 'user',
      parts: [{ text: '' }],
    });
  }

  // 4. 处理工具声明 (Tools) 并清洗 Schema (按工具名排序固化 + 会话级工具全量锁定，保护前缀缓存哈希)
  let tools = undefined;
  if (anthropicRequest.tools && anthropicRequest.tools.length > 0) {
    const sortedTools = [...anthropicRequest.tools].sort((a, b) => (a.name || '').localeCompare(b.name || ''));
    let functionDeclarations = sortedTools.map(t => ({
      name: t.name,
      description: t.description || '',
      parameters: sanitizeSchema(t.input_schema || {}),
    }));
    // 会话级全量工具声明锁定：Pi/Claude 在后续特定轮次（如运行子工具、测试等）可能会微调个别工具的入参或说明，
    // 这会导致顶层 tools 哈希瞬变，进而击穿整个 10 万+ Token 的长会话缓存。在此强制锁定首轮的工具全量声明。
    if (historyPin.active) {
      functionDeclarations = historyPin.pinIf(conv + ':tools', functionDeclarations, sameToolNames);
    } else {
      functionDeclarations = pinToolDescriptions(conv, functionDeclarations);
    }
    tools = [{ functionDeclarations }];
  }

  // 客户端回传旧历史时常会改动换行符（CRLF \r\n vs LF \n）或末尾空白，对所有文本及工具返回做全局换行统一与尾部空白修剪，保证同一轮次字节级 100% 幂等一致。
  for (let idx = 0; idx < contents.length; idx++) {
    const c = contents[idx];
    for (const part of c.parts) {
      if (typeof part.text === 'string' && !part.thought) {
        part.text = part.text.replace(/\r\n/g, '\n').trimEnd();
      }
      if (part.functionResponse?.response && typeof part.functionResponse.response.output === 'string') {
        part.functionResponse.response.output = part.functionResponse.response.output.replace(/\r\n/g, '\n').trimEnd();
        if (typeof part.functionResponse.response.content === 'string') {
          part.functionResponse.response.content = part.functionResponse.response.content.replace(/\r\n/g, '\n').trimEnd();
        }
      }
    }
    // 对既往模型回复结构体（c.parts）进行全量快照锁定：
    // 当用户发起大文本长输出（如 5000 字）或切换为极速模式时，某些客户端（如 Pi / Claude Web）会偷偷将历史模型消息里的
    // 思考块（thinking/thought）截断、降级为普通 text，或剥离思考签名。
    // 这会导致从最前面的第 1 条模型消息起，哈希瞬间发生断裂，导致后续整整 24 万+ Token 的庞大缓存全盘清零（0%）！
    // 在此锁定首次见到的模型完整 parts（含 thought 标识与原始签名），彻底免疫客户端的中间修剪！
    if (c.role === 'model' && historyPin.active) {
      c.parts = historyPin.pinIf(`${conv}:model_parts:${idx}`, c.parts, sameVisibleParts);
    }
  }


  // 5. 首条用户提示词锁定：客户端在多轮长会话中若微调了最初的引导语（如补充环境信息、时间戳），强制还原为首轮文本，防止从第 0 条消息开始前缀哈希断裂
  if (historyPin.active && contents.length > 0 && contents[0].role === 'user') {
    const firstPart = contents[0].parts?.[0];
    if (firstPart && typeof firstPart.text === 'string') {
      firstPart.text = historyPin.pinIf(conv + ':u:0', firstPart.text, nearSameText);
    }
  }

  // 6. 系统提示词锁定：
  //    注意：绝不能把变化部分作为 <system-reminder> 强行塞进 contents[last]，
  //    因为下一轮客户端回传时本地历史里没有这段文字，会导致该轮以后的所有历史消息永久性前缀击穿！
  //    如果开启了历史锁定，仅对 systemInstruction 本身做稳定化。
  if (historyPin.active && systemInstruction) {
    const cur = systemInstruction.parts[0].text;
    const pinned = historyPin.pinIf(conv + ':sys', cur, nearSameText);
    if (pinned) {
      systemInstruction = { role: 'user', parts: [{ text: pinned }] };
    }
  }

  return {
    contents,
    systemInstruction,
    tools,
  };
}

/**
 * 将非流式 Google 响应转为 Anthropic Message
 */
export function convertGoogleToAnthropic(googleData, originalModel) {
  const responseObj = googleData?.response || googleData;
  const candidate = responseObj?.candidates?.[0];
  const parts = candidate?.content?.parts || [];
  const anthropicContent = [];

  let stopReason = 'end_turn';

  for (const part of parts) {
    const sig = part.thoughtSignature || part.thought_signature;

    if (part.thought) {
      anthropicContent.push({
        type: 'thinking',
        thinking: part.text || '',
        signature: sig || FALLBACK_THOUGHT_SIGNATURE,
      });
    } else if (part.text !== undefined && part.text !== '') {
      anthropicContent.push({
        type: 'text',
        text: part.text,
      });
    }

    if (part.functionCall) {
      stopReason = 'tool_use';
      const callId = part.functionCall.id || `toolu_${crypto.randomBytes(12).toString('hex')}`;
      if (sig) {
        signatureCache.set(callId, sig, part.functionCall.name);
      } else {
        signatureCache.set(callId, FALLBACK_THOUGHT_SIGNATURE, part.functionCall.name);
      }

      anthropicContent.push({
        type: 'tool_use',
        id: callId,
        name: part.functionCall.name,
        input: part.functionCall.args || {},
      });
    }
  }

  // 兜底：如果内容为空，补一个空文本块防止下游客户端解析崩溃
  if (anthropicContent.length === 0) {
    anthropicContent.push({ type: 'text', text: '' });
  }

  const usage = normalizeGeminiUsage(responseObj?.usageMetadata);

  const message = {
    id: `msg_${crypto.randomBytes(12).toString('hex')}`,
    type: 'message',
    role: 'assistant',
    model: originalModel,
    content: anthropicContent,
    stop_reason: stopReason,
    stop_sequence: null,
    usage: toAnthropicUsage(usage),
  };
  // 网关内部记账用（含思考 token 明细）；不可枚举，JSON.stringify 不会输出给客户端
  Object.defineProperty(message, '_gw_usage', { value: usage, enumerable: false });
  return message;

}
