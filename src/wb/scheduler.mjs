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

  /** 成功出流后记最近使用（易变字段，不触发云端同步） */
  touch(uid) {
    this.vault.updateAccount(uid, a => { a.last_used = Date.now(); }, { quiet: true });
  }

  /**
   * 一次 WB 请求结束（成功或失败）后，记到最终实际使用的账号上：请求数 +1，Token 累加本次合计。
   * 与 touch 一样只改易变字段，不触发云端同步（persist 推送时也会剥掉 token_usage）。
   */
  recordUsage(uid, tokens = 0) {
    if (!uid) return;
    this.vault.updateAccount(uid, a => {
      const u = a.token_usage && typeof a.token_usage === 'object' ? a.token_usage : {};
      u.request_count = (Number(u.request_count) || 0) + 1;
      u.total_tokens = (Number(u.total_tokens) || 0) + Math.max(0, Number(tokens) || 0);
      a.token_usage = u;
    }, { quiet: true });
  }

  /** 手动选中的账号已被暂停时视为「自动」，并顺手清掉（兼容修复前遗留的状态） */
  effectiveSelectedUid() {
    const sel = this.getSelectedUid();
    if (!sel) return '';
    const a = this.vault.find(sel);
    if (a && a.disabled) { this.setSelectedUid(''); return ''; }
    return sel;
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
