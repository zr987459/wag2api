package android.util
object Log {
    var quiet = true
    @JvmStatic fun w(t: String, m: String): Int { if (!quiet) println("W/$t $m"); return 0 }
    @JvmStatic fun i(t: String, m: String): Int { if (!quiet) println("I/$t $m"); return 0 }
    @JvmStatic fun e(t: String, m: String, e: Throwable? = null): Int = 0
    @JvmStatic fun d(t: String, m: String): Int = 0
}
object Base64 { const val URL_SAFE = 8; const val NO_PADDING = 1
    @JvmStatic fun decode(s: String, f: Int): ByteArray = java.util.Base64.getUrlDecoder().decode(s) }
