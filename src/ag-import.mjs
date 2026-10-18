/** 从任意粘贴内容里抽出 AG 账号：JSON 备份 / 单个对象 / 一行一个 Refresh Token */
export function parseAgImport(raw) {
  const out = [];
  const seen = new Set();
  const push = (rt, email = '') => {
    rt = String(rt || '').trim();
    if (!/^1\/\/[0-9A-Za-z_-]{20,}$/.test(rt) || seen.has(rt)) return;
    seen.add(rt);
    out.push({ refresh_token: rt, email: String(email || '').trim().toLowerCase() });
  };
  const walk = v => {
    if (!v) return;
    if (Array.isArray(v)) return v.forEach(walk);
    if (typeof v === 'string') return push(v);
    if (typeof v === 'object') {
      const rt = v.refresh_token || v.refreshToken || v.token;
      if (typeof rt === 'string') push(rt, v.email);
      for (const k of ['accounts', 'ag', 'list', 'data']) if (v[k]) walk(v[k]);
    }
  };
  const text = String(raw || '').trim();
  try { walk(JSON.parse(text)); } catch (e) { /* 不是 JSON，按纯文本处理 */ }
  if (!out.length) for (const m of text.matchAll(/1\/\/[0-9A-Za-z_-]{20,}/g)) push(m[0]);
  return out;
}
