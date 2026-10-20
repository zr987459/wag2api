/**
 * 账号调度（翻译自 AccountScheduler.kt，已接入工业级会话亲和表 Session Affinity）：
 * 1. 手动选中优先：如果用户锁定某个账号，优先使用；
 * 2. 会话亲和表（Session Affinity）：同一个 convId 严格锁定同一个账号，复用腾讯 DeepSeek 的 KV-Cache；
 * 3. 负载均衡与冷却避障：遇到 429 / 14003 打 8 秒短冷却，并以 CAS 方式将该会话无感重绑到其他健康账号；
 * 4. 滑动 TTL（30 分钟）+ LRU（上限 5000 条），防止内存膨胀。
 */
export const DEFAULT_COOLDOWN_MS = 8000;
export const WB_SESSION_TTL_MS = 30 * 60 * 1000; // 30 分钟滑动 TTL
export const MAX_AFFINITY_ENTRIES = 5000;

export class AccountScheduler {
  constructor(vault, settings) {
    this.vault = vault;
    this.settings = settings;
    this.cooldownUntil = new Map();
    this.sessionAffinity = new Map(); // convId -> { uid, epoch, expireAt }
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

  // 会话亲和绑定更新（支持 CAS 防止并发抖动）
  bindSession(sessionKey, uid, expectedEpoch = null) {
    if (!sessionKey || !uid) return null;
    const cur = this.sessionAffinity.get(sessionKey);
    // CAS 保护：如果外部指定了 expectedEpoch，且当前 epoch 已被其他并发请求递增，说明已被抢先换绑，复用新绑定
    if (expectedEpoch !== null && cur && cur.epoch !== expectedEpoch) {
      return cur;
    }
    const epoch = cur ? cur.epoch + 1 : 1;
    if (this.sessionAffinity.has(sessionKey)) {
      this.sessionAffinity.delete(sessionKey);
    } else if (this.sessionAffinity.size >= MAX_AFFINITY_ENTRIES) {
      const oldest = this.sessionAffinity.keys().next().value;
      this.sessionAffinity.delete(oldest);
    }
    const binding = { uid, epoch, expireAt: Date.now() + WB_SESSION_TTL_MS };
    this.sessionAffinity.set(sessionKey, binding);
    return binding;
  }

  getBinding(sessionKey) {
    if (!sessionKey) return null;
    const b = this.sessionAffinity.get(sessionKey);
    if (!b) return null;
    if (Date.now() >= b.expireAt) {
      this.sessionAffinity.delete(sessionKey);
      return null;
    }
    // 滑动 TTL 与 LRU 位置刷新
    b.expireAt = Date.now() + WB_SESSION_TTL_MS;
    this.sessionAffinity.delete(sessionKey);
    this.sessionAffinity.set(sessionKey, b);
    return b;
  }

  /**
   * 选号核心：手动指定 > 会话亲和粘滞 > 未冷却 LRU 最久未用 > 全冷却取最快恢复
   * @param {string} realm 'global' 或 'cn'
   * @param {Set<string>} exclude 需排除的 uid 集合
   * @param {string} sessionKey 客户端会话标识 (convId)
   */
  pick(realm, exclude = new Set(), sessionKey = '') {
    const all = this.vault.getAccounts();
    const usable = a => !a.disabled && a.uid && !exclude.has(a.uid);
    let candidates = all.filter(a => usable(a) && a.realm === realm);
    if (!candidates.length) candidates = all.filter(usable); // 兼容 realm 缺失的老数据
    if (!candidates.length) return null;

    // 1. 手动锁定某账号时优先使用
    const selected = this.getSelectedUid();
    if (selected) {
      const s = candidates.find(a => a.uid === selected && !this.isCooling(selected) && !exclude.has(selected));
      if (s) return s;
    }

    // 2. 会话亲和表查询（优先命中同会话锁定的账号，保住腾讯上游 KV-Cache）
    if (sessionKey) {
      const bound = this.getBinding(sessionKey);
      if (bound) {
        const boundAcc = candidates.find(a => a.uid === bound.uid);
        if (boundAcc && !this.isCooling(boundAcc.uid) && !exclude.has(boundAcc.uid)) {
          return boundAcc;
        }
      }
    }

    // 3. 新分配或遇冷换号：在未冷却候选账号中，按最久未用 (LRU) 均摊并发
    const healthy = candidates.filter(a => !this.isCooling(a.uid));
    let chosen = null;
    if (healthy.length) {
      chosen = healthy.reduce((m, a) => ((a.last_used || 0) < (m.last_used || 0) ? a : m));
    } else {
      chosen = candidates.reduce((m, a) => (this.cooldownRemainSec(a.uid) < this.cooldownRemainSec(m.uid) ? a : m));
    }

    // 自动为新会话绑定亲和表，并立即更新 last_used 避免突发新并发扎堆钉死单账号（Hark 审查加固）
    if (chosen) {
      this.touch(chosen.uid);
      if (sessionKey) {
        this.bindSession(sessionKey, chosen.uid);
      }
    }
    return chosen;
  }

  /** 成功出流或选号时记最近使用（单调递增戳，防同毫秒并发突发扎堆钉死单账号，易变字段，不触发云端同步） */
  touch(uid) {
    const now = Math.max(Date.now(), (this._lastStamp || 0) + 1);
    this._lastStamp = now;
    this.vault.updateAccount(uid, a => { a.last_used = now; }, { quiet: true });
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
  clearAffinity() { this.sessionAffinity.clear(); }
}
