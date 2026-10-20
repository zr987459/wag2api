/**
 * OpenAI Chat Completions 兼容转换器 (for Google Antigravity / Cloud Code)
 *
 * 核心功能：
 * 1. openaiRequestToAnthropic: 将客户端发送的 OpenAI ChatCompletion 请求转换为内部 Anthropic 结构
 * 2. convertGoogleToOpenAI: 将 Google 原生非流式响应转换为标准的 OpenAI chat.completion 结构
 * 3. handleOpenAIStreamConversion: 将 Google 原生 SSE 流实时转换为标准 OpenAI SSE 打字机流（含 delta.reasoning_content）
 *
 * 关键健壮性防护：
 * - [P0] 流式工具调用签名回退：继承上游随路下发的 latestSeenSignature，防止次轮 400
 * - [P1] 客户端断开判定：clientGone 时强制触发 client_abort 终态，绝不误记为 ok
 * - [P1] 透传 response_format 保证 JSON Schema 与结构化输出不丢失
 * - [P2] 过滤 assistant 历史消息中未签名的假 thinking 块，杜绝 Google 400 报 invalid thought_signature
 */

import crypto from 'crypto';
import { signatureCache, FALLBACK_THOUGHT_SIGNATURE } from './signature-cache.mjs';
import { normalizeGeminiUsage, mergeRawUsage } from './usage.mjs';

const isObj = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const str = (o, k) => (o && o[k] != null ? String(o[k]) : '');
const newId = p => `${p}${crypto.randomUUID().replace(/-/g, '').slice(0, 24)}`;

/**
 * 将单个 content 块（OpenAI 格式）转为 Anthropic 格式
 */
function partToAnthropic(p) {
  if (typeof p === 'string') return { type: 'text', text: p };
  if (!isObj(p)) return null;
  if (p.type === 'text') return { type: 'text', text: str(p, 'text') };
  if (p.type === 'image_url') {
    const url = isObj(p.image_url) ? str(p.image_url, 'url') : str(p, 'image_url');
    if (!url) return null;
    const m = /^data:([^;]+);base64,(.+)$/i.exec(url);
    if (m) {
      return { type: 'image', source: { type: 'base64', media_type: m[1], data: m[2] } };
    }
    return { type: 'image', source: { type: 'url', url } };
  }
  return null;
}

/**
 * 转换 user 消息 content
 */
function userContentToAnthropic(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.map(partToAnthropic).filter(Boolean);
}

/**
 * 转换 assistant 消息，含思考和 tool_calls
 * 注意 [P2] 防护：绝不为纯文本 reasoning_content 构造无有效签名的 thinking 块，
 * 否则送往 Google / Claude-on-AG 时会直接报 invalid thought_signature 400 错误。
 */
function assistantContentToAnthropic(content, toolCalls) {
  const blocks = [];
  if (typeof content === 'string' && content) {
    blocks.push({ type: 'text', text: content });
  } else if (Array.isArray(content)) {
    for (const p of content) {
      const b = partToAnthropic(p);
      if (b) blocks.push(b);
    }
  }

  if (Array.isArray(toolCalls)) {
    for (const c of toolCalls) {
      if (!isObj(c)) continue;
      const f = isObj(c.function) ? c.function : {};
      let input = {};
      const raw = str(f, 'arguments');
      if (raw) {
        try { input = JSON.parse(raw); } catch (e) { input = { _raw: raw }; }
      }
      blocks.push({
        type: 'tool_use',
        id: str(c, 'id') || newId('toolu_'),
        name: str(f, 'name'),
        input: isObj(input) ? input : {},
      });
    }
  }
  return blocks;
}

/**
 * 核心：OpenAI 请求体 -> Anthropic 请求体
 */
