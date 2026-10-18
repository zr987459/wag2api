/** WB 引擎常量（与 TencentGateway.kt / WbModels.kt 保持一致） */
export const UPSTREAM_GLOBAL = 'https://www.workbuddy.ai';
export const UPSTREAM_CN = 'https://copilot.tencent.com';
export const ORIGIN_CN = 'https://www.codebuddy.cn';
export const CLIENT_UA = 'WorkBuddy/5.5.4 WorkBuddy AI/5.5.4 CLI/2.137.1';
export const DEFAULT_SYSTEM_PROMPT = 'You are WorkBuddy, an advanced AI programming assistant developed by Tencent.';
export const DEFAULT_MODEL = 'deepseek-v4.1-flash-1017';

/** 客户端常用别名与快照 → 腾讯官方模型 ID */
export const MODEL_ALIASES = {
  'deepseek-v4.1-flash-1017': 'deepseek-v4.1-flash',
  'deepseek-flash-1017': 'deepseek-v4.1-flash',
  'deepseek-flash': 'deepseek-v4.1-flash',
  'claude-3.7-sonnet': 'default-1.1',
  'claude-4.0-sonnet': 'default-1.2',
  'kimi-k3': 'kimi-k3-1',
  'kimi-k3.1': 'kimi-k3-1',
  'hy4-preview-f': 'hy4-preview',
  'deepseek-v3.2': 'deepseek-v3-2-volc',
  'gemini-3.8-flash': 'gemini-3.5-flash',
};

export function wbModels() {
  const out = [];
  const m = (id, name, credits = null, images = true, reasoning = false) => {
    const o = { id, name, object: 'model' };
    if (credits) o.credits = credits;
    o.supports_images = images;
    o.supports_reasoning = reasoning;
    out.push(o);
  };
  m('deepseek-v4.1-flash-1017', 'DeepSeek-V4.1-Flash-1017 [0.00x 限免免费 · 多模态+思考]', '0.00x (Free)', true, true);
  m('global:deepseek-v4.1-flash-1017', 'DeepSeek-V4.1-Flash-1017 (Global) [0.00x 限免免费]', '0.00x (Free)', true, true);
  m('deepseek-v4.1-flash', 'DeepSeek-V4.1-Flash [0.00x 限免免费]', '0.00x (Free)', true, true);
  m('global:deepseek-v4.1-flash', 'DeepSeek-V4.1-Flash (Global) [0.00x 限免免费]', '0.00x (Free)', true, true);
  m('hy4-preview', 'Hy4-Preview [0.00x 限免免费 · 混元深度思考]', '0.00x (Free)', true, true);
  m('hy3', 'Hy3 [0.00x 限免免费]', '0.00x (Free)', true, true);
  m('gpt-6-astra', 'GPT-6-Astra [6.67x · 国际版专属顶级旗舰]', '6.67x', true, true);
  m('gpt-5.6-sol', 'GPT-5.6-Sol [国际版专属]', null, true);
  m('gpt-5.4', 'GPT-5.4 [国际版原生多模态]', null, true);
  m('grok-4.7', 'Grok-4.7 [国际版专属]', null, false);
  m('gemini-3.5-flash', 'Gemini-3.5-Flash [国际版原生多模态]', null, true);
  m('glm-5.3-flash', 'GLM-5.3-Flash [极低消耗]', null, true, true);
  m('glm-5.3', 'GLM-5.3 [最新旗舰]', null, true, true);
  m('glm-5.2', 'GLM-5.2 [1M 长上下文]', null, true, true);
  m('kimi-k3', 'Kimi-K3 [长文本深度推理]', null, true, true);
  m('kimi-k2.8-preview', 'Kimi-K2.8-Preview [深度推理]', null, true, true);
  m('claude-3.7-sonnet', 'Claude-3.7-Sonnet (官方映射 default-1.1)', null, true);
  m('claude-4.0-sonnet', 'Claude-4.0-Sonnet (官方映射 default-1.2)', null, true);
  m('auto', 'Auto [自动智能调度]', null, false);
  return out;
}
