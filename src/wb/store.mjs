/**
 * WB 引擎落盘：DATA_DIR/wb/
 *   accounts.json   账号库（对应安卓 SharedPreferences workbuddy_vault，单一事实来源）
 *   auths/          workbuddy-<uid>.json 官方格式凭证（双向同步；手动丢进来的文件启动 / 读取时自动并入）
 *   settings.json   默认引擎、选中账号、网关总开关
 *   metrics.json    统计（日志只在内存）
 * 全部原子写（tmp + rename）。
 */
import fs from 'fs';
import path from 'path';

export function atomicWrite(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, text, 'utf-8');
  fs.renameSync(tmp, file);
}

export function readJson(file, fallback) {
  try {
    if (!fs.existsSync(file)) return fallback;
    return JSON.parse(fs.readFileSync(file, 'utf-8'));
  } catch (e) {
    console.error(`[WB] 读取 ${path.basename(file)} 失败:`, e.message);
    return fallback;
  }
}

export class Settings {
  constructor(dir, defaults = {}, onChange = () => {}) {
    this.onChange = onChange;
    this.file = path.join(dir, 'settings.json');
    this.data = { default_engine: 'wb', selected_uid: '', gateway_enabled: true, ...defaults, ...readJson(this.file, {}) };
  }
  get(k) { return this.data[k]; }
  set(k, v) { this.data[k] = v; atomicWrite(this.file, JSON.stringify(this.data, null, 2)); this.onChange(); }
}
