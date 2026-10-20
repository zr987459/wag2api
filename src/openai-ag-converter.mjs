/**
 * OpenAI Protocol Adapter for AG (Gemini) Engine
 *
 * 提供三类适配能力：
 *   1. openaiRequestToAnthropic(oai)             —— OpenAI 请求 -> AG 内部请求结构
 *   2. convertGoogleToOpenAI(googleData, model)  —— Google 非流式响应 -> OpenAI chat.completion
 *   3. handleOpenAIStreamConversion(...)         —— Google SSE 流 -> OpenAI SSE 流
 *
 * 与 sse-streamer.mjs 保持一致的健壮性基线：分块解析、客户端断开兜底、
 * onFinish 恰好调用一次、thoughtSignature 缓存防多轮死锁。
 */

import crypto from 'crypto';
import { signatureCache, FALLBACK_THOUGHT_SIGNATURE } from './signature-cache.mjs';
import { normalizeGeminiUsage, mergeRawUsage } from './usage.mjs';

/* ------------------------------------------------------------------ */
/* 内部工具                                                            */
/* ------------------------------------------------------------------ */

const REASONING_EFFORT_LEVELS = ['low', 'medium', 'high'];
const REASONING_BUDGET_BY_EFFORT = Object.freeze({ low: 1024, medium: 8192, high: 24576 });

/** OpenAI content 兼容：string / 数组（text、image_url）-> 内部 parts */
function normalizeOpenAIContent(content) {
  if (content === null || content === undefined) return [];
  if (typeof content === 'string') {
    return content ? [{ type: 'text', text: content }] : [];
  }
  if (!Array.isArray(content)) {
    return [{ type: 'text', text: String(content) }];
  }
  const parts = [];
  for (const item of content) {
    if (!item || typeof item !== 'object') continue;
    switch (item.type) {
      case 'text':
        if (item.text) parts.push({ type: 'text', text: String(item.text) });
        break;
      case 'image_url': {
        const url = typeof item.image_url === 'string' ? item.image_url : item.image_url?.url;
        if (!url) break;
        const m = /^data:([^;,]+);base64,(.+)$/i.exec(url);
        if (m) {
          parts.push({ type: 'image', mimeType: m[1], data: m[2] });
        } else {
          parts.push({ type: 'image', fileUri: url });
        }
        break;
      }
      default:
        if (typeof item.text === 'string' && item.text) {
          parts.push({ type: 'text', text: item.text });
        }
    }
  }
  return parts;
}

/** 拼接 system 消息为单一 string */
function collectSystemPrompt(messages) {
  const sys = [];
  for (const msg of messages) {
    if (!msg || msg.role !== 'system') continue;
    const parts = normalizeOpenAIContent(msg.content);
    for (const p of parts) {
      if (p.type === 'text' && p.text) sys.push(p.text);
    }
  }
  return sys.join('\n\n');
}

/** OpenAI tools -> 内部 tool 定义 */
function convertOpenAITools(tools) {
  if (!Array.isArray(tools) || tools.length === 0) return undefined;
  const out = [];
  for (const tool of tools) {
    if (!tool || tool.type !== 'function' || !tool.function) continue;
    const fn = tool.function;
    if (!fn.name) continue;
    out.push({
      name: fn.name,
      description: fn.description || '',
      parameters: fn.parameters || { type: 'object', properties: {} },
    });
  }
  return out.length ? out : undefined;
}

/** reasoning_effort -> thinking 预算 */
function mapReasoningEffort(effort, maxTokens) {
  if (!effort || typeof effort !== 'string') return null;
  const key = effort.toLowerCase();
  if (!REASONING_EFFORT_LEVELS.includes(key)) return null;
  let budget = REASONING_BUDGET_BY_EFFORT[key];
  if (Number.isFinite(maxTokens) && maxTokens > 0) {
    budget = Math.min(budget, Math.max(1024, Math.floor(maxTokens * 0.8)));
  }
  return { effort: key, budget };
}

