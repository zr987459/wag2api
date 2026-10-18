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

    /**
     * 读缓存：getAccounts() 在每次请求的 pick / touch / 401 刷新路径上都会被调用，
     * 原实现每次都 listFiles + readText 全部 auths/*.json 并重解析，且全程持有对象锁。
     * 这里按「auths 目录指纹（文件名+mtime+size）+ prefs 写版本号」缓存合并结果，
     * 指纹不变就直接返回副本，外部（Node/网关）改了文件也能被指纹感知。
     */
    private var cacheKey: String? = null
    private var cacheJson: String? = null
    private var prefsVersion = 0L

    private fun authsFingerprint(dir: File): String {
        val files = dir.listFiles() ?: return "none"
        val sb = StringBuilder()
        files.sortedBy { it.name }.forEach { f ->
            sb.append(f.name).append(':').append(f.lastModified()).append(':').append(f.length()).append('|')
        }
        return sb.toString()
    }

    /** 每次写 prefs 都要调用，使缓存失效 */
    private fun writePrefs(arr: JSONArray) {
        prefs.edit().putString(KEY_ACCOUNTS, arr.toString()).apply()
        prefsVersion++
        cacheKey = null
    }

    /**
     * 返回合并后的账号列表（每次都是新副本，调用方可随意修改）。
     *
     * 合并规则（修复：原实现 auths/ 条目整条覆盖 prefs 条目，导致
     * disabled / last_used / token_usage 写进 prefs 后永远读不回来，
     * 「禁用账号」对有落盘文件的账号完全无效）：
     *  - token（accessToken / refreshToken / realm）以 auths/ 文件为准
     *  - 元数据（disabled / last_used / token_usage / credits）以 prefs 为准
     */
    @Synchronized
    fun getAccounts(): JSONArray {
        val authsDir = File(appContext.filesDir, "auths")
        val key = (if (authsDir.isDirectory) authsFingerprint(authsDir) else "none") + "#" + prefsVersion
        val cached = cacheJson
        if (key == cacheKey && cached != null) return JSONArray(cached)

        // 1. prefs 记录，按 uid 建索引
        val prefMap = LinkedHashMap<String, JSONObject>()
        try {
            val prefArr = JSONArray(prefs.getString(KEY_ACCOUNTS, "[]") ?: "[]")
            for (i in 0 until prefArr.length()) {
                val a = prefArr.optJSONObject(i) ?: continue
                val uid = a.optString("uid")
                if (uid.isNotEmpty() && !prefMap.containsKey(uid)) prefMap[uid] = a
            }
        } catch (ignored: Exception) {}

        val result = JSONArray()
        val seenUids = mutableSetOf<String>()

        // 2. auths/ 目录下的官方与网关落盘凭证文件
        if (authsDir.isDirectory) {
            authsDir.listFiles()?.sortedBy { it.name }?.forEach { file ->
                if (file.isFile && file.name.endsWith(".json")) {
                    try {
                        val obj = JSONObject(file.readText())
                        val acct = obj.optJSONObject("account") ?: JSONObject()
                        val auth = obj.optJSONObject("auth") ?: JSONObject()
                        val uid = acct.optString("uid", obj.optString("uid"))
                        val token = auth.optString("accessToken", obj.optString("access_token", obj.optString("accessToken")))

                        if (uid.isNotEmpty() && token.isNotEmpty() && seenUids.add(uid)) {
                            val meta = prefMap[uid]
                            result.put(JSONObject().apply {
                                put("uid", uid)
                                put("nickname", acct.optString("nickname", obj.optString("nickname", meta?.optString("nickname") ?: "WorkBuddy用户")))
                                put("realm", auth.optString("realm", obj.optString("realm", meta?.optString("realm") ?: "global")))
                                put("accessToken", token)
                                put("refreshToken", auth.optString("refreshToken", obj.optString("refreshToken", meta?.optString("refreshToken") ?: "")))
                                put("in_pool", true)
                                put("disabled", meta?.optBoolean("disabled", false) ?: false)
                                put("cooling", false)
                                put("credits", meta?.optInt("credits", obj.optInt("credits", 350)) ?: obj.optInt("credits", 350))
                                put("last_used", meta?.optLong("last_used", 0L) ?: 0L)
                                put("token_usage", meta?.optJSONObject("token_usage") ?: JSONObject().apply {
                                    put("request_count", 0)
                                    put("total_tokens", 0)
                                })
                            })
                        }
                    } catch (ignored: Exception) {}
                }
            }
        }

        // 3. 只存在于 prefs 的记录
        for ((uid, a) in prefMap) {
            if (seenUids.add(uid)) result.put(a)
        }

        val json = result.toString()
        cacheJson = json
        cacheKey = key
        return JSONArray(json)
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
        cacheKey = null
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
        cacheKey = null

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
        if (list.length() > 0) return list.getJSONObject(0)
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

    /**
     * 更新账号的 accessToken / refreshToken（token 保活成功后调用）。
     * 修复：
     *  - uid 不存在时直接返回 false，避免给「刷新途中被删除」的账号重新落盘复活
     *  - 上游没返回新 refreshToken 时沿用旧值写文件（原实现会把文件里的 refreshToken 抹掉，
     *    下一次 getAccounts 以文件为准 → refreshToken 变空 → 再也刷新不了）
     */
    @Synchronized
    fun updateTokens(uid: String, accessToken: String, refreshToken: String? = null): Boolean {
        val list = getAccounts()
        var found = false
        var nickname = ""
        var realm = "global"
        var effectiveRefresh = ""
        val next = JSONArray()
        for (i in 0 until list.length()) {
            val a = list.getJSONObject(i)
            if (a.optString("uid") == uid) {
                found = true
                a.put("accessToken", accessToken)
                if (!refreshToken.isNullOrEmpty()) a.put("refreshToken", refreshToken)
                effectiveRefresh = a.optString("refreshToken")
                nickname = a.optString("nickname")
                realm = a.optString("realm", "global")
            }
            next.put(a)
        }
        if (!found) return false
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
                    put("refreshToken", effectiveRefresh)
                    put("realm", realm)
                })
            }
            file.writeText(fullObj.toString(2))
        } catch (ignored: Exception) {}
        cacheKey = null
        return true
    }

    @Synchronized
    fun setDisabled(uid: String, disabled: Boolean) {
        updateAccount(uid) { it.put("disabled", disabled) }
    }
}
