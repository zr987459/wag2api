/**
 * Multi-Account Pool & Smart Concurrent Scheduler for Google Antigravity
 *
 * 遵循 Hark 架构规范与审查防御：
 * 1. 状态机与冷却管理：与 upstream-policy 联动，速率 429 与配额耗尽标记冷却并自动避障；
 * 2. 会话粘滞 (Session Affinity)：会话亲和表（带 TTL 与 1000 条 LRU 上限防泄漏），保持 KV-Cache 前缀命中；
 * 3. 换号后亲和表更新：因限流故障转移到新账号后，自动将会话重绑至新账号，防止振荡；
 * 4. 兼容老接口：保留 switchAccount(email) 别名防 500。
 */

import fs from 'fs';
import path from 'path';
import { TokenManager } from './token-manager.mjs';

export const AG_DEFAULT_COOLDOWN_MS = 10000;
export const AG_SESSION_TTL_MS = 30 * 60 * 1000; // 30 分钟会话亲和期
export const MAX_AFFINITY_ENTRIES = 1000; // 内存保护：最多存 1000 个活跃会话

export class AccountPool {
  constructor(accountsDir) {
    this.accountsDir = accountsDir;
    this.managers = new Map(); // email -> TokenManager
    this.activeEmail = '';     // 兼容老字段
    this.selectedEmail = '';   // 手动指定的账号，为空表示自动智能调度
    this.cooldownUntil = new Map(); // email -> expireTimestamp
    this.sessionAffinity = new Map(); // sessionKey -> { email, expireAt }
    this.lastUsed = new Map(); // email -> timestamp
    this.init();
  }

  init() {
    if (!fs.existsSync(this.accountsDir)) {
      fs.mkdirSync(this.accountsDir, { recursive: true });
    }
    const files = fs.readdirSync(this.accountsDir);
    for (const f of files) {
      if (f.endsWith('.json')) {
        const filePath = path.join(this.accountsDir, f);
        const tm = new TokenManager(filePath);
        if (tm.tokenData.email) {
          const email = tm.tokenData.email.trim();
          this.managers.set(email, tm);
          if (!this.activeEmail) this.activeEmail = email;
        }
      }
    }

    // 环境变量自动注入（Render / 云端部署利器）
    const envAg = process.env.AG_ACCOUNTS || process.env.AG_TOKENS || process.env.GOOGLE_ACCOUNTS;
    if (envAg) {
      try {
        let items = [];
        try {
          const parsed = JSON.parse(envAg);
          items = Array.isArray(parsed) ? parsed : [parsed];
        } catch (e) {
          const parts = envAg.split(':');
          if (parts.length >= 2) items = [{ email: parts[0], refreshToken: parts.slice(1).join(':') }];
        }
        for (const it of items) {
          if (it.refreshToken && it.email) {
            this.addAccount(it.refreshToken, it.email.trim(), it.projectId || '');
            console.log(`[AccountPool] 成功从环境变量注入 AG 账号: ${it.email}`);
          }
        }
      } catch (e) {
        console.warn('[AccountPool] 环境变量注入 AG 账号失败:', e.message);
      }
    }
  }

  addAccount(refreshToken, email, projectId = '') {
    const cleanEmail = (email || '').trim();
    const filename = `${cleanEmail.replace(/[^a-zA-Z0-9]/g, '_')}.json`;
    const filePath = path.join(this.accountsDir, filename);
    const tm = new TokenManager(filePath);
    tm.setRefreshToken(refreshToken, cleanEmail);
    if (projectId) tm.tokenData.projectId = projectId;
    this.managers.set(cleanEmail, tm);
    if (!this.activeEmail || !this.managers.has(this.activeEmail)) this.activeEmail = cleanEmail;
    return tm;
  }

  // [P0 阻断修复] 保留 switchAccount 作为兼容别名，防止 /api/accounts/switch 报 500
  switchAccount(email) {
    this.setSelectedEmail(email);
    return this.getActiveManager();
  }

