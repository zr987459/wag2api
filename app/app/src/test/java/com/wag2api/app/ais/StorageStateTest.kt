package com.wag2api.app.ais

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test

class StorageStateTest {

    private fun fixture(name: String): String =
        javaClass.getResourceAsStream("/ais/$name")!!.readBytes().toString(Charsets.UTF_8)

    @Test
    fun parsesPlaywrightStorageState() {
        val st = StorageState.parse(fixture("storage-state.json"))
        // 非 google.com 的 Cookie 被丢弃
        assertTrue(st.cookies.none { it.domain.contains("example.com") })
        assertEquals(6, st.cookies.size)
        assertEquals("sapisid-value", st.cookieValue("SAPISID"))
        assertEquals("psid-value", st.cookieValue("__Secure-1PSID"))
        // host-only 的 aistudio Cookie 对 aistudio 可见，对 www.google.com 不可见
        assertEquals("host-only", st.cookieValue("AISTUDIO_HOST", "https://aistudio.google.com/"))
        assertNull(st.cookieValue("AISTUDIO_HOST", "https://www.google.com/"))
        st.requireLogin(nowSec = 1_700_000_000)
        assertEquals(1, st.origins.size)
        assertEquals("https://aistudio.google.com", st.origins[0].origin)
        assertEquals("v1" to "x", st.origins[0].localStorage[0])
        // HttpOnly / SameSite 保留，写 CookieManager 的格式正确
        val psid = st.cookies.first { it.name == "__Secure-1PSID" }
        assertTrue(psid.httpOnly)
        val header = psid.setCookieHeader()
        assertTrue(header, header.startsWith("__Secure-1PSID=psid-value; Domain=.google.com; Path=/"))
        assertTrue(header.contains("; Secure") && header.contains("; HttpOnly") && header.contains("SameSite=None"))
        assertTrue(header.contains("Expires="))
        assertEquals("https://google.com/", psid.url())
        // host-only 不带 Domain
        assertFalse(st.cookies.first { it.name == "AISTUDIO_HOST" }.setCookieHeader().contains("Domain="))
    }

    @Test
    fun roundTripsThroughJson() {
        val st = StorageState.parse(fixture("storage-state.json"))
        val again = StorageState.fromJson(JSONObject(st.toJson().toString()))
        assertEquals(st.cookies, again.cookies)
        assertEquals(st.origins, again.origins)
        assertEquals(st.fingerprint(), again.fingerprint())
    }

    @Test
    fun parsesCookieHeader() {
        val st = StorageState.parse("SID=a; __Secure-1PSID=b; SAPISID=c; __Secure-1PAPISID=d; __Secure-3PAPISID=e")
        assertEquals(5, st.cookies.size)
        assertTrue(st.cookies.all { it.domain == ".google.com" && it.secure })
        assertEquals("c", st.cookieValue("SAPISID"))
        st.requireLogin()
    }

    @Test
    fun parsesCookieEditorArrayAndNetscape() {
        val arr = """[{"domain":".google.com","expirationDate":4102444800,"hostOnly":false,"httpOnly":true,"name":"__Secure-1PSID","path":"/","sameSite":"no_restriction","secure":true,"value":"p"},
            {"domain":"aistudio.google.com","hostOnly":true,"name":"H","path":"/","sameSite":"lax","secure":true,"session":true,"value":"h"}]"""
        val a = StorageState.parse(arr)
        assertEquals("None", a.cookies[0].sameSite)
        assertEquals(4102444800.0, a.cookies[0].expires, 0.0)
        assertEquals("aistudio.google.com", a.cookies[1].domain)
        assertEquals(-1.0, a.cookies[1].expires, 0.0)

        val net = "# Netscape HTTP Cookie File\n#HttpOnly_.google.com\tTRUE\t/\tTRUE\t4102444800\t__Secure-1PSID\tp\n.google.com\tTRUE\t/\tTRUE\t0\tSAPISID\ts\n.example.com\tTRUE\t/\tFALSE\t0\tX\ty\n"
        val n = StorageState.parse(net)
        assertEquals(2, n.cookies.size)
        assertTrue(n.cookies[0].httpOnly)
        assertEquals("s", n.cookieValue("SAPISID"))
    }

    @Test
    fun rejectsMissingLoginCookies() {
        val st = StorageState.parse("SID=a; HSID=b")
        try {
            st.requireLogin()
            fail("应当抛出")
        } catch (e: IllegalArgumentException) {
            assertTrue(e.message!!.contains("__Secure-1PSID"))
        }
    }

    @Test
    fun expiredCookieIsInvisible() {
        val st = StorageState.parse("""[{"domain":".google.com","name":"SAPISID","value":"old","path":"/","expires":100}]""")
        assertNull(st.cookieValue("SAPISID", nowSec = 200))
    }

    @Test
    fun sapisidAuthorizationMatchesKnownVector() {
        val auth = Sapisid.authorization(
            mapOf("SAPISID" to "sapi", "__Secure-1PAPISID" to "one", "__Secure-3PAPISID" to "three"), nowSec = 1_700_000_000,
        )
        assertEquals(
            "SAPISIDHASH 1700000000_d4364cc234b1aaf45aa9f0809722ebe552f2f163 " +
                "SAPISID1PHASH 1700000000_77b204046c1f25b79c02cb5bbe49a6c1be800b1b " +
                "SAPISID3PHASH 1700000000_32bdbb118145d08417e16ed24f7806baecc3544b",
            auth,
        )
        assertEquals(mapOf("a" to "1", "b" to "x=y"), Sapisid.parseCookieHeader("a=1; b=x=y; a=2"))
    }
}
