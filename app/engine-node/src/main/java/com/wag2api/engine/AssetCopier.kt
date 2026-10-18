package com.wag2api.engine

import android.content.Context
import java.io.File

/**
 * 把打包在 assets/gateway 的网关代码同步到私有目录。
 * data/ 目录（账号、配置）保留不动，升级只覆盖 src/。
 */
object AssetCopier {

    fun sync(ctx: Context, root: File, versionTag: String) {
        val marker = File(root, ".version")
        if (marker.exists() && marker.readText() == versionTag) return

        File(root, "src").deleteRecursively()
        copy(ctx, "gateway", root)
        File(root, "data/accounts").mkdirs()
        marker.writeText(versionTag)
    }

    private fun copy(ctx: Context, path: String, dest: File) {
        val list = ctx.assets.list(path) ?: return
        if (list.isEmpty()) {
            dest.parentFile?.mkdirs()
            ctx.assets.open(path).use { input -> dest.outputStream().use { input.copyTo(it) } }
        } else {
            dest.mkdirs()
            for (name in list) copy(ctx, "$path/$name", File(dest, name))
        }
    }
}
