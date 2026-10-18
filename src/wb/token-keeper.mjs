/**
 * Token 保活（翻译自 TokenKeeper.kt）：每分钟检查一次，满 30 分钟刷新全部有 refreshToken 的账号；
 * 上游 401 时由网关即时调用 refreshIfPossible。
 */
import { UPSTREAM_CN, UPSTREAM_GLOBAL, CLIENT_UA } from './constants.mjs';

const REFRESH_INTERVAL_MS = 30 * 60 * 1000;

export class TokenKeeper {
  constructor(vault, { fetchImpl = (...a) => fetch(...a), log = console } = {}) {
    this.vault = vault;
    this.fetch = fetchImpl;
    this.log = log;
    this.lastRefreshAt = 0;
    this.timer = null;
    this.inflight = new Map();
  }

  start() {
    if (this.timer) return;
    this.timer = setInterval(() => {
      if (Date.now() - this.lastRefreshAt < REFRESH_INTERVAL_MS) return;
      this.lastRefreshAt = Date.now();
      this.refreshAll().catch(e => this.log.warn('[WB] 保活循环异常:', e.message));
    }, 60_000);
    if (this.timer.unref) this.timer.unref();
  }

  stop() { if (this.timer) clearInterval(this.timer); this.timer = null; }

  async refreshAll() {
    for (const a of [...this.vault.getAccounts()]) {
      if (a.disabled || !a.uid || !a.refreshToken) continue;
      try { await this.refreshIfPossible(a.uid); } catch (e) { this.log.warn(`[WB] 刷新 ${a.uid} 失败:`, e.message); }
    }
  }

  /** 同一账号的并发刷新合并为一次 */
  refreshIfPossible(uid) {
    if (this.inflight.has(uid)) return this.inflight.get(uid);
    const p = this._refresh(uid).finally(() => this.inflight.delete(uid));
    this.inflight.set(uid, p);
    return p;
  }

  async _refresh(uid) {
    const acc = this.vault.find(uid);
    if (!acc || !acc.refreshToken) return false;
    const base = acc.realm === 'cn' ? UPSTREAM_CN : UPSTREAM_GLOBAL;
    try {
      const r = await this.fetch(`${base}/v2/plugin/auth/token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'User-Agent': CLIENT_UA, Origin: base, Referer: `${base}/` },
        body: JSON.stringify({ grant_type: 'refresh_token', refresh_token: acc.refreshToken }),
        signal: AbortSignal.timeout(30_000),
      });
      if (!r.ok) { this.log.warn(`[WB] 刷新 ${uid} 返回 ${r.status}`); return false; }
      let o;
      try { o = JSON.parse(await r.text()); } catch (e) { return false; }
      const data = o && typeof o.data === 'object' && o.data ? o.data : o;
      const access = data.accessToken || data.access_token || '';
      const refresh = data.refreshToken || data.refresh_token || '';
      if (!access) return false;
      this.vault.updateTokens(uid, access, refresh || null);
      this.log.log(`[WB] 账号 ${uid} token 已续期`);
      return true;
    } catch (e) {
      this.log.warn(`[WB] 刷新 ${uid} 异常:`, e.message);
      return false;
    }
  }
}
