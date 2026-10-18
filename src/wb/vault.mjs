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
  constructor(dir) {
    this.dir = dir;
    this.file = path.join(dir, 'accounts.json');
    this.authsDir = path.join(dir, 'auths');
    fs.mkdirSync(this.authsDir, { recursive: true });
    this.list = Array.isArray(readJson(this.file, [])) ? readJson(this.file, []) : [];
    this.syncAuthsDir();
  }

  save() { atomicWrite(this.file, JSON.stringify(this.list, null, 2)); }

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

  updateAccount(uid, fn) {
    const a = this.find(uid);
    if (!a) return;
    fn(a);
    this.save();
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
