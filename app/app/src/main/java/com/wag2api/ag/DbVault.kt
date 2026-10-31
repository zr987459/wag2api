package com.wag2api.ag

/**
 * 移植自 src/db-vault.mjs（Supabase PostgreSQL 云端账号备份）
 *
 * Node 版依赖可选的 `pg` 驱动，且只在设置了 SQL_DSN 环境变量时启用；
 * 安卓版不新增依赖（没有 PostgreSQL 驱动），也没有 SQL_DSN，所以这里保持同样的接口，
 * 但始终处于未启用状态：restore/save/remove 直接返回，行为等同 Node 版未配置 SQL_DSN 时。
 */
class DbVault(dsn: String? = null) {
    val dsn: String = (dsn ?: System.getenv("SQL_DSN") ?: "").trim()
    /** 安卓版没有 pg 驱动：恒为 false */
    val enabled: Boolean = false
    /** 配了 DSN 但安卓不支持时为 true（供界面提示用） */
    val configuredButUnsupported: Boolean = this.dsn.isNotEmpty() && !this.dsn.contains("YOUR-PASSWORD")
    @Volatile var isRestoring = false

    init {
        if (configuredButUnsupported) M2Log.w("[DbVault] 安卓版不支持 Supabase/PostgreSQL 云端备份，已忽略 SQL_DSN")
    }

    /** 启动时从云端恢复账号：onAgAccount(email, refreshToken, projectId) */
    fun restore(onAgAccount: ((String, String, String) -> Unit)? = null, onWbAccounts: ((Any?) -> Unit)? = null) {
        if (!enabled) return
    }

    /** 保存或更新一个账号到云端 */
    fun save(key: String, type: String, content: Any?) {
        if (!enabled || isRestoring) return
    }

    /** 从云端删除一个账号 */
    fun remove(key: String) {
        if (!enabled || isRestoring) return
    }

    companion object {
        @JvmStatic val dbVault: DbVault by lazy { DbVault() }
    }
}

/** 与 mjs 导出名一致的单例 */
val dbVault: DbVault get() = DbVault.dbVault

