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
    }

    @Synchronized
    fun getAccounts(): JSONArray {
        val result = JSONArray()
        val seenUids = mutableSetOf<String>()

        // 0. 先读 SharedPreferences：它承载 disabled / in_pool / token_usage 等元数据
        val prefByUid = LinkedHashMap<String, JSONObject>()
        try {
            val prefArr = JSONArray(prefs.getString(KEY_ACCOUNTS, "[]") ?: "[]")
            for (i in 0 until prefArr.length()) {
                val a = prefArr.optJSONObject(i) ?: continue
                val uid = a.optString("uid")
                if (uid.isNotEmpty() && !prefByUid.containsKey(uid)) prefByUid[uid] = a
            }
        } catch (ignored: Exception) {}

        // 1. auths/ 目录是 token 的权威来源（官方客户端 / 网关落盘），
        //    但元数据必须叠加 prefs，否则 setDisabled / updateAccount 的写入会被文件版本遮蔽
        val authsDir = File(appContext.filesDir, "auths")
        if (authsDir.exists() && authsDir.isDirectory) {
            authsDir.listFiles()?.sortedBy { it.name }?.forEach { file ->
                if (file.isFile && file.name.endsWith(".json")) {
                    try {
                        val obj = JSONObject(file.readText())
                        val acct = obj.optJSONObject("account") ?: JSONObject()
                        val auth = obj.optJSONObject("auth") ?: JSONObject()
                        val uid = acct.optString("uid", obj.optString("uid"))
                        val token = auth.optString("accessToken", obj.optString("access_token", obj.optString("accessToken")))

                        if (uid.isNotEmpty() && token.isNotEmpty() && !seenUids.contains(uid)) {
                            seenUids.add(uid)
                            val meta = prefByUid[uid]
                            val merged = if (meta != null) JSONObject(meta.toString()) else JSONObject().apply {
                                put("in_pool", true)
                                put("disabled", false)
                                put("credits", obj.optInt("credits", 350))
                                put("token_usage", JSONObject().apply {
                                    put("request_count", 0)
                                    put("total_tokens", 0)
                                })
                            }
                            merged.put("uid", uid)
                            merged.put("nickname", acct.optString("nickname",
                                obj.optString("nickname", merged.optString("nickname", "WorkBuddy用户"))))
                            merged.put("realm", auth.optString("realm", obj.optString("realm", merged.optString("realm", "global"))))
                            merged.put("accessToken", token)
                            val fileRefresh = auth.optString("refreshToken", obj.optString("refreshToken", ""))
                            if (fileRefresh.isNotEmpty() || !merged.has("refreshToken")) merged.put("refreshToken", fileRefresh)
                            result.put(merged)
                        }
                    } catch (ignored: Exception) {}
                }
            }
        }

        // 2. 只存在于 prefs 的账号
        for ((uid, a) in prefByUid) {
            if (!seenUids.contains(uid)) {
                seenUids.add(uid)
                result.put(a)
            }
        }

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
            file.writeText(fullObj.toString(2))
        } catch (ignored: Exception) {}
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
        for (i in 0 until list.length()) {
            val a = list.getJSONObject(i)
            if (!a.optBoolean("disabled", false)) return a
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
                    // 上游没回新 refreshToken 时沿用旧的，否则文件里的 refreshToken 会被抹掉
                    put("refreshToken", keptRefresh)
                    put("realm", realm)
                })
            }
            file.writeText(fullObj.toString(2))
        } catch (ignored: Exception) {}
    }

    @Synchronized
    fun setDisabled(uid: String, disabled: Boolean) {
        updateAccount(uid) { it.put("disabled", disabled) }
    }
}
