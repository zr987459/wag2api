/**
 * PR4：预热。启动、网络恢复（安卓宿主回调）、控制台回到前台时调用：
 *   1. 当前账号 access token 不在安全期内就提前刷新
 *   2. projectId 没有就提前解析
 *   3. 对 daily 集群发一个轻量 GET，把 TCP+TLS 连接建好放进连接池（返回 404 也无所谓，只要握手完成）
 * 20 秒内重复调用直接返回上次结果，避免网络抖动时连环触发。
 */
import { ANTIGRAVITY_ENDPOINT_DAILY } from './constants.mjs';
import { upstreamFetch } from './upstream-fetch.mjs';

const MIN_INTERVAL_MS = 20000;
let last = null;
let inflight = null;

export async function prewarm(accountPool, { reason = 'manual', force = false, fetchImpl = upstreamFetch } = {}) {
  if (inflight) return inflight;
  if (!force && last && Date.now() - last.at < MIN_INTERVAL_MS) return { ...last, skipped: true };
  inflight = (async () => {
    const t0 = Date.now();
    const out = { at: t0, reason, ok: false, t_token: null, t_project: null, t_conn: null, reused: null, tls_ms: null, status: null, error: null };
    try {
      const mgr = accountPool && accountPool.getActiveManager && accountPool.getActiveManager();
      if (mgr) {
        await mgr.getValidAccessToken();
        out.t_token = Date.now() - t0;
        if (!mgr.tokenData.projectId && typeof mgr.ensureProjectId === 'function') await mgr.ensureProjectId().catch(() => '');
        out.t_project = Date.now() - t0;
      }
      const c0 = Date.now();
      const r = await fetchImpl(`${ANTIGRAVITY_ENDPOINT_DAILY}/`, { method: 'GET', headers: { 'User-Agent': 'antigravity/4.3.0 linux/arm64' } });
      await r.text().catch(() => '');   // 读完响应，连接才会回到池里
      out.t_conn = Date.now() - c0;
      out.status = r.status;
      out.reused = r._gwReused ?? null;
      out.tls_ms = r._gwTlsMs ?? null;
      out.ok = true;
    } catch (e) {
      out.error = String(e.message || e).slice(0, 120);
    }
    last = out;
    return out;
  })().finally(() => { inflight = null; });
  return inflight;
}

export function lastPrewarm() { return last; }