/** tool 调用入参 JSON 解析（容错） */
function parseToolArguments(raw) {
  if (raw === null || raw === undefined || raw === '') return {};
  if (typeof raw === 'object') return raw;
  try {
    const v = JSON.parse(raw);
    return v && typeof v === 'object' ? v : {};
  } catch {
    return {};
  }
}

/* ------------------------------------------------------------------ */
/* 1. OpenAI 请求 -> 内部请求                                          */
/* ------------------------------------------------------------------ */

export function openaiRequestToAnthropic(oai) {
  const src = oai && typeof oai === 'object' ? oai : {};
  const rawMessages = Array.isArray(src.messages) ? src.messages : [];

  const system = collectSystemPrompt(rawMessages);

  const messages = [];
  for (const msg of rawMessages) {
    if (!msg || typeof msg !== 'object') continue;
    const role = msg.role;

    if (role === 'system') continue;

    if (role === 'user') {
      const parts = normalizeOpenAIContent(msg.content);
      if (parts.length) messages.push({ role: 'user', content: parts });
      continue;
    }

    if (role === 'assistant') {
      const content = normalizeOpenAIContent(msg.content);
      const toolCalls = Array.isArray(msg.tool_calls)
        ? msg.tool_calls
            .filter(tc => tc && tc.type === 'function' && tc.function?.name)
            .map(tc => {
              const callId = tc.id || `toolu_${crypto.randomBytes(12).toString('hex')}`;
              const name = tc.function.name;
              const args = parseToolArguments(tc.function.arguments);
              const cachedName = signatureCache.getName(callId);
              return { id: callId, name: cachedName || name, args };
            })
        : [];

      if (!toolCalls.length) {
        if (content.length) messages.push({ role: 'assistant', content });
        continue;
      }

      const parts = [];
      for (const p of content) parts.push(p);
      for (const call of toolCalls) {
        parts.push({
          type: 'tool_call',
          id: call.id,
          name: call.name,
          args: call.args,
          thoughtSignature: signatureCache.get(call.id) || FALLBACK_THOUGHT_SIGNATURE,
        });
      }
      messages.push({ role: 'assistant', content: parts });
      continue;
    }

    if (role === 'tool') {
      const callId = msg.tool_call_id || '';
      const text = typeof msg.content === 'string'
        ? msg.content
        : normalizeOpenAIContent(msg.content)
            .filter(p => p.type === 'text')
            .map(p => p.text)
            .join('\n');
      messages.push({
        role: 'tool',
        tool_call_id: callId,
        name: signatureCache.getName(callId) || undefined,
        content: text,
      });
      continue;
    }

    const parts = normalizeOpenAIContent(msg.content);
    if (parts.length) messages.push({ role: 'user', content: parts });
  }

  const maxTokens = Number.isFinite(Number(src.max_tokens)) && Number(src.max_tokens) > 0
    ? Math.floor(Number(src.max_tokens))
    : undefined;

  const reasoning = mapReasoningEffort(src.reasoning_effort, maxTokens);
  const thinking = reasoning ? { budget: reasoning.budget, effort: reasoning.effort } : undefined;

  const tools = convertOpenAITools(src.tools);

  const out = {
    model: src.model,
    system,
    messages,
    tools,
    thinking,
    max_tokens: maxTokens,
    temperature: src.temperature,
    top_p: src.top_p,
    stop: src.stop ?? undefined,
    stream: Boolean(src.stream),
  };

  if (reasoning) out.reasoning_effort = reasoning.effort;
  return out;
}

/* ------------------------------------------------------------------ */
/* 2. Google 非流式响应 -> OpenAI chat.completion                       */
/* ------------------------------------------------------------------ */

