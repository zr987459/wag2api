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
import { getModelFamily, extractFamilyFraction } from './quota-fetcher.mjs';

export const AG_DEFAULT_COOLDOWN_MS = 10000;
export const AG_SESSION_TTL_MS = 30 * 60 * 1000; // 30 分钟会话亲和期
export const MAX_AFFINITY_ENTRIES = 1000; // 内存保护：最多存 1000 个活跃会话

export const SCHEDULING_MODES = [
  { id: 'cache_first', label: '缓存优先', desc: '会话粘滞优先，最大限度复用 Prompt 缓存' },
  { id: 'balance', label: '均衡轮询', desc: '不粘性，综合配额与最近使用均衡调度' },
  { id: 'performance', label: '性能优先', desc: '不粘性，优先最近成功率高、延迟低的账号' },
  { id: 'fixed', label: '固定账号', desc: '固定使用指定账号，遇冷或失败时自动切换' },
];

export class AccountPool {
  constructor(accountsDir, options = {}) {
    this.accountsDir = accountsDir;
    this.options = options;
    this.schedulingFile = options.schedulingFile || (
      path.basename(accountsDir) === 'accounts'
        ? path.join(path.dirname(accountsDir), 'scheduling.json')
        : path.join(accountsDir, 'scheduling.json')
    );
    this.schedulingMode = 'cache_first';
    this.fixedEmail = '';
    this.perfHistory = new Map(); // email -> { records: [{ success, latency_ms }], fail_streak }
    this.quotaMap = new Map();    // email -> { gemini, claude, argon }
    this.managers = new Map(); // email -> TokenManager
    this.activeEmail = '';     // 兼容老字段
    this.selectedEmail = '';   // 手动指定的账号，为空表示自动智能调度
    this.cooldownUntil = new Map(); // email -> expireTimestamp
    this.validationBlocks = new Map(); // email -> { reason, url, until }
    this.sessionAffinity = new Map(); // sessionKey -> { email, expireAt }
    this.lastUsed = new Map(); // email -> timestamp
    this.init();
  }

