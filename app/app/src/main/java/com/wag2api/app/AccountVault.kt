package com.wag2api.app

import android.content.Context
import android.content.SharedPreferences
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.util.UUID

object AccountVault {

    private const val PREF_NAME = "workbuddy_vault"
    private const val KEY_ACCOUNTS = "accounts"

    private lateinit var prefs: SharedPreferences
    private lateinit var appContext: Context

    fun init(context: Context) {
        appContext = context
        prefs = context.getSharedPreferences(PREF_NAME, Context.MODE_PRIVATE)
        invalidate()
    }

    /**
     * 内存快照：getAccounts() 以前每次都扫 auths/ 目录 + 解析全部 JSON，
     * 每个请求要走 2~3 次（pick / touch / getActiveAccount），全程持锁。
     * 现在只在写操作后失效，读走内存，返回深拷贝防止调用方改坏缓存。
     */
    @Volatile private var cache: String? = null
    /** auths/ 目录 mtime：外部（如手动拷入凭证文件）增删文件时让缓存自动失效 */
    @Volatile private var cacheDirStamp = 0L

    private fun invalidate() { cache = null }

    @Synchronized
    fun getAccounts(): JSONArray {
        val stamp = File(appContext.filesDir, "auths").lastModified()
        cache?.let { if (stamp == cacheDirStamp) return JSONArray(it) }
        val built = loadFromDisk()
        cache = built.toString()
        cacheDirStamp = stamp
        return built
    }

    /**
     * 合并规则：
     *  - token / refreshToken / nickname / realm 以 auths/ 文件为准（官方客户端与 updateTokens 都写这里）
     *  - disabled / token_usage / credits 等「元数据」以 SharedPreferences 为准
     * 修复前：文件条目整条覆盖 prefs 条目，导致 setDisabled() 永远不生效、用量清零。
     */
    private fun loadFromDisk(): JSONArray {
        val prefByUid = LinkedHashMap<String, JSONObject>()
        try {
            val prefArr = JSONArray(prefs.getString(KEY_ACCOUNTS, "[]") ?: "[]")
            for (i in 0 until prefArr.length()) {
                val a = prefArr.optJSONObject(i) ?: continue
                val uid = a.optString("uid")
                if (uid.isNotEmpty() && uid !in prefByUid) prefByUid[uid] = a
            }
        } catch (ignored: Exception) {}

        val result = JSONArray()
        val seenUids = mutableSetOf<String>()

        val authsDir = File(appContext.filesDir, "auths")
        if (authsDir.isDirectory) {
            authsDir.listFiles()?.sortedBy { it.name }?.forEach { file ->
                if (!file.isFile || !file.name.endsWith(".json")) return@forEach
                try {
                    val obj = JSONObject(file.readText())
                    val acct = obj.optJSONObject("account") ?: JSONObject()
                    val auth = obj.optJSONObject("auth") ?: JSONObject()
                    val uid = acct.optString("uid", obj.optString("uid"))
                    val token = auth.optString("accessToken", obj.optString("access_token", obj.optString("accessToken")))
                    if (uid.isEmpty() || token.isEmpty() || !seenUids.add(uid)) return@forEach

                    val base = prefByUid[uid]?.let { JSONObject(it.toString()) } ?: JSONObject().apply {
                        put("in_pool", true)
                        put("disabled", false)
                        put("credits", obj.optInt("credits", 350))
                        put("token_usage", JSONObject().put("request_count", 0).put("total_tokens", 0))
                    }
                    base.put("uid", uid)
                    base.put("nickname", acct.optString("nickname", obj.optString("nickname", base.optString("nickname", "WorkBuddy用户"))))
                    base.put("realm", auth.optString("realm", obj.optString("realm", base.optString("realm", "global"))))
                    base.put("accessToken", token)
                    val fileRefresh = auth.optString("refreshToken", obj.optString("refreshToken", ""))
                    base.put("refreshToken", fileRefresh.ifEmpty { base.optString("refreshToken", "") })
                    result.put(base)
                } catch (ignored: Exception) {}
            }
        }

        for ((uid, a) in prefByUid) {
            if (seenUids.add(uid)) result.put(a)
        }
        return result
    }

    private fun writePrefs(arr: JSONArray) {
        prefs.edit().putString(KEY_ACCOUNTS, arr.toString()).apply()
        invalidate()
    }

