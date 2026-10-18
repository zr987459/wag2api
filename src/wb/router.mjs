/**
 * 前门分流（翻译自 EngineRouter.kt，用例表见 tests/test-engine-router.mjs）：
 *   1. 路径：/ag/* 与 /api/* 归 AG，/panel/*、/m/* 归 WB
 *   2. 模型名：ag: / wb: 前缀强制；否则查两边模型表精确匹配
 *   3. 默认引擎：重名或未知模型
 * 绝不按模型名前缀猜（两边都有 claude- / gemini- 家族）。
 */
export function normalizePath(p) {
  let s = String(p || '/').replace(/\/{2,}/g, '/');
  if (s.length > 1 && s.endsWith('/')) s = s.slice(0, -1);
  return s;
}

const inList = (model, list) => Boolean(model) && list.some(o => o && o.id === model);

/** @returns {{engine:'ag'|'wb', path:string, strip:string|null}} */
export function decide(path, model, { agModels = [], wbModels = [], defaultEngine = 'wb' } = {}) {
  const p = normalizePath(path);
  if (p.startsWith('/ag/')) return { engine: 'ag', path: p.slice(3), strip: null };
  if (p === '/ag') return { engine: 'ag', path: '/', strip: null };
  if (p.startsWith('/api/')) return { engine: 'ag', path: p, strip: null };
  if (p === '/v1/messages' || p === '/v1/chat/completions') {
    const m = String(model || '');
    const forced = m.startsWith('ag:') ? 'ag' : m.startsWith('wb:') ? 'wb' : null;
    let target = forced;
    if (!target) {
      const inAg = inList(m, agModels), inWb = inList(m, wbModels);
      target = inAg && !inWb ? 'ag' : inWb && !inAg ? 'wb' : defaultEngine;
    }
    return { engine: target, path: p, strip: forced ? `${forced}:` : null };
  }
  return { engine: 'wb', path: p, strip: null };
}

/** 合并两边模型表；重名项额外列出 ag: / wb: 前缀版本 */
export function mergedModels(wb, ag) {
  const seen = new Set();
  const data = [];
  for (const list of [wb, ag]) for (const o of list) {
    if (!o || !o.id || seen.has(o.id)) continue;
    seen.add(o.id);
    data.push({ ...o });
  }
  const agIds = new Set(ag.map(o => o && o.id).filter(Boolean));
  for (const id of new Set(wb.map(o => o && o.id).filter(Boolean))) {
    if (!agIds.has(id)) continue;
    data.push({ id: `ag:${id}`, object: 'model', name: `${id} (AG 引擎)` });
    data.push({ id: `wb:${id}`, object: 'model', name: `${id} (WorkBuddy 引擎)` });
  }
  return { object: 'list', data };
}