  removeAccount(email) {
    const clean = (email || '').trim();
    if (this.managers.has(clean)) {
      try { this.managers.get(clean).stopKeepAlive?.(); } catch (e) {}
      this.managers.delete(clean);
      this.cooldownUntil.delete(clean);
      this.lastUsed.delete(clean);

      // 清理 sessionAffinity 中的该账号
      for (const [sKey, bound] of this.sessionAffinity.entries()) {
        if (bound.email === clean) this.sessionAffinity.delete(sKey);
      }

      const filename = `${clean.replace(/[^a-zA-Z0-9]/g, '_')}.json`;
      const filePath = path.join(this.accountsDir, filename);
      if (fs.existsSync(filePath)) {
        try { fs.unlinkSync(filePath); } catch (e) {}
      }
      if (this.selectedEmail === clean) this.selectedEmail = '';
      if (this.activeEmail === clean) {
        this.activeEmail = this.managers.size > 0 ? this.managers.keys().next().value : '';
      }
      return true;
    }
    return false;
  }

  clearAccounts() {
    this.managers.clear();
    this.activeEmail = '';
    this.selectedEmail = '';
    this.cooldownUntil.clear();
    this.sessionAffinity.clear();
    this.lastUsed.clear();
    if (fs.existsSync(this.accountsDir)) {
      const files = fs.readdirSync(this.accountsDir);
      for (const f of files) {
        if (f.endsWith('.json')) {
          try { fs.unlinkSync(path.join(this.accountsDir, f)); } catch (e) {}
        }
      }
    }
  }

  // 冷却管理
  markCooling(email, ms = AG_DEFAULT_COOLDOWN_MS) {
    const clean = (email || '').trim();
    this.cooldownUntil.set(clean, Date.now() + ms);
    console.log(`[AccountPool] 账号 ${clean} 进入冷却 (${Math.round(ms / 1000)}秒)`);
  }

  isCooling(email) {
    const clean = (email || '').trim();
    const until = this.cooldownUntil.get(clean);
    if (!until) return false;
    if (Date.now() >= until) {
      this.cooldownUntil.delete(clean);
      return false;
    }
    return true;
  }

  cooldownRemainSec(email) {
    const clean = (email || '').trim();
    const until = this.cooldownUntil.get(clean);
    if (!until) return 0;
    const left = until - Date.now();
    return left > 0 ? Math.ceil(left / 1000) : 0;
  }

  clearAllCooldowns() {
    this.cooldownUntil.clear();
  }

  // 调度设置
  getSelectedEmail() { return this.selectedEmail; }
  setSelectedEmail(email) {
    this.selectedEmail = (email || '').trim();
    if (this.selectedEmail && this.managers.has(this.selectedEmail)) {
      this.activeEmail = this.selectedEmail;
    }
    console.log(`[AccountPool] 调度模式变更 ➔ ${this.selectedEmail ? '锁定账号: ' + this.selectedEmail : '全自动智能轮询'}`);
  }

  touch(email) {
    if (!email) return;
    this.lastUsed.set(email.trim(), Date.now());
  }

  // 会话亲和绑定更新（换号或新分配时调用）
  bindSession(sessionKey, email) {
    if (!sessionKey || !email) return;
    const cleanEmail = email.trim();
    // 真正的 LRU：已存在则先删再插，移动至 Map 尾部
    if (this.sessionAffinity.has(sessionKey)) {
      this.sessionAffinity.delete(sessionKey);
    } else if (this.sessionAffinity.size >= MAX_AFFINITY_ENTRIES) {
      const oldestKey = this.sessionAffinity.keys().next().value;
      this.sessionAffinity.delete(oldestKey);
    }
    this.sessionAffinity.set(sessionKey, { email: cleanEmail, expireAt: Date.now() + AG_SESSION_TTL_MS });
  }

