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

    /** 只存在 prefs 里的运行时元数据字段（auths/ 文件不保存这些） */
    private val META_KEYS = listOf("disabled", "last_used", "token_usage", "credits", "nickname_override")

    private lateinit var prefs: SharedPreferences
    private lateinit var appContext: Context

    fun init(context: Context) {
        appContext = context
        prefs = context.getSharedPreferences(PREF_NAME, Context.MODE_PRIVATE)
    }

    @Synchronized
    fun getAccounts(): JSONArray {
        val result = JSONArray()
        val seenUids = mutableSetOf<String>()

        // 1. 优先扫描本地 auths/ 目录下的官方与网关落盘凭证文件
        val authsDir = File(appContext.filesDir, "auths")
        if (authsDir.exists() && authsDir.isDirectory) {
            authsDir.listFiles()?.forEach { file ->
                if (file.isFile && file.name.endsWith(".json") && !file.name.endsWith(".disabled")) {
                    try {
                        val content = file.readText()
                        val obj = JSONObject(content)
                        val acct = obj.optJSONObject("account") ?: JSONObject()
                        val auth = obj.optJSONObject("auth") ?: JSONObject()
                        val uid = acct.optString("uid", obj.optString("uid"))
                        val token = auth.optString("accessToken", obj.optString("access_token", obj.optString("accessToken")))

                        if (uid.isNotEmpty() && token.isNotEmpty() && !seenUids.contains(uid)) {
                            seenUids.add(uid)
                            val nickname = acct.optString("nickname", obj.optString("nickname", "WorkBuddy用户"))
                            val realm = auth.optString("realm", obj.optString("realm", "global"))

                            result.put(JSONObject().apply {
                                put("uid", uid)
                                put("nickname", nickname)
                                put("realm", realm)
                                put("accessToken", token)
                                put("refreshToken", auth.optString("refreshToken", obj.optString("refreshToken", "")))
                                put("in_pool", true)
                                put("disabled", false)
                                put("cooling", false)
                                put("credits", obj.optInt("credits", 350))
                                put("token_usage", JSONObject().apply {
                                    put("request_count", 0)
                                    put("total_tokens", 0)
                                })
                            })
                        }
                    } catch (ignored: Exception) {}
                }
            }
        }

        // 2. 补充扫描 SharedPreferences 中的记录
        //    auths/ 文件只负责 token；disabled / last_used / token_usage / credits 等
        //    运行时元数据只存在 prefs 里。旧实现遇到同 uid 直接跳过 prefs，导致
        //    setDisabled()/touch() 对所有通过 saveAccount 落盘的账号完全无效。
        val byUid = HashMap<String, JSONObject>()
        for (i in 0 until result.length()) {
            val a = result.getJSONObject(i)
            byUid[a.optString("uid")] = a
        }
        val raw = prefs.getString(KEY_ACCOUNTS, "[]") ?: "[]"
        try {
            val prefArr = JSONArray(raw)
            for (i in 0 until prefArr.length()) {
                val a = prefArr.getJSONObject(i)
                val uid = a.optString("uid")
                if (uid.isEmpty()) continue
                val fileAcc = byUid[uid]
                if (fileAcc != null) {
                    for (k in META_KEYS) if (a.has(k)) fileAcc.put(k, a.get(k))
                    // 文件里没有 refreshToken（被旧版 updateTokens 写丢）时，从 prefs 补回
                    if (fileAcc.optString("refreshToken").isEmpty() && a.optString("refreshToken").isNotEmpty()) {
                        fileAcc.put("refreshToken", a.optString("refreshToken"))
                    }
                } else if (seenUids.add(uid)) {
                    result.put(a)
                }
            }
        } catch (ignored: Exception) {}

        return result
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

        prefs.edit().putString(KEY_ACCOUNTS, next.toString()).apply()

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
            writeAtomic(file, fullObj.toString(2))
        } catch (ignored: Exception) {}
    }

    /** 先写临时文件再 rename，避免进程被杀时留下半截 JSON（getAccounts 会静默丢掉该账号） */
    private fun writeAtomic(file: File, text: String) {
        val tmp = File(file.parentFile, file.name + ".tmp")
        tmp.writeText(text)
        if (!tmp.renameTo(file)) {
            file.delete()
            if (!tmp.renameTo(file)) throw java.io.IOException("rename failed: ${file.name}")
        }
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
        prefs.edit().putString(KEY_ACCOUNTS, next.toString()).apply()

        try {
            val authsDir = File(appContext.filesDir, "auths")
            val f = File(authsDir, "workbuddy-$uid.json")
            if (f.exists()) f.delete()
        } catch (ignored: Exception) {}

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
        // 旧实现在这里无条件返回 list[0]，会把已禁用账号拿去发请求
        for (i in 0 until list.length()) {
            val a = list.getJSONObject(i)
            if (!a.optBoolean("disabled", false)) return a
        }
        return null
    }

    @Synchronized
    fun getAccountByUid(uid: String): JSONObject? {
        val list = getAccounts()
        for (i in 0 until list.length()) {
            val a = list.getJSONObject(i)
            if (a.optString("uid") == uid) return a
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
        prefs.edit().putString(KEY_ACCOUNTS, next.toString()).apply()
    }

    /** 更新账号的 accessToken / refreshToken（token 保活成功后调用） */
    @Synchronized
    fun updateTokens(uid: String, accessToken: String, refreshToken: String? = null) {
        val list = getAccounts()
        var nickname = ""
        var realm = "global"
        var keptRefresh = refreshToken.orEmpty()
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
        prefs.edit().putString(KEY_ACCOUNTS, next.toString()).apply()

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
                    // 上游未下发新 refreshToken 时必须保留旧值，否则下次 getAccounts()
                    // 读到空 refreshToken，该账号从此再也刷新不了
                    put("refreshToken", keptRefresh)
                    put("realm", realm)
                })
            }
            writeAtomic(file, fullObj.toString(2))
        } catch (ignored: Exception) {}
    }

    @Synchronized
    fun setDisabled(uid: String, disabled: Boolean) {
        updateAccount(uid) { it.put("disabled", disabled) }
    }
}