export function openaiRequestToAnthropic(oai) {
  if (!isObj(oai)) throw new Error('无效的 OpenAI 请求体');

  const out = { model: str(oai, 'model') };

  const maxTok = oai.max_completion_tokens ?? oai.max_tokens;
  if (maxTok != null) out.max_tokens = parseInt(maxTok, 10) || 8192;

  for (const k of ['temperature', 'top_p']) {
    if (oai[k] != null) out[k] = oai[k];
  }
  if (Array.isArray(oai.stop)) out.stop_sequences = oai.stop;
  else if (typeof oai.stop === 'string' && oai.stop) out.stop_sequences = [oai.stop];

  // 思考预算映射 (reasoning_effort: low / medium / high)
  if (oai.reasoning_effort) {
    const budgetMap = { low: 2048, medium: 8192, high: 24576 };
    const budget = budgetMap[String(oai.reasoning_effort)] || 4096;
    out.thinking = { type: 'enabled', budget_tokens: budget };
    if (out.max_tokens && out.max_tokens <= budget) {
      out.max_tokens = budget + 4096;
    }
  }

  // [P1] 透传结构化输出 / JSON 模式要求
  if (oai.response_format != null) {
    out.response_format = oai.response_format;
  }

  const sysPieces = [];
  const msgs = [];

  for (const m of Array.isArray(oai.messages) ? oai.messages : []) {
    if (!isObj(m)) continue;
    const role = str(m, 'role');

    if (role === 'system' || role === 'developer') {
      if (typeof m.content === 'string') sysPieces.push(m.content);
      else if (Array.isArray(m.content)) {
        for (const p of m.content) {
          if (isObj(p) && p.type === 'text') sysPieces.push(str(p, 'text'));
        }
      }
      continue;
    }

    if (role === 'user') {
      msgs.push({ role: 'user', content: userContentToAnthropic(m.content) });
      continue;
    }

    if (role === 'tool' || role === 'function') {
      const id = str(m, 'tool_call_id') || str(m, 'name');
      let result = m.content;
      if (typeof result !== 'string') {
        try { result = JSON.stringify(result); } catch (e) { result = String(result); }
      }
      const block = { type: 'tool_result', tool_use_id: id || newId('toolu_'), content: result == null ? '' : result };
      const last = msgs[msgs.length - 1];
      if (last && last.role === 'user' && Array.isArray(last.content)) {
        last.content.push(block);
      } else {
        msgs.push({ role: 'user', content: [block] });
      }
      continue;
    }

    if (role === 'assistant') {
      const blocks = assistantContentToAnthropic(m.content, m.tool_calls);
      if (blocks.length === 0) blocks.push({ type: 'text', text: '' });
      msgs.push({ role: 'assistant', content: blocks });
    }
  }

  if (sysPieces.length) out.system = sysPieces.join('\n\n');
  out.messages = msgs;

  // 工具定义映射
  if (Array.isArray(oai.tools) && oai.tools.length) {
    out.tools = oai.tools
      .filter(t => isObj(t) && t.type === 'function' && isObj(t.function))
      .map(t => ({
        name: str(t.function, 'name'),
        description: str(t.function, 'description'),
        input_schema: isObj(t.function.parameters) ? t.function.parameters : { type: 'object', properties: {} },
      }))
      .filter(t => t.name);

    const tc = oai.tool_choice;
    if (typeof tc === 'string') {
      if (tc === 'auto') out.tool_choice = { type: 'auto' };
      else if (tc === 'required') out.tool_choice = { type: 'any' };
      else if (tc === 'none') out.tool_choice = { type: 'none' };
    } else if (isObj(tc) && tc.type === 'function' && isObj(tc.function)) {
      out.tool_choice = { type: 'tool', name: str(tc.function, 'name') };
    }
  }

  return out;
}

/**
 * 将 normalizeGeminiUsage 转换为标准 OpenAI usage 格式
 */
function toOpenAIUsage(normUsage) {
  const input = normUsage?.input_tokens || 0;
  const output = normUsage?.output_tokens || 0;
  const cached = normUsage?.cached_tokens || 0;
  const reasoning = normUsage?.thoughts_tokens || 0;
  return {
    prompt_tokens: input + cached,
    completion_tokens: output + reasoning,
    total_tokens: input + cached + output + reasoning,
    prompt_tokens_details: { cached_tokens: cached },
    completion_tokens_details: { reasoning_tokens: reasoning },
  };
}

/**
 * 将 Google 原生非流式响应转换为标准的 OpenAI chat.completion 结构
 */