export function convertGoogleToOpenAI(googleData, modelUsed) {
  const data = googleData && typeof googleData === 'object' ? googleData : {};
  const inner = data.response && typeof data.response === 'object' ? data.response : data;

  const candidate = inner?.candidates?.[0];
  const parts = candidate?.content?.parts || [];

  let reasoningContent = '';
  let visibleContent = '';
  const toolCalls = [];

  for (const part of parts) {
    const sig = part.thoughtSignature || part.thought_signature;

    if (part.text !== undefined) {
      if (part.thought === true) {
        reasoningContent += part.text;
      } else {
        visibleContent += part.text;
      }
      continue;
    }

    if (part.functionCall) {
      const fc = part.functionCall;
      const callId = fc.id || `toolu_${crypto.randomBytes(12).toString('hex')}`;
      const actualSig = sig || FALLBACK_THOUGHT_SIGNATURE;
      signatureCache.set(callId, actualSig, fc.name);
      toolCalls.push({
        id: callId,
        type: 'function',
        function: {
          name: fc.name || '',
          arguments: JSON.stringify(fc.args || {}),
        },
      });
    }
  }

  const finishMap = {
    STOP: 'stop',
    MAX_TOKENS: 'length',
    SAFETY: 'content_filter',
    RECITATION: 'content_filter',
    OTHER: 'stop',
  };
  const rawFinish = candidate?.finishReason;
  let finishReason = finishMap[rawFinish] || (toolCalls.length ? 'tool_calls' : 'stop');
  if (toolCalls.length && finishReason === 'stop') finishReason = 'tool_calls';

  const u = normalizeGeminiUsage(inner.usageMetadata);

  const message = {
    role: 'assistant',
    content: visibleContent || (toolCalls.length ? null : ''),
  };
  if (reasoningContent) message.reasoning_content = reasoningContent;
  if (toolCalls.length) message.tool_calls = toolCalls;

  return {
    id: `chatcmpl-${crypto.randomBytes(12).toString('hex')}`,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: modelUsed || inner.modelVersion || data.model || 'unknown',
    choices: [
      {
        index: 0,
        message,
        finish_reason: finishReason,
        logprobs: null,
      },
    ],
    usage: {
      prompt_tokens: u.input_tokens + u.cached_tokens,
      completion_tokens: u.output_tokens,
      total_tokens: u.total_tokens,
      prompt_tokens_details: { cached_tokens: u.cached_tokens },
      completion_tokens_details: { reasoning_tokens: u.thoughts_tokens },
    },
    _gw_usage: u,
  };
}

/* ------------------------------------------------------------------ */
/* 3. Google SSE -> OpenAI SSE 流式转换                                */
/* ------------------------------------------------------------------ */