  init() {
    this.loadScheduling();
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

    // 自动云端持久化到 Supabase
    import('./db-vault.mjs').then(({ dbVault }) => {
      dbVault.save(cleanEmail, 'ag_account', { email: cleanEmail, refreshToken, projectId });
    }).catch(() => {});

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
      this.validationBlocks.delete(clean);
      this.lastUsed.delete(clean);
      this.perfHistory.delete(clean);
      this.quotaMap.delete(clean);

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

      // 从云端数据库同步删除
      import('./db-vault.mjs').then(({ dbVault }) => {
        dbVault.remove(clean);
      }).catch(() => {});

      return true;
    }
    return false;
  }

  clearAccounts() {
    this.managers.clear();
    this.activeEmail = '';
    this.selectedEmail = '';
    this.cooldownUntil.clear();
    this.validationBlocks.clear();
    this.sessionAffinity.clear();
    this.lastUsed.clear();
    this.perfHistory.clear();
    this.quotaMap.clear();
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

  clearCooldown(email) {
    const clean = (email || '').trim();
    if (clean) this.cooldownUntil.delete(clean);
  }

  clearAllCooldowns() {
    this.cooldownUntil.clear();
  }

  // 验证封禁管理
  markValidationBlocked(email, reason = '', url = '', ms = 10 * 60 * 1000) {
    const clean = (email || '').trim();
    if (!clean) return;
    const until = Date.now() + ms;
    this.validationBlocks.set(clean, {
      reason: String(reason || ''),
      url: String(url || ''),
      until,
    });
    console.warn(`[AccountPool] 账号 ${clean} 进入人工验证封禁 (${Math.round(ms / 1000)}秒)`);
  }

  isValidationBlocked(email) {
    const clean = (email || '').trim();
    const info = this.validationBlocks.get(clean);
    if (!info) return false;
    if (Date.now() >= info.until) {
      this.validationBlocks.delete(clean);
      return false;
    }
    return true;
  }

  clearValidationBlocked(email) {
    const clean = (email || '').trim();
    this.validationBlocks.delete(clean);
  }

  validationInfo(email) {
    const clean = (email || '').trim();
    const info = this.validationBlocks.get(clean);
    if (!info || Date.now() >= info.until) {
      if (info) this.validationBlocks.delete(clean);
      return { blocked: false, reason: '', url: '', until: 0 };
    }
    return {
      blocked: true,
      reason: info.reason,
      url: info.url,
      until: info.until,
    };
  }

  clearAllValidationBlocks() {
    this.validationBlocks.clear();
  }

  // 调度持久化与设置
  loadScheduling() {
    try {
      if (this.schedulingFile && fs.existsSync(this.schedulingFile)) {
        const raw = fs.readFileSync(this.schedulingFile, 'utf8');
        const data = JSON.parse(raw);
        const validModes = ['cache_first', 'balance', 'performance', 'fixed'];
        if (data && validModes.includes(data.mode)) {
          this.schedulingMode = data.mode;
        }
        if (data && typeof data.fixed_email === 'string') {
          this.fixedEmail = data.fixed_email.trim();
          if (this.schedulingMode === 'fixed') {
            this.selectedEmail = this.fixedEmail;
          }
        }
      }
    } catch (e) {
      console.warn('[AccountPool] 读取 scheduling.json 失败:', e.message);
    }
  }

  saveScheduling() {
    try {
      if (this.schedulingFile) {
        fs.mkdirSync(path.dirname(this.schedulingFile), { recursive: true });
        const content = JSON.stringify({
          mode: this.schedulingMode,
          fixed_email: this.fixedEmail,
        }, null, 2);
        fs.writeFileSync(this.schedulingFile, content, 'utf8');
      }
    } catch (e) {
      console.warn('[AccountPool] 保存 scheduling.json 失败:', e.message);
    }
  }

  getSchedulingMode() { return this.schedulingMode; }
  getFixedEmail() { return this.fixedEmail; }

  getScheduling() {
    return {
      mode: this.schedulingMode,
      fixed_email: this.fixedEmail,
      modes: SCHEDULING_MODES,
    };
  }

  setScheduling({ mode, fixed_email = '' } = {}) {
    const validModes = ['cache_first', 'balance', 'performance', 'fixed'];
    if (!mode || !validModes.includes(mode)) {
      throw new Error(`无效的调度模式: ${mode}`);
    }
    this.schedulingMode = mode;
    this.fixedEmail = (fixed_email || '').trim();
    if (this.schedulingMode === 'fixed') {
      this.selectedEmail = this.fixedEmail;
    } else if (this.selectedEmail === this.fixedEmail) {
      this.selectedEmail = '';
    }
    this.saveScheduling();
    console.log(`[AccountPool] 调度策略已更新 ➔ 模式: ${this.schedulingMode}${this.fixedEmail ? ', 固定账号: ' + this.fixedEmail : ''}`);
    return this.getScheduling();
  }

  // 性能统计与配额
  recordResult(email, success, latencyMs = 0) {
    const clean = (email || '').trim();
    if (!clean) return;
    let history = this.perfHistory.get(clean);
    if (!history) {
      history = { records: [], fail_streak: 0 };
      this.perfHistory.set(clean, history);
    }
    const isSuccess = Boolean(success);
    history.records.push({
      success: isSuccess,
      latency_ms: Math.max(0, Math.round(Number(latencyMs) || 0)),
    });
    if (history.records.length > 20) {
      history.records.shift();
    }
    if (isSuccess) {
      history.fail_streak = 0;
    } else {
      history.fail_streak = (history.fail_streak || 0) + 1;
    }
  }

  getPerfStats(email) {
    const clean = (email || '').trim();
    const history = this.perfHistory.get(clean);
    if (!history || !history.records.length) {
      return {
        success_rate: null,
        avg_latency_ms: null,
        fail_streak: 0,
      };
    }
    const recs = history.records;
    const successes = recs.filter(r => r.success).length;
    const success_rate = Math.round((successes / recs.length) * 100) / 100;
    const sumLatency = recs.reduce((sum, r) => sum + r.latency_ms, 0);
    const avg_latency_ms = Math.round(sumLatency / recs.length);
    return {
      success_rate,
      avg_latency_ms,
      fail_streak: history.fail_streak || 0,
    };
  }

  updateQuota(email, quotaObj) {
    const clean = (email || '').trim();
    if (!clean) return;
    if (typeof quotaObj === 'number') {
      this.quotaMap.set(clean, { gemini: quotaObj, claude: quotaObj, argon: quotaObj });
      return;
    }
    if (!quotaObj || typeof quotaObj !== 'object') return;
    const prev = this.quotaMap.get(clean) || { gemini: null, claude: null, argon: null };
    const next = {
      gemini: quotaObj.gemini !== undefined ? quotaObj.gemini : extractFamilyFraction(quotaObj, 'gemini'),
      claude: quotaObj.claude !== undefined ? quotaObj.claude : extractFamilyFraction(quotaObj, 'claude'),
      argon: quotaObj.argon !== undefined ? quotaObj.argon : extractFamilyFraction(quotaObj, 'argon'),
    };
    this.quotaMap.set(clean, { ...prev, ...next });
  }

  getQuota(email, family = 'gemini') {
    const clean = (email || '').trim();
    const entry = this.quotaMap.get(clean);
    if (!entry) return null;
    if (typeof entry === 'number') return entry;
    const fam = (family || 'gemini').toLowerCase();
    const val = entry[fam];
    return typeof val === 'number' ? val : null;
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

  _pickBalanced(candidates, family) {
    if (candidates.length === 1) return candidates[0];
    const scored = candidates.map(e => {
      const q = this.getQuota(e, family);
      const effectiveQ = typeof q === 'number' ? q : 0.5;
      const last = this.lastUsed.get(e) || 0;
      return { email: e, q: effectiveQ, last };
    });

    // 比较两项：
    // 若配额差距超过 0.15 (15%)，配额高者胜出；
    // 否则配额接近，最久未使用的优先，实现负载均衡轮询。
    scored.sort((a, b) => {
      const qDiff = b.q - a.q;
      if (Math.abs(qDiff) > 0.15) {
        return qDiff;
      }
      return a.last - b.last;
    });

    return scored[0].email;
  }

  _pickPerformance(candidates) {
    if (candidates.length === 1) return candidates[0];
    const scored = candidates.map(e => {
      const perf = this.getPerfStats(e);
      const failStreak = perf.fail_streak || 0;
      const successRate = typeof perf.success_rate === 'number' ? perf.success_rate : 0.8;
      const latency = typeof perf.avg_latency_ms === 'number' ? perf.avg_latency_ms : 1500;
      const last = this.lastUsed.get(e) || 0;
      return { email: e, failStreak, successRate, latency, last };
    });

    scored.sort((a, b) => {
      // 1. 连败次数越少越优先
      if (a.failStreak !== b.failStreak) {
        return a.failStreak - b.failStreak;
      }
      // 2. 成功率越高越优先 (差值 > 0.05 时)
      const srDiff = b.successRate - a.successRate;
      if (Math.abs(srDiff) > 0.05) {
        return srDiff;
      }
      // 3. 平均延迟越低越优先 (差值 > 100ms 时)
      const latDiff = a.latency - b.latency;
      if (Math.abs(latDiff) > 100) {
        return latDiff;
      }
      // 4. 最久未使用兜底
      return a.last - b.last;
    });

    return scored[0].email;
  }

  /**
   * 核心：智能选号（调度模式 + 会话粘滞 + 家族配额 + 冷却避障）
   * @param {string} sessionKey 客户端会话标识
   * @param {Set<string>} exclude 需排除的邮箱
   * @param {object|string} options 模型名称或选项 { model, family }
   */
  pickManager(sessionKey = '', exclude = new Set(), options = {}) {
    if (this.managers.size === 0) return null;

    const allEmails = Array.from(this.managers.keys());
    const usableEmails = allEmails.filter(e => !exclude.has(e) && !this.isValidationBlocked(e));
    if (!usableEmails.length) return null;

    let model = '';
    let family = 'gemini';
    if (typeof options === 'string') {
      model = options;
      family = getModelFamily(model);
    } else if (options && typeof options === 'object') {
      model = options.model || '';
      family = options.family || (model ? getModelFamily(model) : 'gemini');
    }

    const healthyEmails = usableEmails.filter(e => !this.isCooling(e));

    // 如果全员都在冷却中，兜底：选择剩余冷却时间最短（最快恢复）的账号
    if (healthyEmails.length === 0) {
      const chosenEmail = usableEmails.reduce((minE, e) => {
        return this.cooldownRemainSec(e) < this.cooldownRemainSec(minE) ? e : minE;
      }, usableEmails[0]);
      if (chosenEmail) {
        this.touch(chosenEmail);
        this.activeEmail = chosenEmail;
        return this.managers.get(chosenEmail);
      }
      return null;
    }

    // 辅助函数：根据配额 <5% 区分优先级（有 >=5% 或 null 的号时，<5% 的号排后）
    const filterLowQuota = (emails) => {
      const nonLow = emails.filter(e => {
        const q = this.getQuota(e, family);
        return q === null || q >= 0.05;
      });
      return nonLow.length > 0 ? nonLow : emails;
    };

    let chosenEmail = '';

    // ================= 模式 1: fixed =================
    if (this.schedulingMode === 'fixed') {
      const target = (this.fixedEmail || this.selectedEmail || '').trim();
      if (target && healthyEmails.includes(target)) {
        chosenEmail = target;
      } else {
        const candidates = filterLowQuota(healthyEmails);
        chosenEmail = this._pickBalanced(candidates, family);
      }
    }
    // ================= 模式 2: cache_first (默认，粘性优先) =================
    else if (this.schedulingMode === 'cache_first') {
      // 兼容手动锁定
      if (this.selectedEmail && healthyEmails.includes(this.selectedEmail)) {
        chosenEmail = this.selectedEmail;
      }
      // 会话亲和表优先
      else if (sessionKey) {
        const bound = this.sessionAffinity.get(sessionKey);
        if (bound && bound.expireAt > Date.now()) {
          const boundEmail = bound.email;
          if (healthyEmails.includes(boundEmail)) {
            bound.expireAt = Date.now() + AG_SESSION_TTL_MS;
            chosenEmail = boundEmail;
          }
        }
      }

      // 未命中会话粘滞时：在健康未冷却账号中，排后 <5% 的号，选最久未用 (LRU)
      if (!chosenEmail) {
        const candidates = filterLowQuota(healthyEmails);
        chosenEmail = candidates.reduce((minE, e) => {
          const tMin = this.lastUsed.get(minE) || 0;
          const tCur = this.lastUsed.get(e) || 0;
          return tCur < tMin ? e : minE;
        }, candidates[0]);
      }
    }
    // ================= 模式 3: balance (不粘性，按配额+最近使用均衡) =================
    else if (this.schedulingMode === 'balance') {
      const candidates = filterLowQuota(healthyEmails);
      chosenEmail = this._pickBalanced(candidates, family);
    }
    // ================= 模式 4: performance (不粘性，优先最近成功率高/延迟低) =================
    else if (this.schedulingMode === 'performance') {
      const candidates = filterLowQuota(healthyEmails);
      chosenEmail = this._pickPerformance(candidates);
    }

    if (chosenEmail) {
      this.touch(chosenEmail);
      if (sessionKey && this.schedulingMode === 'cache_first') {
        this.bindSession(sessionKey, chosenEmail);
      }
      this.activeEmail = chosenEmail;
      return this.managers.get(chosenEmail);
    }

    return null;
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
    return Array.from(this.managers.entries()).map(([email, tm]) => {
      const vInfo = this.validationInfo(email);
      const perf = this.getPerfStats(email);
      return {
        email,
        cooling: this.isCooling(email),
        cooldown_sec: this.cooldownRemainSec(email),
        last_used: this.lastUsed.get(email) || 0,
        isActive: email === (this.selectedEmail || this.activeEmail),
        validation_blocked: vInfo.blocked,
        validation_url: vInfo.url,
        validation_reason: vInfo.reason,
        success_rate: perf.success_rate,
        avg_latency_ms: perf.avg_latency_ms,
        fail_streak: perf.fail_streak,
        ...tm.getStatus(),
      };
    });
  }

  getAllStatus() {
    return this.poolStatus();
  }
}
