/**
 * PR1：降级提示行。插入在响应正文第一个 text block 最前面；客户端回传历史时由 content-converter 精确剔掉。
 */

export const DOWNGRADE_NOTICE_PREFIX = '⚠️ 已降级：';

export const DOWNGRADE_REASON_LABELS = {
  quota_all_accounts: '所有账号配额冷却中',
  quota: '配额不足',
  upstream_5xx: '上游 5xx',
  timeout: '上游超时',
  network: '网络错误',
  auth: '账号凭据失效',
  unknown: '未知错误',
};

export function buildDowngradeNotice(requested, used, reason) {
  const label = DOWNGRADE_REASON_LABELS[reason] || reason;
  return `${DOWNGRADE_NOTICE_PREFIX}${requested} → ${used}（原因：${label}；降级模型无前缀缓存）\n\n`;
}

/** 剔掉 assistant 历史开头由网关插入的提示行（固定前缀精确匹配），剔完与从未插入时字节一致 */
export function stripDowngradeNotice(text) {
  if (typeof text !== 'string' || !text.startsWith(DOWNGRADE_NOTICE_PREFIX)) return text;
  const i = text.indexOf('\n\n');
  if (i >= 0) return text.slice(i + 2);
  const j = text.indexOf('\n');
  return j >= 0 ? text.slice(j + 1) : '';
}

/** 带 tools 或要求 JSON 输出时不插提示行（只靠 message.model / 响应头 / 统计） */
export function shouldInsertNotice(anthropicReq, env = process.env) {
  if (env.DOWNGRADE_NOTICE === '0' || env.DOWNGRADE_NOTICE === 'false') return false;
  if (Array.isArray(anthropicReq?.tools) && anthropicReq.tools.length > 0) return false;
  const fmt = anthropicReq?.output_format || anthropicReq?.response_format || anthropicReq?.output_config?.format || null;
  if (fmt && /json/i.test(JSON.stringify(fmt))) return false;
  return true;
}