export async function handleOpenAIStreamConversion(
  upstreamRes,
  clientRes,
  originalModel,
  onFinish = null,
  startTime = Date.now(),
  { notice = null } = {}
) {
  let noticePending = Boolean(notice);

  clientRes.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  clientRes.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
  clientRes.setHeader('Connection', 'keep-alive');
  clientRes.setHeader('X-Accel-Buffering', 'no');
  clientRes.socket?.setNoDelay?.(true);
  clientRes.flushHeaders?.();

  const completionId = `chatcmpl-${crypto.randomBytes(12).toString('hex')}`;
  const created = Math.floor(Date.now() / 1000);
  const modelUsed = originalModel || 'unknown';

  let rawUsage = null;
  let firstTokenAt = 0;
  let firstThoughtAt = 0;
  let firstTextAt = 0;
  let finished = false;
  let clientGone = false;
  let emittedRole = false;
  let finishReason = 'stop';
  let latestSeenSignature = FALLBACK_THOUGHT_SIGNATURE;

  const usageNow = () => normalizeGeminiUsage(rawUsage);
  const finish = (outcome, error = null) => {
    if (finished) return;
    finished = true;
    if (typeof onFinish === 'function') {
      try {
        const u = usageNow();
        onFinish({
          ...u,
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

  const writeChunk = (payload) => {
    if (clientGone) return;
    clientRes.write(`data: ${JSON.stringify(payload)}\n\n`);
    clientRes.flush?.();
  };

  const emitRoleChunk = () => {
    if (emittedRole) return;
    emittedRole = true;
    writeChunk({
      id: completionId,
      object: 'chat.completion.chunk',
      created,
      model: modelUsed,
      choices: [{ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: null }],
    });
  };

  const emitDelta = (delta, finish_reason = null) => {
    if (clientGone) return;
    emitRoleChunk();
    writeChunk({
      id: completionId,
      object: 'chat.completion.chunk',
      created,
      model: modelUsed,
      choices: [{ index: 0, delta, finish_reason }],
    });
  };

  const reader = upstreamRes?.body?.getReader?.();
  const decoder = new TextDecoder();
  let buffer = '';

  const onClientClose = () => {
    if (clientRes.writableFinished) return;
    clientGone = true;
    try { reader?.cancel?.().catch(() => {}); } catch {}
  };
  clientRes.on?.('close', onClientClose);

  try {
    if (!reader) throw new Error('upstream response body is not readable');

    let toolCallIndex = 0;

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
        if (jsonStr.startsWith('data:')) jsonStr = jsonStr.slice(5).trim();
        if (!jsonStr || jsonStr === '[DONE]') continue;

        let chunk;
        try {
          chunk = JSON.parse(jsonStr);
        } catch {
          continue;
        }

        const inner = chunk?.response || chunk;
        if (!inner || typeof inner !== 'object') continue;

        if (inner.usageMetadata) {
          rawUsage = mergeRawUsage(rawUsage, inner.usageMetadata);
        }

        const candidate = inner?.candidates?.[0];
        const parts = candidate?.content?.parts || [];

        if (parts.length && !firstTokenAt) firstTokenAt = Date.now();

        for (const part of parts) {
          const sig = part.thoughtSignature || part.thought_signature;
          if (sig) latestSeenSignature = sig;

          if (part.text !== undefined) {
            const isThought = part.thought === true;
            if (part.text) {
              if (isThought) {
                if (!firstThoughtAt) firstThoughtAt = Date.now();
                if (!firstTokenAt) firstTokenAt = Date.now();
                emitDelta({ reasoning_content: part.text });
              } else {
                if (!firstTextAt) firstTextAt = Date.now();
                if (!firstTokenAt) firstTokenAt = Date.now();

                if (noticePending) {
                  noticePending = false;
                  emitDelta({ content: notice });
                }
                emitDelta({ content: part.text });
              }
            }
            continue;
          }

          if (part.functionCall) {
            const fc = part.functionCall;
            const callId = fc.id || `toolu_${crypto.randomBytes(12).toString('hex')}`;
            const actualSig = sig || latestSeenSignature || FALLBACK_THOUGHT_SIGNATURE;
            signatureCache.set(callId, actualSig, fc.name);

            finishReason = 'tool_calls';
            if (!firstTokenAt) firstTokenAt = Date.now();

            emitDelta({
              tool_calls: [
                {
                  index: toolCallIndex++,
                  id: callId,
                  type: 'function',
                  function: {
                    name: fc.name || '',
                    arguments: JSON.stringify(fc.args || {}),
                  },
                },
              ],
            });
          }
        }
      }
    }

    if (clientGone) {
      finish('client_abort', 'client disconnected');
      return;
    }

    emitRoleChunk();

    const u = usageNow();
    const usagePayload = {
      prompt_tokens: u.input_tokens + u.cached_tokens,
      completion_tokens: u.output_tokens,
      total_tokens: u.total_tokens,
      prompt_tokens_details: { cached_tokens: u.cached_tokens },
      completion_tokens_details: { reasoning_tokens: u.thoughts_tokens },
    };

    writeChunk({
      id: completionId,
      object: 'chat.completion.chunk',
      created,
      model: modelUsed,
      choices: [{ index: 0, delta: {}, finish_reason: finishReason }],
      usage: usagePayload,
    });

    if (!clientGone) clientRes.write('data: [DONE]\n\n');
    clientRes.flush?.();

    finish('ok');
    clientRes.end();
  } catch (err) {
    if (clientGone) {
      finish('client_abort', 'client disconnected');
    } else {
      console.error('[OpenAI Stream Processing Error]', err);
      finish('stream_error', String(err?.message || err).slice(0, 100));
      try {
        if (!clientRes.writableEnded) {
          writeChunk({
            id: completionId,
            object: 'chat.completion.chunk',
            created,
            model: modelUsed,
            choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
          });
          clientRes.write('data: [DONE]\n\n');
        }
      } catch {}
    }
    try { clientRes.end(); } catch {}
  } finally {
    clientRes.off?.('close', onClientClose);
    finish('ok');
  }
}
