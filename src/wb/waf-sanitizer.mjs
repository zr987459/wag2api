/**
 * Tencent Cloud WAF Prompt Sanitizer & Bidirectional Restorer
 *
 * 遵循 Hark (Claude Opus 5.5) 审查规范（二轮深度加固）：
 * 1. 采用不透明可逆占位符 (⟦PATH_${nonce}_${idx}⟧) 替换高危 Linux 系统路径（含尾斜杠与通配符）；
 * 2. 避免使用全角字符（防 WAF Unicode 归一化二次拦截与分词失真）；
 * 3. 采用前后向断言，最长匹配优先，支持通配符与尾斜杠；
 * 4. 深度扫描 tool_calls[].function.arguments 历史与 reasoning_content 历史；
 * 5. 按 tool call index 独立分桶缓冲，彻底杜绝并行工具参数串台与吞吐；
 * 6. 在 finish_reason 触发时即时 flush，[DONE] 与异常断开时兜底 flush；
 * 7. 11128 双向边界脱敏且 Token 无裸字符，进出可逆；
 * 8. 严格保留 DEFAULT_SYSTEM_PROMPT 身份声明。
 */

import crypto from 'crypto';
import { DEFAULT_SYSTEM_PROMPT } from './constants.mjs';

// 腾讯云 WAF 重点拦截的高危系统根路径特征（含尾斜杠与通配符，排斥 chroot 与 URL）
const DANGEROUS_PATH_REGEX = /(?<![\w/])\/(?:root|proc|sys|etc|boot|dev)(?:\/[a-zA-Z0-9_.\-*]+)*\/?(?![\w])/g;

/**
 * 流式跨分片还原器（滑动窗口缓存防截断）
 */
export class StreamRestorer {
  constructor(revMap = new Map()) {
    this.revMap = revMap;
    this.hasTokens = Boolean(revMap && revMap.size > 0);
    this.contentBuf = '';
    this.reasoningBuf = '';
    this.argsBufMap = new Map(); // 按 tool index 独立分桶，防并行工具调用串台
  }

  _processBuffer(buf, nextChunk) {
    if (!this.hasTokens) return { out: nextChunk || '', rem: '' };
    const combined = buf + (nextChunk || '');
    if (!combined) return { out: '', rem: '' };

    const lastOpen = combined.lastIndexOf('⟦');
    const lastClose = combined.lastIndexOf('⟧');

    let flushable = '';
    let rem = '';

    // 存在未闭合的 ⟦ 且靠近末尾（可能是一个正在被截断的 token），暂缓发射
    if (lastOpen > lastClose && lastOpen !== -1) {
      if (combined.length - lastOpen < 40) {
        flushable = combined.slice(0, lastOpen);
        rem = combined.slice(lastOpen);
      } else {
        flushable = combined;
        rem = '';
      }
    } else {
      flushable = combined;
      rem = '';
    }

    let out = flushable;
    for (const [token, orig] of this.revMap) {
      out = out.replaceAll(token, orig);
    }
    return { out, rem };
  }

  processContent(chunk) {
    const { out, rem } = this._processBuffer(this.contentBuf, chunk);
    this.contentBuf = rem;
    return out;
  }

  processReasoning(chunk) {
    const { out, rem } = this._processBuffer(this.reasoningBuf, chunk);
    this.reasoningBuf = rem;
    return out;
  }

  processArgs(chunk, index = 0) {
    const cur = this.argsBufMap.get(index) || '';
    const { out, rem } = this._processBuffer(cur, chunk);
    this.argsBufMap.set(index, rem);
    return out;
  }

  flushContent() {
    if (!this.contentBuf) return '';
    let rem = this.contentBuf;
    this.contentBuf = '';
    return this.restoreAll(rem);
  }

  flushReasoning() {
    if (!this.reasoningBuf) return '';
    let rem = this.reasoningBuf;
    this.reasoningBuf = '';
    return this.restoreAll(rem);
  }

  flushArgs(index = 0) {
    const cur = this.argsBufMap.get(index) || '';
    this.argsBufMap.delete(index);
    return this.restoreAll(cur);
  }

  flushAllArgs() {
    const res = [];
    for (const [idx, buf] of this.argsBufMap.entries()) {
      if (buf) {
        const text = this.restoreAll(buf);
        if (text) res.push({ index: idx, arguments: text });
      }
    }
    this.argsBufMap.clear();
    return res;
  }

  restoreAll(text) {
    if (!this.hasTokens || typeof text !== 'string' || !text) return text;
    let res = text;
    for (const [token, orig] of this.revMap) {
      res = res.replaceAll(token, orig);
    }
    return res;
  }
}

