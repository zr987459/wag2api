/**
 * Supabase PostgreSQL Database Vault for wag2api
 *
 * 遵循 Hark 架构审查与生产安全防御：
 * 1. 采用 pg.Pool 连接池（max 2, 5s超时, idleTimeout 30s）并监听 error，杜绝断线导致 Node 崩溃；
 * 2. 启动 restore 加 5s 超时熔断，防止数据库不可达拖死 Render 服务监听；
 * 3. 启用 RLS 行级安全防护（ALTER TABLE wag_vault ENABLE ROW LEVEL SECURITY），阻断匿名 Data API 读取凭据；
 * 4. 恢复过程静默，杜绝反复回写数据库。
 */

export class DbVault {
  constructor(dsn) {
    this.dsn = (dsn || process.env.SQL_DSN || '').trim();
    this.enabled = Boolean(this.dsn && !this.dsn.includes('YOUR-PASSWORD'));
    this.pool = null;
    this.initialized = false;
    this.pg = null;
    this.isRestoring = false; // 恢复期间守卫，避免递归写库
  }

  async getPg() {
    if (this.pg) return this.pg;
    try {
      const mod = await import('pg');
      this.pg = mod.default || mod;
      return this.pg;
    } catch (e) {
      return null;
    }
  }

  async getPool() {
    if (!this.enabled) return null;
    if (this.pool) return this.pool;
    try {
      const pgModule = await this.getPg();
      if (!pgModule || !pgModule.Pool) return null;

      // [Hark P0 审查] 使用连接池，并挂载 error 监听，防止空闲断开 crash Node 进程
      const pool = new pgModule.Pool({
        connectionString: this.dsn,
        max: 2,
        idleTimeoutMillis: 30000,
        connectionTimeoutMillis: 5000,
        ssl: { rejectUnauthorized: false }, // 兼容 Supabase pooler 证书
      });

      pool.on('error', (err) => {
        console.warn('[DbVault] PostgreSQL 连接池后台异常 (已隔离守护):', err.message);
      });

      this.pool = pool;

      if (!this.initialized) {
        // [Hark P1 安全防御] 建立表并开启 RLS 保护，阻断匿名读取
        await pool.query(`
          CREATE TABLE IF NOT EXISTS wag_vault (
            key VARCHAR(128) PRIMARY KEY,
            type VARCHAR(32) NOT NULL,
            content TEXT NOT NULL,
            updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
          );
          ALTER TABLE wag_vault ENABLE ROW LEVEL SECURITY;
        `);
        this.initialized = true;
      }
      return this.pool;
    } catch (e) {
      console.warn('[DbVault] 初始化 Supabase 连接池失败:', e.message);
      this.pool = null;
      return null;
    }
  }

  /**
   * 启动时调用：从云端数据库恢复全部账号（带 5 秒超时保护）
   */
  async restore({ onAgAccount, onWbAccounts }) {
    if (!this.enabled) return;

    const doRestore = async () => {
      this.isRestoring = true;
      try {
        const pool = await this.getPool();
        if (!pool) return;

        const res = await pool.query('SELECT key, type, content FROM wag_vault');
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
      } finally {
        this.isRestoring = false;
      }
    };

    // [Hark P1 启动超时熔断] 限制在 5 秒以内，绝不拖死服务监听
    const timeoutPromise = new Promise(resolve => setTimeout(resolve, 5000));
    await Promise.race([doRestore(), timeoutPromise]);
  }

  /**
   * 保存或更新一个账号到云端数据库
   */
  async save(key, type, content) {
    if (!this.enabled || this.isRestoring) return;
    try {
      const pool = await this.getPool();
      if (!pool) return;
      await pool.query(`
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
    if (!this.enabled || this.isRestoring) return;
    try {
      const pool = await this.getPool();
      if (!pool) return;
      await pool.query('DELETE FROM wag_vault WHERE key = $1', [key]);
      console.log(`[DbVault] 已从 Supabase 云端数据库删除账号: ${key}`);
    } catch (e) {
      console.warn(`[DbVault] 从云端数据库删除账号失败 (${key}):`, e.message);
    }
  }
}

export const dbVault = new DbVault();
