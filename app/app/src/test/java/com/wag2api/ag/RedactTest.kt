package com.wag2api.ag

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/** [P3] 日志脱敏 */
class RedactTest {
    @Test
    fun tokensAndKeysAreMasked() {
        val raw = "Authorization: Bearer abc.def-123 at=ya29.a0AfH6SMBxyz rt=1//0gABCDEFGHIJKLmnop " +
            "/v1/messages?key=sk-admin-999&x=1 {\"refresh_token\":\"1//zzz\",\"access_token\":\"ya29.q\"} " +
            "Cookie: SAPISID=s3cr3t; __Secure-1PSID=abcd; theme=dark"
        val r = Redact.redact(raw)
        for (secret in listOf("abc.def-123", "a0AfH6SMBxyz", "0gABCDEFGHIJKLmnop", "sk-admin-999", "s3cr3t", "=abcd")) {
            assertFalse("leaked $secret in $r", r.contains(secret))
        }
        assertTrue(r.contains("x=1"))
        assertTrue(r.contains("theme=dark"))
    }

    @Test
    fun plainTextUnchangedAndPathOnly() {
        val s = "[Policy] user@gmail.com 429，3000ms 后原账号重试"
        assertEquals(s, Redact.redact(s))
        assertEquals("/v1/messages", Redact.pathOnly("/v1/messages?key=abc"))
        assertEquals("", Redact.redact(null))
        assertEquals("GenerateContent HTTP 403 code=7", Redact.redact("GenerateContent HTTP 403 code=7"))
        assertFalse(Redact.redact("cb?code=4/0AbCdEfGhIjKlMn&scope=x").contains("0AbCdEfGhIjKlMn"))
    }
}