  /**
   * 核心：智能选号（会话粘滞 + 负载均衡 + 冷却避障）
   * @param {string} sessionKey 客户端会话标识
   * @param {Set<string>} exclude 需排除的邮箱
   */
  pickManager(sessionKey = '', exclude = new Set()) {
    if (this.managers.size === 0) return null;

    const allEmails = Array.from(this.managers.keys());
    const usableEmails = allEmails.filter(e => !exclude.has(e));
    if (!usableEmails.length) return null;

    // 1. 如果管理员手动锁定了某账号，且该账号未被排除、未冷却：优先使用
    if (this.selectedEmail && usableEmails.includes(this.selectedEmail)) {
      if (!this.isCooling(this.selectedEmail)) {
        return this.managers.get(this.selectedEmail);
      }
    }

    // 2. 会话亲和表查询：优先命中（保住 Google KV-Cache）
    if (sessionKey) {
      const bound = this.sessionAffinity.get(sessionKey);
      if (bound && bound.expireAt > Date.now()) {
        const boundEmail = bound.email;
        if (usableEmails.includes(boundEmail) && !this.isCooling(boundEmail)) {
          bound.expireAt = Date.now() + AG_SESSION_TTL_MS;
          this.touch(boundEmail);
          return this.managers.get(boundEmail);
        }
      }
    }

    // 3. 新会话分配：在健康未冷却的账号中，选择最久未用 (LRU) 的账号均摊并发
    const healthyEmails = usableEmails.filter(e => !this.isCooling(e));
    let chosenEmail = '';

    if (healthyEmails.length > 0) {
      chosenEmail = healthyEmails.reduce((minE, e) => {
        const tMin = this.lastUsed.get(minE) || 0;
        const tCur = this.lastUsed.get(e) || 0;
        return tCur < tMin ? e : minE;
      }, healthyEmails[0]);
    } else {
      // 4. 全员冷却兜底：选择剩余冷却时间最短（最快恢复）的账号
      chosenEmail = usableEmails.reduce((minE, e) => {
        return this.cooldownRemainSec(e) < this.cooldownRemainSec(minE) ? e : minE;
      }, usableEmails[0]);
    }

    if (chosenEmail) {
      this.touch(chosenEmail);
      if (sessionKey) {
        this.bindSession(sessionKey, chosenEmail);
      }
      this.activeEmail = chosenEmail;
      return this.managers.get(chosenEmail);
    }

    return this.getActiveManager();
  }

  getActiveManager() {
    if (this.managers.size === 0) return null;
    if (this.selectedEmail && this.managers.has(this.selectedEmail)) {
      return this.managers.get(this.selectedEmail);
    }
    if (this.activeEmail && this.managers.has(this.activeEmail)) {
      return this.managers.get(this.activeEmail);
    }
    const first = this.managers.values().next().value;
    this.activeEmail = first.tokenData.email;
    return first;
  }

  getManager(email) {
    if (!email) return this.getActiveManager();
    const clean = email.trim();
    if (this.managers.has(clean)) return this.managers.get(clean);
    // 容差大小写
    for (const [k, v] of this.managers.entries()) {
      if (k.toLowerCase() === clean.toLowerCase()) return v;
    }
    return null;
  }

  rotateToNext() {
    if (this.managers.size <= 1) return null;
    const emails = Array.from(this.managers.keys());
    if (emails.length <= 1) return null;
    const currentIndex = emails.indexOf(this.activeEmail);
    const nextIndex = (currentIndex + 1) % emails.length;
    this.activeEmail = emails[nextIndex];
    console.log(`[AccountPool] 触发账号池轮换 ➔ 已切换至: ${this.activeEmail}`);
    return this.getActiveManager();
  }

  poolStatus() {
    return Array.from(this.managers.entries()).map(([email, tm]) => ({
      email,
      cooling: this.isCooling(email),
      cooldown_sec: this.cooldownRemainSec(email),
      last_used: this.lastUsed.get(email) || 0,
      isActive: email === (this.selectedEmail || this.activeEmail),
      ...tm.getStatus(),
    }));
  }

  getAllStatus() {
    return this.poolStatus();
  }
}
