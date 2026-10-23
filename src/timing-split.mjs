/**
 * fix/ttft 分段打点辅助：把「从发请求到收到响应头」拆成「上传」+「等待」。
 *
 *  - upload_ms：Node 下来自 resp._gwUploadMs（req 'finish'，含建连/握手，近似值）；Bun 下为 null。
 *  - wait_headers_ms：头耗时 − 上传耗时；上传未知时等于头耗时（即包含上传）。
 */
export function splitHeaderTiming(headersMs, uploadMs) {
  const h = Number.isFinite(Number(headersMs)) ? Math.max(0, Math.round(Number(headersMs))) : null;
  const u = uploadMs === null || uploadMs === undefined || !Number.isFinite(Number(uploadMs)) ? null : Math.max(0, Math.round(Number(uploadMs)));
  if (h === null) return { upload_ms: u, wait_headers_ms: null };
  return { upload_ms: u, wait_headers_ms: u === null ? h : Math.max(0, h - u) };
}

/** 从 Cloud Code payload 里读出思考档位，供日志展示：thinkingLevel 优先，其次 budget:<n>，没有思考配置为 null */
export function thinkingLevelOf(payload) {
  const tc = payload?.request?.generationConfig?.thinkingConfig;
  if (!tc) return null;
  if (tc.thinkingLevel) return String(tc.thinkingLevel);
  if (tc.thinkingBudget !== undefined) return `budget:${tc.thinkingBudget}`;
  return null;
}