    @Synchronized
    fun saveAccount(uid: String, nickname: String, realm: String, accessToken: String, refreshToken: String) {
        val list = getAccounts()
        val next = JSONArray()

        val newAcc = JSONObject().apply {
            put("uid", uid)
            put("nickname", nickname)
            put("realm", realm)
            put("accessToken", accessToken)
            put("refreshToken", refreshToken)
            put("in_pool", true)
            put("disabled", false)
            put("cooling", false)
            put("credits", 350)
            put("token_usage", JSONObject().apply {
                put("request_count", 0)
                put("total_tokens", 0)
            })
        }

        next.put(newAcc)
        for (i in 0 until list.length()) {
            val old = list.getJSONObject(i)
            if (old.optString("uid") != uid) {
                next.put(old)
            }
        }

        writePrefs(next)

        // 同时落盘到 auths/ 目录以确保双向同步
        try {
            val authsDir = File(appContext.filesDir, "auths").apply { mkdirs() }
            val file = File(authsDir, "workbuddy-$uid.json")
            val fullObj = JSONObject().apply {
                put("account", JSONObject().apply {
                    put("uid", uid)
                    put("nickname", nickname)
                })
                put("auth", JSONObject().apply {
                    put("accessToken", accessToken)
                    put("refreshToken", refreshToken)
                    put("realm", realm)
                })
            }
            file.writeText(fullObj.toString(2))
        } catch (ignored: Exception) {}
        invalidate()
    }

    @Synchronized
    fun deleteAccount(uid: String): Boolean {
        val list = getAccounts()
        val next = JSONArray()
        var found = false
        for (i in 0 until list.length()) {
            val a = list.getJSONObject(i)
            if (a.optString("uid") == uid) {
                found = true
            } else {
                next.put(a)
            }
        }
        writePrefs(next)

        try {
            val authsDir = File(appContext.filesDir, "auths")
            val f = File(authsDir, "workbuddy-$uid.json")
            if (f.exists()) f.delete()
        } catch (ignored: Exception) {}
        invalidate()

        return found
    }

    @Synchronized
    fun exportTokensJson(): String {
        return getAccounts().toString(2)
    }

    @Synchronized
    fun importToken(rawInput: String): Pair<Boolean, String> {
        val trimmed = rawInput.trim()
        if (trimmed.isEmpty()) return false to "导入内容不能为空"

        var importedCount = 0

        // 1. 尝试作为 JSON 数组导入
        if (trimmed.startsWith("[")) {
            try {
                val arr = JSONArray(trimmed)
                for (i in 0 until arr.length()) {
                    val obj = arr.getJSONObject(i)
                    val uid = obj.optString("uid").ifEmpty { "user_${UUID.randomUUID().toString().take(8)}" }
                    val nickname = obj.optString("nickname", "导入用户")
                    val realm = obj.optString("realm", "global")
                    val token = obj.optString("accessToken", obj.optString("access_token", obj.optString("token")))
                    val refresh = obj.optString("refreshToken", obj.optString("refresh_token", ""))
                    if (token.isNotEmpty()) {
                        saveAccount(uid, nickname, realm, token, refresh)
                        importedCount++
                    }
                }
                return if (importedCount > 0) true to "成功导入 $importedCount 个账号" else false to "未在数组中解析到有效 Token"
            } catch (e: Exception) {}
        }

        // 2. 尝试作为单个 JSON 对象导入（CookieBox / auth 对象）
        if (trimmed.startsWith("{")) {
            try {
                val obj = JSONObject(trimmed)
                val acct = obj.optJSONObject("account") ?: obj
                val auth = obj.optJSONObject("auth") ?: obj
                val uid = acct.optString("uid", obj.optString("uid")).ifEmpty { "user_${UUID.randomUUID().toString().take(8)}" }
                val nickname = acct.optString("nickname", obj.optString("nickname", "导入用户"))
                val realm = auth.optString("realm", obj.optString("realm", "global"))
                val token = auth.optString("accessToken", obj.optString("access_token", obj.optString("token")))
                val refresh = auth.optString("refreshToken", obj.optString("refresh_token", ""))
                if (token.isNotEmpty()) {
                    saveAccount(uid, nickname, realm, token, refresh)
                    return true to "成功导入账号：$nickname"
                }
            } catch (e: Exception) {}
        }

        // 3. 尝试作为单行或多行裸 JWT 导入 (以 eyJ 开头)
        val lines = trimmed.split('\n').map { it.trim() }.filter { it.isNotEmpty() }
        for (line in lines) {
            val token = if (line.startsWith("Bearer ", ignoreCase = true)) line.substring(7).trim() else line
            if (token.startsWith("eyJ") && token.count { it == '.' } >= 2) {
                try {
                    val parts = token.split('.')
                    val payloadBytes = android.util.Base64.decode(parts[1], android.util.Base64.URL_SAFE or android.util.Base64.NO_PADDING)
                    val payloadObj = JSONObject(String(payloadBytes, Charsets.UTF_8))
                    val uid = payloadObj.optString("sub", "user_${UUID.randomUUID().toString().take(8)}")
                    val nickname = payloadObj.optString("preferred_username", payloadObj.optString("name", payloadObj.optString("email", "WorkBuddy用户")))
                    saveAccount(uid, nickname, "global", token, "")
                    importedCount++
                } catch (e: Exception) {
                    val uid = "user_${UUID.randomUUID().toString().take(8)}"
                    saveAccount(uid, "导入Token", "global", token, "")
                    importedCount++
                }
            }
        }

        if (importedCount > 0) {
            return true to "成功导入 $importedCount 个凭据"
        }

        return false to "未能识别有效凭据格式，请确保为 JWT 字符串 (eyJ...) 或导出 JSON 数组"
    }

