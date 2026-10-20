/**
 * Antigravity Gateway Access Control
 * 单独支持个人管理密钥鉴权
 */
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';

export class AccessControl {
  constructor(file) {
    this.file = file;
    this.adminKey = '';
    this.load();
  }

  load() {
    let data = {};
    try {
      if (fs.existsSync(this.file)) {
        data = JSON.parse(fs.readFileSync(this.file, 'utf-8'));
      }
    } catch (e) {
      console.error('[Access] keys.json 解析失败:', e.message);
    }
    this.adminKey = (process.env.ADMIN_KEY || data.admin_key || '').trim();
  }

  save() {
    let data = {};
    try {
      if (fs.existsSync(this.file)) {
        data = JSON.parse(fs.readFileSync(this.file, 'utf-8'));
      }
    } catch (e) {}
    data.admin_key = this.adminKey;
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.writeFileSync(this.file, JSON.stringify(data, null, 2), 'utf-8');
  }

  get enabled() {
    return Boolean(this.adminKey);
  }

  static safeEqual(a, b) {
    const x = Buffer.from(String(a));
    const y = Buffer.from(String(b));
    return x.length === y.length && crypto.timingSafeEqual(x, y);
  }

  static keyFromRequest(req) {
    const h = req.headers || {};
    if (h['x-api-key']) return String(h['x-api-key']).trim();
    if (h['api-key']) return String(h['api-key']).trim();
    if (h['x-admin-key']) return String(h['x-admin-key']).trim();
    if (h['x-auth-token']) return String(h['x-auth-token']).trim();
    const auth = String(h['authorization'] || '').trim();
    if (/^bearer\s+/i.test(auth)) return auth.replace(/^bearer\s+/i, '').trim();
    if (auth && !auth.includes(' ')) return auth; // 兼容客户端不带 Bearer 前缀的直接 token
    try {
      const u = new URL(req.url, 'http://127.0.0.1');
      const qk = u.searchParams.get('key') || u.searchParams.get('api_key');
      if (qk) return qk.trim();
    } catch (_) {}
    return '';
  }

  isAdmin(req) {
    if (!this.enabled) return true;
    const k = AccessControl.keyFromRequest(req);
    return Boolean(k) && AccessControl.safeEqual(k, this.adminKey);
  }

  resolve(req) {
    if (!this.enabled) return { role: 'open' };
    if (this.isAdmin(req)) return { role: 'admin' };
    return null;
  }
}
