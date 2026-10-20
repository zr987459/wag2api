/**
 * Supabase PostgreSQL Database Vault for wag2api
 *
 * 核心功能：
 * 当配置了 SQL_DSN 环境变量且存在 pg 驱动时，直接将网页控制台添加/导入的全部账号（Google AG 与 腾讯 WB）
 * 实时同步保存到云端 Supabase 数据库的 wag_vault 表中。
 * 容器启动时自动从云端数据库拉取恢复，彻底解决 Render 等容器重启后丢失账号的问题。
 */

export class DbVault {
  constructor(dsn) {
    this.dsn = (dsn || process.env.SQL_DSN || '').trim();
    this.enabled = Boolean(this.dsn && !this.dsn.includes('YOUR-PASSWORD'));
    this.client = null;
    this.initialized = false;
    this.pg = null;
  }

  async getPg() {
    if (this.pg) return this.pg;
    try {
      const mod = await import('pg');
      this.pg = mod.default || mod;
      return this.pg;
    } catch (e) {
      // 零依赖环境兜底，避免单元测试因缺少外部驱动崩溃
      return null;
    }
  }

  async getClient() {
    if (!this.enabled) return null;
    if (this.client) return this.client;
    try {
      const pgModule = await this.getPg();
      if (!pgModule || !pgModule.Client) {
        return null;
      }
      const client = new pgModule.Client({ connectionString: this.dsn });
      await client.connect();
      this.client = client;
      if (!this.initialized) {
        await client.query(`
          CREATE TABLE IF NOT EXISTS wag_vault (
            key VARCHAR(128) PRIMARY KEY,
            type VARCHAR(32) NOT NULL,
            content TEXT NOT NULL,
            updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
          );
        `);
        this.initialized = true;
      }
      return this.client;
    } catch (e) {
      console.warn('[DbVault] 连接 Supabase 数据库失败:', e.message);
      this.client = null;
      return null;
    }
  }

  /**
   * 启动时调用：从云端数据库恢复全部账号
   * @param {Object} options { onAgAccount: (email, refreshToken, projectId), onWbAccounts: (rawJson) }
   */
  async restore({ onAgAccount, onWbAccounts }) {
    if (!this.enabled) return;
    try {
      const client = await this.getClient();
      if (!client) return;

      const res = await client.query('SELECT key, type, content FROM wag_vault');
      let agCount = 0;
      let wbCount = 0;

      for (const row of res.rows) {
        if (row.type === 'ag_account' && typeof onAgAccount === 'function') {
          try {
            const data = JSON.parse(row.content);
            if (data.email && data.refreshToken) {
              onAgAccount(data.email, data.refreshToken, data.projectId || '');
              agCount++;
            }
          } catch (e) {}
        } else if (row.type === 'wb_accounts' && typeof onWbAccounts === 'function') {
          try {
            onWbAccounts(row.content);
            wbCount++;
          } catch (e) {}
        }
      }
      console.log(`[DbVault] 成功从 Supabase 云数据库恢复账号: ${agCount} 个 Google AG 账号, ${wbCount} 个 WB 账号库`);
    } catch (e) {
      console.warn('[DbVault] 从云数据库恢复账号异常:', e.message);
    }
  }

  /**
   * 保存或更新一个账号到云端数据库
   */
  async save(key, type, content) {
    if (!this.enabled) return;
    try {
      const client = await this.getClient();
      if (!client) return;
      await client.query(`
        INSERT INTO wag_vault (key, type, content, updated_at)
        VALUES ($1, $2, $3, CURRENT_TIMESTAMP)
        ON CONFLICT (key) DO UPDATE SET type = EXCLUDED.type, content = EXCLUDED.content, updated_at = CURRENT_TIMESTAMP;
      `, [key, type, typeof content === 'string' ? content : JSON.stringify(content)]);
      console.log(`[DbVault] 账号已自动持久化至 Supabase 云端数据库: [${type}] ${key}`);
    } catch (e) {
      console.warn(`[DbVault] 保存账号至云数据库失败 (${key}):`, e.message);
    }
  }

  /**
   * 从云端数据库删除一个账号
   */
  async remove(key) {
    if (!this.enabled) return;
    try {
      const client = await this.getClient();
      if (!client) return;
      await client.query('DELETE FROM wag_vault WHERE key = $1', [key]);
      console.log(`[DbVault] 已从 Supabase 云端数据库删除账号: ${key}`);
    } catch (e) {
      console.warn(`[DbVault] 从云端数据库删除账号失败 (${key}):`, e.message);
    }
  }
}

export const dbVault = new DbVault();
