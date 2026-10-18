package android.content
import java.io.File
interface SharedPreferences {
    fun getString(k: String, d: String?): String?
    fun getInt(k: String, d: Int): Int
    fun getBoolean(k: String, d: Boolean): Boolean
    fun edit(): Editor
    interface Editor { fun putBoolean(k: String, v: Boolean): Editor; fun putString(k: String, v: String?): Editor; fun putInt(k: String, v: Int): Editor; fun apply(); fun commit(): Boolean }
}
open class Context(val dir: File) {
    companion object { const val MODE_PRIVATE = 0 }
    open val filesDir: File get() = dir
    open val applicationContext: Context get() = this
    val assets = android.content.res.AssetManager()
    private val prefsMap = HashMap<String, MemPrefs>()
    fun getSharedPreferences(n: String, m: Int): SharedPreferences = synchronized(prefsMap) { prefsMap.getOrPut(n) { MemPrefs() } }
}
class MemPrefs : SharedPreferences {
    val m = java.util.concurrent.ConcurrentHashMap<String, Any>()
    override fun getString(k: String, d: String?) = (m[k] as String?) ?: d
    override fun getInt(k: String, d: Int) = (m[k] as Int?) ?: d
    override fun getBoolean(k: String, d: Boolean) = (m[k] as Boolean?) ?: d
    override fun edit() = object : SharedPreferences.Editor {
        val p = HashMap<String, Any?>()
        override fun putString(k: String, v: String?) = apply { p[k] = v }
        override fun putInt(k: String, v: Int) = apply { p[k] = v }
        override fun putBoolean(k: String, v: Boolean) = apply { p[k] = v }
        override fun apply() { p.forEach { (k, v) -> if (v == null) m.remove(k) else m[k] = v } }
        override fun commit(): Boolean { apply(); return true }
    }
}