    @Synchronized
    fun getActiveAccount(realm: String): JSONObject? {
        val list = getAccounts()
        for (i in 0 until list.length()) {
            val a = list.getJSONObject(i)
            if (a.optString("realm") == realm && !a.optBoolean("disabled", false)) {
                return a
            }
        }
        // 兼容 realm 缺失的老数据；绝不回退到其它 realm 或已禁用账号
        for (i in 0 until list.length()) {
            val a = list.getJSONObject(i)
            if (a.optString("realm").isEmpty() && !a.optBoolean("disabled", false)) return a
        }
        return null
    }

    /** 就地修改某个账号的字段（不动 token），用于记 last_used / 冷却等 */
    @Synchronized
    fun updateAccount(uid: String, block: (JSONObject) -> Unit) {
        val list = getAccounts()
        val next = JSONArray()
        for (i in 0 until list.length()) {
            val a = list.getJSONObject(i)
            if (a.optString("uid") == uid) block(a)
            next.put(a)
        }
        writePrefs(next)
    }

    /** 更新账号的 accessToken / refreshToken（token 保活成功后调用） */
    @Synchronized
    fun updateTokens(uid: String, accessToken: String, refreshToken: String? = null) {
        val list = getAccounts()
        var nickname = ""
        var realm = "global"
        var keptRefresh = ""
        val next = JSONArray()
        for (i in 0 until list.length()) {
            val a = list.getJSONObject(i)
            if (a.optString("uid") == uid) {
                a.put("accessToken", accessToken)
                if (!refreshToken.isNullOrEmpty()) a.put("refreshToken", refreshToken)
                nickname = a.optString("nickname")
                realm = a.optString("realm", "global")
                keptRefresh = a.optString("refreshToken")
            }
            next.put(a)
        }
        writePrefs(next)

        // 同步落盘到 auths/
        try {
            val authsDir = File(appContext.filesDir, "auths").apply { mkdirs() }
            val file = File(authsDir, "workbuddy-$uid.json")
            val fullObj = JSONObject().apply {
                put("account", JSONObject().apply {
                    put("uid", uid)
                    put("nickname", nickname)
                })
                put("auth", JSONObject().apply {
                    put("accessToken", accessToken)
                    // 上游没轮换 refreshToken 时必须写回旧值：文件优先级高于 prefs，
                    // 漏写会导致下次 getAccounts() 读到空 refreshToken，账号从此无法续期
                    put("refreshToken", if (!refreshToken.isNullOrEmpty()) refreshToken else keptRefresh)
                    put("realm", realm)
                })
            }
            file.writeText(fullObj.toString(2))
        } catch (ignored: Exception) {}
        invalidate()
    }

    @Synchronized
    fun setDisabled(uid: String, disabled: Boolean) {
        updateAccount(uid) { it.put("disabled", disabled) }
    }
}
