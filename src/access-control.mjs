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
    if (h['x-admin-key']) return String(h['x-admin-key']).trim();
    const auth = String(h['authorization'] || '');
    if (/^bearer\s+/i.test(auth)) return auth.replace(/^bearer\s+/i, '').trim();
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
