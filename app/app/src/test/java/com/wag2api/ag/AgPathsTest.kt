package com.wag2api.ag

import android.content.Context
import android.content.ContextWrapper
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import java.io.File
import java.nio.file.Files

/** 路径与旧数据迁移：AgPaths.init（dataDir = filesDir/ag，迁移 Node 版 gateway/data、nodejs-project/data） */
class AgPathsTest {
    private lateinit var filesDir: File
    private lateinit var savedDataDir: File

    private class FakeContext(private val dir: File) : ContextWrapper(null) {
        override fun getApplicationContext(): Context = this
        override fun getFilesDir(): File = dir
    }

    private fun reset() {
        val f = AgPaths::class.java.getDeclaredField("initialized")
        f.isAccessible = true
        f.setBoolean(AgPaths, false)
    }

    @Before
    fun setUp() {
        filesDir = Files.createTempDirectory("agpaths").toFile()
        savedDataDir = AgPaths.dataDir
        reset()
    }

    @After
    fun tearDown() {
        reset()
        // 还原 dataDir，别让同一 JVM 里后跑的用例（SignatureCache 等）写进已删除的临时目录
        val f = AgPaths::class.java.getDeclaredField("dataDir")
        f.isAccessible = true
        f.set(null, savedDataDir)
        filesDir.deleteRecursively()
    }

    @Test
    fun initCreatesDataDirAndAccounts() {
        val dir = AgPaths.init(FakeContext(filesDir))
        assertEquals(File(filesDir, "ag"), dir)
        assertEquals(dir, AgPaths.dataDir)
        assertTrue(File(dir, "accounts").isDirectory)
        // 再次 init 不会换目录
        assertEquals(dir, AgPaths.init(FakeContext(Files.createTempDirectory("other").toFile())))
    }

    @Test
    fun migratesOldNodeDataWithoutOverwritingAndDeletesRuntime() {
        val old = File(filesDir, "gateway/data")
        File(old, "accounts").mkdirs()
        File(old, "accounts/a@x.com.json").writeText("{\"email\":\"a@x.com\"}")
        File(old, "settings.json").writeText("{\"old\":true}")
        File(filesDir, "gateway/src").mkdirs()
        File(filesDir, "gateway/src/server.mjs").writeText("// node")
        val older = File(filesDir, "nodejs-project/data")
        older.mkdirs()
        File(older, "user_stats.json").writeText("{}")
        // Kotlin 版已写过的文件不能被覆盖
        File(filesDir, "ag").mkdirs()
        File(filesDir, "ag/settings.json").writeText("{\"new\":true}")

        val dir = AgPaths.init(FakeContext(filesDir))
        assertEquals("{\"email\":\"a@x.com\"}", File(dir, "accounts/a@x.com.json").readText())
        assertEquals("不覆盖新数据", "{\"new\":true}", File(dir, "settings.json").readText())
        assertTrue(File(dir, "user_stats.json").isFile)
        assertTrue(File(dir, ".migrated_from_node").isFile)
        assertFalse("迁移后删除旧 Node 目录", File(filesDir, "gateway").exists())
        assertFalse(File(filesDir, "nodejs-project").exists())
    }
}