export function convertGoogleToOpenAI(googleResponse, clientModel) {
  const inner = googleResponse?.response || googleResponse || {};
  const candidate = inner?.candidates?.[0];
  const parts = candidate?.content?.parts || [];

  let text = '';
  let reasoning = '';
  let latestSeenSignature = FALLBACK_THOUGHT_SIGNATURE;
  const toolCalls = [];

  for (const part of parts) {
    const sig = part.thoughtSignature || part.thought_signature;
    if (sig) latestSeenSignature = sig;

    if (part.thought) {
      reasoning += part.text || '';
    } else if (part.text !== undefined && part.text !== '') {
      text += part.text;
    }

    if (part.functionCall) {
      const callId = part.functionCall.id || newId('call_');
      const actualSig = sig || latestSeenSignature || FALLBACK_THOUGHT_SIGNATURE;
      signatureCache.set(callId, actualSig, part.functionCall.name);

      toolCalls.push({
        id: callId,
        type: 'function',
        function: {
          name: part.functionCall.name,
          arguments: JSON.stringify(part.functionCall.args || {}),
        },
      });
    }
  }

  const message = {
    role: 'assistant',
    content: toolCalls.length && !text ? null : text,
  };
  if (reasoning) {
    message.reasoning_content = reasoning;
  }
  if (toolCalls.length) {
    message.tool_calls = toolCalls;
  }

  let finishReason = 'stop';
  if (toolCalls.length) finishReason = 'tool_calls';
  else if (candidate?.finishReason === 'MAX_TOKENS') finishReason = 'length';

  const normUsage = normalizeGeminiUsage(inner.usageMetadata);
  const response = {
    id: newId('chatcmpl-'),
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: clientModel,
    choices: [{
      index: 0,
      message,
      finish_reason: finishReason,
    }],
    usage: toOpenAIUsage(normUsage),
  };

  Object.defineProperty(response, '_gw_usage', { value: normUsage, enumerable: false });
  return response;
}

/**
 * 将 Google 原生 SSE 流实时转换为标准 OpenAI SSE 流（支持 delta.reasoning_content）
 */
