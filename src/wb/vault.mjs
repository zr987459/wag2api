/** 账号库（翻译自 AccountVault.kt） */
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { atomicWrite, readJson } from './store.mjs';

const shortId = () => 'user_' + crypto.randomUUID().slice(0, 8);
const s = v => (v === undefined || v === null ? '' : String(v));
const pick = (...vals) => { for (const v of vals) if (s(v)) return s(v); return ''; };

export function newAccount(uid, nickname, realm, accessToken, refreshToken) {
  return {
    uid, nickname, realm, accessToken, refreshToken,
    in_pool: true, disabled: false, cooling: false, credits: 350,
    token_usage: { request_count: 0, total_tokens: 0 },
  };
}

/** 解析 JWT payload（不校验签名） */
export function jwtPayload(token) {
  const parts = String(token).split('.');
  if (parts.length < 3) return null;
  try { return JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf-8')); } catch (e) { return null; }
}

export class AccountVault {
  constructor(dir, onChange = () => {}) {
    this.dir = dir;
    this.onChange = onChange;
    this.file = path.join(dir, 'accounts.json');
    this.authsDir = path.join(dir, 'auths');
    fs.mkdirSync(this.authsDir, { recursive: true });
    this.list = Array.isArray(readJson(this.file, [])) ? readJson(this.file, []) : [];
    this.syncAuthsDir();
    // auths/ 是镜像：缺的补上（例如从云端恢复后）
    for (const a of this.list) if (a.uid && a.accessToken && !fs.existsSync(path.join(this.authsDir, `workbuddy-${a.uid}.json`))) this.writeAuthFile(a);

    // 环境变量自动注入（Render / 云端部署利器，容器重启永不丢失）
    const envToken = process.env.WB_TOKEN || process.env.WORKBUDDY_TOKEN || process.env.WB_ACCOUNTS;
    if (envToken) {
      try {
        const [ok, msg] = this.importToken(envToken);
        if (ok) console.log(`[AccountVault] 成功从环境变量注入 WB 账号: ${msg}`);
      } catch (e) {
        console.warn('[AccountVault] 环境变量注入 WB 账号失败:', e.message);
      }
    }
  }

  /** @param quiet 只改了易变字段（最近使用、计数），不触发云端同步 */
  save(quiet = false) {
    atomicWrite(this.file, JSON.stringify(this.list, null, 2));
    if (!quiet) {
      this.onChange();
      import('../db-vault.mjs').then(({ dbVault }) => {
        dbVault.save('wb_accounts_main', 'wb_accounts', JSON.stringify(this.list));
      }).catch(() => {});
    }
  }

  /** 把 auths/ 里尚未入库的官方凭证并入（与安卓扫描 filesDir/auths 等价） */
  syncAuthsDir() {
    let changed = false;
    let files = [];
    try { files = fs.readdirSync(this.authsDir); } catch (e) { return; }
    for (const f of files) {
      if (!f.endsWith('.json')) continue;
      try {
        const obj = JSON.parse(fs.readFileSync(path.join(this.authsDir, f), 'utf-8'));
        const acct = obj.account || {};
        const auth = obj.auth || {};
        const uid = pick(acct.uid, obj.uid);
        const token = pick(auth.accessToken, obj.access_token, obj.accessToken);
        if (!uid || !token || this.list.some(a => a.uid === uid)) continue;
        const a = newAccount(uid, pick(acct.nickname, obj.nickname) || 'WorkBuddy用户', pick(auth.realm, obj.realm) || 'global', token,
          pick(auth.refreshToken, obj.refreshToken));
        if (Number.isFinite(obj.credits)) a.credits = obj.credits;
        this.list.push(a);
        changed = true;
      } catch (e) { /* 坏文件跳过 */ }
    }
    if (changed) this.save();
  }

  getAccounts() { return this.list; }

  find(uid) { return this.list.find(a => a.uid === uid) || null; }

  writeAuthFile(a) {
    const auth = { accessToken: a.accessToken, realm: a.realm || 'global' };
    if (a.refreshToken) auth.refreshToken = a.refreshToken;
    try {
      atomicWrite(path.join(this.authsDir, `workbuddy-${a.uid}.json`),
        JSON.stringify({ account: { uid: a.uid, nickname: a.nickname }, auth }, null, 2));
    } catch (e) { /* 镜像失败不影响主库 */ }
  }

  /** 从云端数据库或持久化全量恢复列表：保留现有状态，不重置 disabled/credits，不递归写库 */
  restoreList(raw) {
    if (!raw) return;
    try {
      const arr = typeof raw === 'string' ? JSON.parse(raw) : raw;
      if (!Array.isArray(arr) || !arr.length) return;
      const byUid = new Map(this.list.map(a => [a.uid, a]));
      for (const item of arr) {
        if (!item || !item.uid || !item.accessToken) continue;
        const existing = byUid.get(item.uid);
        if (existing) {
          existing.accessToken = item.accessToken;
          if (item.refreshToken) existing.refreshToken = item.refreshToken;
          if (item.nickname) existing.nickname = item.nickname;
          if (item.disabled !== undefined) existing.disabled = Boolean(item.disabled);
          if (item.credits !== undefined) existing.credits = item.credits;
          if (item.in_pool !== undefined) existing.in_pool = Boolean(item.in_pool);
        } else {
          this.list.push({
            ...newAccount(item.uid, item.nickname || 'WorkBuddy用户', item.realm || 'global', item.accessToken, item.refreshToken || ''),
            disabled: Boolean(item.disabled),
            credits: Number.isFinite(item.credits) ? item.credits : 350,
            in_pool: item.in_pool !== undefined ? Boolean(item.in_pool) : true,
          });
        }
      }
      this.save(true);
      for (const a of this.list) if (a.uid && a.accessToken) this.writeAuthFile(a);
    } catch (e) {
      console.warn('[AccountVault] restoreList 异常:', e.message);
    }
  }

  saveAccount(uid, nickname, realm, accessToken, refreshToken) {
    const a = newAccount(uid, nickname, realm, accessToken, refreshToken || '');
    this.list = [a, ...this.list.filter(o => o.uid !== uid)];
    this.save();
    this.writeAuthFile(a);
    return a;
  }

  deleteAccount(uid) {
    const before = this.list.length;
    this.list = this.list.filter(a => a.uid !== uid);
    this.save();
    try { fs.rmSync(path.join(this.authsDir, `workbuddy-${uid}.json`), { force: true }); } catch (e) {}
    return this.list.length !== before;
  }

  exportTokensJson() { return JSON.stringify(this.list, null, 2); }

  exportOneAccount(uid) {
    const a = this.find(uid);
    if (!a) return null;
    return { uid: a.uid, nickname: a.nickname, realm: a.realm || 'global', accessToken: a.accessToken, refreshToken: a.refreshToken || '' };
  }

  updateAccount(uid, fn, { quiet = false } = {}) {
    const a = this.find(uid);
    if (!a) return;
    fn(a);
    this.save(quiet);
  }

  updateTokens(uid, accessToken, refreshToken) {
    const a = this.find(uid);
    if (!a) return;
    a.accessToken = accessToken;
    if (refreshToken) a.refreshToken = refreshToken;
    this.save();
    this.writeAuthFile(a);
  }

  setDisabled(uid, disabled) { this.updateAccount(uid, a => { a.disabled = Boolean(disabled); }); }

  getActiveAccount(realm) {
    return this.list.find(a => a.realm === realm && !a.disabled) || this.list[0] || null;
  }

  /** 导入：JSON 数组 / 单个对象（CookieBox、auth 文件）/ 多行裸 JWT。返回 [ok, msg] */
  importToken(raw) {
    const trimmed = s(raw).trim();
    if (!trimmed) return [false, '导入内容不能为空'];
    let count = 0;

    if (trimmed.startsWith('[')) {
      try {
        const arr = JSON.parse(trimmed);
        if (Array.isArray(arr)) {
          for (const o of arr) {
            if (!o || typeof o !== 'object') continue;
            const token = pick(o.accessToken, o.access_token, o.token);
            if (!token) continue;
            this.saveAccount(pick(o.uid) || shortId(), pick(o.nickname) || '导入用户', pick(o.realm) || 'global', token,
              pick(o.refreshToken, o.refresh_token));
            count++;
          }
          return count > 0 ? [true, `成功导入 ${count} 个账号`] : [false, '未在数组中解析到有效 Token'];
        }
      } catch (e) { /* 继续尝试其他格式 */ }
    }

    if (trimmed.startsWith('{')) {
      try {
        const obj = JSON.parse(trimmed);
        const acct = obj.account && typeof obj.account === 'object' ? obj.account : obj;
        const auth = obj.auth && typeof obj.auth === 'object' ? obj.auth : obj;
        const token = pick(auth.accessToken, obj.access_token, obj.token);
        if (token) {
          const nickname = pick(acct.nickname, obj.nickname) || '导入用户';
          this.saveAccount(pick(acct.uid, obj.uid) || shortId(), nickname, pick(auth.realm, obj.realm) || 'global', token,
            pick(auth.refreshToken, obj.refresh_token));
          return [true, `成功导入账号：${nickname}`];
        }
      } catch (e) { /* 继续 */ }
    }

    for (const line of trimmed.split('\n').map(l => l.trim()).filter(Boolean)) {
      const token = /^bearer /i.test(line) ? line.slice(7).trim() : line;
      if (!token.startsWith('eyJ') || (token.match(/\./g) || []).length < 2) continue;
      const p = jwtPayload(token);
      if (p) {
        this.saveAccount(pick(p.sub) || shortId(), pick(p.preferred_username, p.name, p.email) || 'WorkBuddy用户', 'global', token, '');
      } else {
        this.saveAccount(shortId(), '导入Token', 'global', token, '');
      }
      count++;
    }
    if (count > 0) return [true, `成功导入 ${count} 个凭据`];
    return [false, '未能识别有效凭据格式，请确保为 JWT 字符串 (eyJ...) 或导出 JSON 数组'];
  }
}
