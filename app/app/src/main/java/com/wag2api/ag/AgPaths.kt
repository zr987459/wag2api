package com.wag2api.ag

import android.content.Context
import android.util.Log
import java.io.File

/**
 * AG 引擎数据目录（= Node 版 paths.mjs 的 DATA_DIR）。
 * KotlinAgEngine.start() 调用 [init]：dataDir = filesDir/ag；首次启动时把旧 Node 版数据迁移过来并删掉旧运行时文件。
 */
object AgPaths {
    private const val TAG = "AgPaths"
    private const val MIGRATED_MARKER = ".migrated_from_node"

    /** 数据目录；init 前是临时目录（只为防止过早访问崩溃） */
    @Volatile
    @JvmStatic
    var dataDir: File = File(System.getProperty("java.io.tmpdir") ?: "/data/local/tmp", "ag")
        private set

    @Volatile
    private var initialized = false

    @JvmStatic
    @Synchronized
    fun init(ctx: Context): File {
        if (initialized) return dataDir
        val filesDir = ctx.applicationContext.filesDir
        val dir = File(filesDir, "ag")
        dir.mkdirs()
        dataDir = dir
        try {
            migrateFromNode(filesDir, dir)
        } catch (e: Throwable) {
            Log.e(TAG, "旧 Node 数据迁移失败: ${e.message}")
        }
        File(dir, "accounts").mkdirs()
        initialized = true
        return dir
    }

    /** Node 版（engine-node 的 NodeService）数据在 filesDir/gateway/data；更早的 nodejs-mobile 模板用 filesDir/nodejs-project */
    private fun migrateFromNode(filesDir: File, dest: File) {
        val oldRoots = listOf(File(filesDir, "gateway"), File(filesDir, "nodejs-project"))
        val marker = File(dest, MIGRATED_MARKER)
        if (!marker.exists()) {
            var copiedAll = true
            for (root in oldRoots) {
                val data = File(root, "data")
                if (!data.isDirectory) continue
                // 只补齐新目录里还没有的文件，不覆盖 Kotlin 版已经写过的数据
                if (!copyMissing(data, dest)) copiedAll = false
                Log.i(TAG, "已迁移旧 Node 数据: ${data.path}")
            }
            if (!copiedAll) return // 有文件没复制成功：保留旧目录，下次再试
            marker.writeText(System.currentTimeMillis().toString())
        }
        // 迁移完成后删除旧 Node 运行时与源码（含旧数据副本），释放空间
        for (root in oldRoots) {
            if (root.exists()) {
                root.deleteRecursively()
                Log.i(TAG, "已删除旧 Node 运行时目录: ${root.path}")
            }
        }
    }

    private fun copyMissing(src: File, dst: File): Boolean {
        var ok = true
        if (src.isDirectory) {
            if (!dst.exists() && !dst.mkdirs()) return false
            for (child in src.listFiles() ?: emptyArray()) {
                if (!copyMissing(child, File(dst, child.name))) ok = false
            }
        } else if (src.isFile && !dst.exists()) {
            try {
                src.copyTo(dst, overwrite = false)
            } catch (e: Exception) {
                Log.w(TAG, "复制失败 ${src.path}: ${e.message}")
                ok = false
            }
        }
        return ok
    }
}
