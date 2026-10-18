/**
 * 账号调度（翻译自 AccountScheduler.kt）：手动选中优先 → 非冷却账号按最久未用轮询 → 全冷却取最快恢复的。
 * 429 / 14003 给账号打 8 秒短冷却；冷却只在内存。
 */
export const DEFAULT_COOLDOWN_MS = 8000;

export class AccountScheduler {
  constructor(vault, settings) {
    this.vault = vault;
    this.settings = settings;
    this.cooldownUntil = new Map();
  }

  getSelectedUid() { return this.settings.get('selected_uid') || ''; }
  setSelectedUid(uid) { this.settings.set('selected_uid', uid || ''); }

  markCooling(uid, ms = DEFAULT_COOLDOWN_MS) { this.cooldownUntil.set(uid, Date.now() + ms); }

  isCooling(uid) {
    const until = this.cooldownUntil.get(uid);
    if (!until) return false;
    if (Date.now() >= until) { this.cooldownUntil.delete(uid); return false; }
    return true;
  }

  cooldownRemainSec(uid) {
    const until = this.cooldownUntil.get(uid);
    if (!until) return 0;
    const left = until - Date.now();
    return left > 0 ? Math.ceil(left / 1000) : 0;
  }

  pick(realm, exclude = new Set()) {
    const all = this.vault.getAccounts();
    const usable = a => !a.disabled && a.uid && !exclude.has(a.uid);
    let candidates = all.filter(a => usable(a) && a.realm === realm);
    if (!candidates.length) candidates = all.filter(usable); // 兼容 realm 缺失的老数据
    if (!candidates.length) return null;

    const selected = this.getSelectedUid();
    if (selected) {
      const s = candidates.find(a => a.uid === selected && !this.isCooling(selected));
      if (s) return s;
    }
    const healthy = candidates.filter(a => !this.isCooling(a.uid));
    if (healthy.length) return healthy.reduce((m, a) => ((a.last_used || 0) < (m.last_used || 0) ? a : m));
    return candidates.reduce((m, a) => (this.cooldownRemainSec(a.uid) < this.cooldownRemainSec(m.uid) ? a : m));
  }

  touch(uid) {
    this.vault.updateAccount(uid, a => {
      a.last_used = Date.now();
      a.token_usage = a.token_usage || { request_count: 0, total_tokens: 0 };
      a.token_usage.request_count = (a.token_usage.request_count || 0) + 1;
    }, { quiet: true });
  }

  poolStatus() {
    return this.vault.getAccounts().map(a => ({
      uid: a.uid,
      nickname: a.nickname || '',
      realm: a.realm || '',
      disabled: Boolean(a.disabled),
      cooling: this.isCooling(a.uid),
      cooldown_sec: this.cooldownRemainSec(a.uid),
      last_used: a.last_used || 0,
      request_count: (a.token_usage && a.token_usage.request_count) || 0,
    }));
  }

  clearAllCooldowns() { this.cooldownUntil.clear(); }
}