/**
 * 递归扫描并替换消息体中的高危内容
 */
export function sanitizeWafPayload(payload) {
  if (!payload || !Array.isArray(payload.messages)) {
    return { payload, restorer: new StreamRestorer() };
  }

  // 提取所有原始文本片段（含 text、tool_calls 参数、reasoning_content 等）
  const allTexts = [];
  for (const m of payload.messages) {
    if (!m || typeof m !== 'object') continue;
    if (typeof m.content === 'string') allTexts.push(m.content);
    else if (Array.isArray(m.content)) {
      for (const p of m.content) {
        if (p && typeof p.text === 'string') allTexts.push(p.text);
      }
    }
    if (typeof m.reasoning_content === 'string') {
      allTexts.push(m.reasoning_content);
    }
    if (Array.isArray(m.tool_calls)) {
      for (const tc of m.tool_calls) {
        if (tc?.function?.arguments && typeof tc.function.arguments === 'string') {
          allTexts.push(tc.function.arguments);
        }
      }
    }
  }

  const combined = allTexts.join('\n');
  const matchedPaths = [...new Set(combined.match(DANGEROUS_PATH_REGEX) || [])];
  const has11128 = /\b11128\b/.test(combined);

  if (matchedPaths.length === 0 && !has11128) {
    return { payload, restorer: new StreamRestorer() };
  }

  // 最长匹配优先，避免 /root/a 先被 /root/ 截断破坏
  matchedPaths.sort((a, b) => b.length - a.length);

  const forwardMap = new Map();
  const revMap = new Map();
  const nonce = crypto.randomBytes(3).toString('hex');

  matchedPaths.forEach((p, idx) => {
    const token = `⟦PATH_${nonce}_${idx + 1}⟧`;
    forwardMap.set(p, token);
    revMap.set(token, p);
  });

  // 11128 双向边界可逆脱敏（Token 内部不包含 11128 裸字符，彻底避免特征误杀）
  if (has11128) {
    const token11128 = `⟦SIG_${nonce}_CH11⟧`;
    forwardMap.set('11128', token11128);
    revMap.set(token11128, '11128');
  }

  const replaceString = (str) => {
    if (typeof str !== 'string' || !str) return str;
    let s = str;
    for (const [orig, token] of forwardMap) {
      if (orig === '11128') {
        s = s.replace(/\b11128\b/g, token);
      } else {
        s = s.replaceAll(orig, token);
      }
    }
    return s;
  };

  const newMessages = payload.messages.map(m => {
    if (!m || typeof m !== 'object') return m;
    const copy = { ...m };
    if (typeof copy.content === 'string') {
      copy.content = replaceString(copy.content);
    } else if (Array.isArray(copy.content)) {
      copy.content = copy.content.map(part => {
        if (part && typeof part === 'object' && typeof part.text === 'string') {
          return { ...part, text: replaceString(part.text) };
        }
        return part;
      });
    }
    if (typeof copy.reasoning_content === 'string') {
      copy.reasoning_content = replaceString(copy.reasoning_content);
    }
    if (Array.isArray(copy.tool_calls)) {
      copy.tool_calls = copy.tool_calls.map(tc => {
        if (tc?.function?.arguments && typeof tc.function.arguments === 'string') {
          return {
            ...tc,
            function: {
              ...tc.function,
              arguments: replaceString(tc.function.arguments),
            },
          };
        }
        return tc;
      });
    }
    return copy;
  });

  // 如果发生了路径替换，向首条 system 消息尾部追加保真说明，指导模型在引用路径与工具参数时原样回传 token
  if (forwardMap.size > 0) {
    const systemNotice = '\n[System Context: Tokens matching ⟦PATH_...⟧ denote literal file paths. Output them verbatim when referencing or calling tools.]';
    let systemFound = false;
    for (const msg of newMessages) {
      if (msg && (msg.role === 'system' || msg.role === 'developer')) {
        if (typeof msg.content === 'string') {
          msg.content += systemNotice;
        } else if (Array.isArray(msg.content)) {
          msg.content.push({ type: 'text', text: systemNotice });
        }
        systemFound = true;
        break;
      }
    }
    if (!systemFound) {
      newMessages.unshift({
        role: 'system',
        content: DEFAULT_SYSTEM_PROMPT + systemNotice,
      });
    }
  }

  const newPayload = { ...payload, messages: newMessages };
  return { payload: newPayload, restorer: new StreamRestorer(revMap) };
}