export async function handleOpenAIStreamConversion(upstreamRes, clientRes, originalModel, onFinish = null, startTime = Date.now(), { notice = null } = {}) {
  let noticePending = Boolean(notice);
  clientRes.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  clientRes.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
  clientRes.setHeader('Connection', 'keep-alive');
  clientRes.setHeader('X-Accel-Buffering', 'no');
  clientRes.socket?.setNoDelay?.(true);
  clientRes.flushHeaders?.();

  const completionId = newId('chatcmpl-');
  const created = Math.floor(Date.now() / 1000);
  let hasEmittedRole = false;
  let toolIndex = 0;
  let stopReason = 'stop';

  let rawUsage = null;
  let firstTokenAt = 0;
  let firstThoughtAt = 0;
  let firstTextAt = 0;
  let finished = false;
  let clientGone = false;
  // [P0] 关键修复：跟踪最近见过的真实 thoughtSignature，供后续 functionCall 继承
  let latestSeenSignature = FALLBACK_THOUGHT_SIGNATURE;

  const usageNow = () => normalizeGeminiUsage(rawUsage);
  const finish = (outcome, error = null) => {
    if (finished) return;
    finished = true;
    if (typeof onFinish === 'function') {
      try {
        onFinish({
          ...usageNow(),
          ttft_ms: firstTokenAt ? firstTokenAt - startTime : null,
          t_first_thought: firstThoughtAt ? firstThoughtAt - startTime : null,
          t_first_text: firstTextAt ? firstTextAt - startTime : null,
          outcome,
          error,
        });
      } catch (e) {
        console.error('[OpenAI Stream onFinish Error]', e);
      }
    }
  };

  const sendChunk = (delta, finish_reason = null, extra = {}) => {
    if (clientGone) return;
    const payload = {
      id: completionId,
      object: 'chat.completion.chunk',
      created,
      model: originalModel,
      choices: [{
        index: 0,
        delta,
        finish_reason,
      }],
      ...extra,
    };
    clientRes.write(`data: ${JSON.stringify(payload)}\n\n`);
    clientRes.flush?.();
  };

  const reader = upstreamRes.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  const onClientClose = () => {
    if (clientRes.writableFinished) return;
    clientGone = true;
    reader.cancel().catch(() => {});
  };
  clientRes.on?.('close', onClientClose);

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;

        let jsonStr = trimmed;
        if (jsonStr.startsWith('data:')) {
          jsonStr = jsonStr.slice(5).trim();
        }
        if (!jsonStr || jsonStr === '[DONE]') continue;

        let chunk;
        try {
          chunk = JSON.parse(jsonStr);
        } catch (e) {
          continue;
        }

        const inner = chunk.response || chunk;
        if (inner.usageMetadata) {
          rawUsage = mergeRawUsage(rawUsage, inner.usageMetadata);
        }

        const candidate = inner?.candidates?.[0];
        if (candidate?.finishReason === 'MAX_TOKENS') {
          stopReason = 'length';
        }
        const parts = candidate?.content?.parts || [];

        // 首帧吐 role: assistant
        if (!hasEmittedRole && parts.length > 0) {
          hasEmittedRole = true;
          if (!firstTokenAt) firstTokenAt = Date.now();
          sendChunk({ role: 'assistant', content: '' }, null);
        }

        for (const part of parts) {
          const sig = part.thoughtSignature || part.thought_signature;
          if (sig) {
            latestSeenSignature = sig;
          }

          if (part.text !== undefined) {
            const isThought = part.thought === true;
            if (part.text) {
              if (isThought) {
                if (!firstThoughtAt) firstThoughtAt = Date.now();
              } else if (!firstTextAt) {
                firstTextAt = Date.now();
              }
            }

            if (isThought) {
              if (part.text) {
                sendChunk({ reasoning_content: part.text }, null);
              }
            } else {
              if (noticePending) {
                noticePending = false;
                sendChunk({ content: notice }, null);
              }
              if (part.text) {
                sendChunk({ content: part.text }, null);
              }
            }
          } else if (part.functionCall) {
            stopReason = 'tool_calls';
            const callId = part.functionCall.id || newId('call_');
            // [P0] 核心修复：即使 functionCall 节点没带 sig，也继承同轮 thought 的签名存入缓存
            const actualSig = sig || latestSeenSignature || FALLBACK_THOUGHT_SIGNATURE;
            signatureCache.set(callId, actualSig, part.functionCall.name);

            sendChunk({
              tool_calls: [{
                index: toolIndex++,
                id: callId,
                type: 'function',
                function: {
                  name: part.functionCall.name,
                  arguments: JSON.stringify(part.functionCall.args || {}),
                },
              }],
            }, null);
          }
        }
      }
    }

    // [P1] 关键修复：如果客户端提前关闭，直接判定为 client_abort 并退出，绝不误判为 ok
    if (clientGone) {
      finish('client_abort', '客户端提前断开连接');
      return;
    }

    if (!hasEmittedRole) {
      sendChunk({ role: 'assistant', content: '' }, null);
    }

    // 发送带有 finish_reason 的闭合 chunk
    sendChunk({}, stopReason);

    // 发送最终的 usage 帧
    const norm = usageNow();
    if (clientRes && !clientGone) {
      const usagePayload = {
        id: completionId,
        object: 'chat.completion.chunk',
        created,
        model: originalModel,
        choices: [],
        usage: toOpenAIUsage(norm),
      };
      clientRes.write(`data: ${JSON.stringify(usagePayload)}\n\n`);
      clientRes.write('data: [DONE]\n\n');
      clientRes.flush?.();
    }
    finish('ok');
  } catch (err) {
    if (clientGone) {
      finish('client_abort');
    } else {
      console.error('[OpenAI Stream Error]', err);
      finish('stream_error', err.message);
      try {
        clientRes.write(`data: ${JSON.stringify({ error: { message: err.message, type: 'stream_error' } })}\n\n`);
        clientRes.write('data: [DONE]\n\n');
        clientRes.flush?.();
      } catch (e) {}
    }
  } finally {
    clientRes.off?.('close', onClientClose);
    try { clientRes.end(); } catch (e) {}
  }
}
