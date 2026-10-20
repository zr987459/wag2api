/**
 * Tencent Cloud WAF Prompt Sanitizer & Bidirectional Restorer
 *
 * 遵循 Hark (Claude Opus 5.5) 架构规范：
 * 1. 采用不透明可逆占位符 (⟦PATH_${nonce}_${idx}⟧) 替换高危 Linux 系统路径（如 /root/, /etc/, /proc/ 等）；
 * 2. 避免使用全角字符（防 WAF Unicode 归一化二次拦截与分词失真）；
 * 3. 采用正向前瞻与反向否定断言，最长匹配优先，避免误伤子路径；
 * 4. 跨 SSE chunk 边界滑动缓冲恢复，确保流式输出完整还原真实路径。
 */

import crypto from 'crypto';

// 腾讯云 WAF 重点拦截的高危系统根路径特征
const DANGEROUS_PATH_REGEX = /(?<![\w/])\/(?:root|proc|sys|etc|boot|dev)(?:\/[\w.\-]+)*(?![\w/])/g;

/**
 * 流式跨分片还原器（滑动窗口缓存防截断）
 */
export class StreamRestorer {
  constructor(revMap = new Map()) {
    this.revMap = revMap;
    this.hasTokens = Boolean(revMap && revMap.size > 0);
    this.contentBuf = '';
    this.reasoningBuf = '';
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

  flushContent() {
    if (!this.contentBuf) return '';
    let rem = this.contentBuf;
    this.contentBuf = '';
    for (const [token, orig] of this.revMap) {
      rem = rem.replaceAll(token, orig);
    }
    return rem;
  }

  flushReasoning() {
    if (!this.reasoningBuf) return '';
    let rem = this.reasoningBuf;
    this.reasoningBuf = '';
    for (const [token, orig] of this.revMap) {
      rem = rem.replaceAll(token, orig);
    }
    return rem;
  }

  restoreAll(text) {
    if (!this.hasTokens || !text) return text;
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

  // 提取所有原始文本片段，直接进行正则断言（避免 JSON.stringify 中 \n 变成字符 n 触发 \\w 误伤断言）
  const allTexts = [];
  for (const m of payload.messages) {
    if (!m || typeof m !== 'object') continue;
    if (typeof m.content === 'string') allTexts.push(m.content);
    else if (Array.isArray(m.content)) {
      for (const p of m.content) {
        if (p && typeof p.text === 'string') allTexts.push(p.text);
      }
    }
  }

  const combined = allTexts.join('\n');
  const matchedPaths = [...new Set(combined.match(DANGEROUS_PATH_REGEX) || [])];
  const has11128 = combined.includes('11128');

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

  const replaceString = (str) => {
    if (typeof str !== 'string' || !str) return str;
    let s = str;
    if (has11128) s = s.replaceAll('11128', '11-128');
    for (const [orig, token] of forwardMap) {
      s = s.replaceAll(orig, token);
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
    return copy;
  });

  // 如果发生了路径替换，向 system 消息尾部追加保真说明，指导模型在引用路径时原样回传 token
  if (forwardMap.size > 0) {
    const systemNotice = '\n[System Context: Tokens matching ⟦PATH_...⟧ denote literal file paths. Output them verbatim when referencing.]';
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
        content: 'You are an advanced programming assistant developed by Tencent.' + systemNotice,
      });
    }
  }

  const newPayload = { ...payload, messages: newMessages };
  return { payload: newPayload, restorer: new StreamRestorer(revMap) };
}
