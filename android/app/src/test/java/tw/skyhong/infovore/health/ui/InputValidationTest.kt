package tw.skyhong.infovore.health.ui

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import tw.skyhong.infovore.health.EndpointPolicy

class InputValidationTest {
    private val token32 = "a".repeat(32)

    @Test
    fun endpointAcceptsHttpsAndNormalises() {
        assertEquals(FieldResult.Valid("https://infovore.example.tw"), InputValidation.endpoint("  https://infovore.example.tw/ "))
        assertEquals(FieldResult.Valid("https://h.example:8443/base"), InputValidation.endpoint("HTTPS://h.example:8443/base//"))
    }

    @Test
    fun endpointKeepsTheExistingHttpExceptionOnly() {
        val privateHttp = "http://${EndpointPolicy.TAILSCALE_HTTP_HOST}:3001"
        assertEquals(FieldResult.Valid(privateHttp), InputValidation.endpoint(privateHttp))
        val other = InputValidation.endpoint("http://example.com")
        assertTrue(other.errorOrNull!!.contains("HTTPS"))
    }

    @Test
    fun endpointRejectsMalformedValuesWithSpecificMessages() {
        assertTrue(InputValidation.endpoint("").errorOrNull!!.startsWith("請輸入"))
        assertEquals("網址需以 https:// 開頭", InputValidation.endpoint("infovore.example.tw").errorOrNull)
        assertEquals("網址需以 https:// 開頭", InputValidation.endpoint("ftp://example.com").errorOrNull)
        assertEquals("網址不可包含空白", InputValidation.endpoint("https://exa mple.com").errorOrNull)
        assertEquals("網址缺少主機名稱", InputValidation.endpoint("https://:8443").errorOrNull)
        assertNotNull(InputValidation.endpoint("https://example.com?x=1").errorOrNull)
        assertNotNull(InputValidation.endpoint("https://user:pw@example.com").errorOrNull)
    }

    @Test
    fun tokenRequiresLengthAndNoInnerWhitespace() {
        assertEquals(FieldResult.Valid(token32), InputValidation.token("  $token32\n", "T", required = true))
        assertEquals("請輸入 T", InputValidation.token(" ", "T", required = true).errorOrNull)
        assertEquals("目前 5 字元，至少需要 32 字元", InputValidation.token("short", "T", required = true).errorOrNull)
        assertNotNull(InputValidation.token("a".repeat(20) + " " + "b".repeat(20), "T", required = true).errorOrNull)
    }

    @Test
    fun optionalTokenMayBeBlankButNotTooShort() {
        val blank = InputValidation.token("", "T", required = false)
        assertTrue(blank.isValid)
        assertEquals("", blank.valueOrNull())
        assertNotNull(InputValidation.token("short", "T", required = false).errorOrNull)
    }

    @Test
    fun historyDaysNeverClampsSilently() {
        assertEquals(FieldResult.Valid(7), InputValidation.historyDays(" 7 "))
        assertEquals("天數至少為 1", InputValidation.historyDays("0").errorOrNull)
        assertTrue(InputValidation.historyDays("3651").errorOrNull!!.startsWith("天數最多 3650"))
        assertEquals("天數最多 3650", InputValidation.historyDays("99999999999").errorOrNull)
        assertEquals("請只輸入數字", InputValidation.historyDays("7d").errorOrNull)
        assertEquals("天數至少為 1", InputValidation.historyDays("-3").errorOrNull)
        assertTrue(InputValidation.historyDays("").errorOrNull!!.startsWith("請輸入"))
    }

    @Test
    fun historyDaysAboveThirtyExplainsThePermissionCap() {
        val result = InputValidation.historyDays("90") as FieldResult.Valid
        assertEquals(90, result.value)
        assertTrue(result.note!!.contains("30 天"))
        assertNull((InputValidation.historyDays("30") as FieldResult.Valid).note)
    }

    @Test
    fun exclusionsReportInvalidEntriesInsteadOfDroppingThem() {
        val ok = InputValidation.exclusions("com.bank.app, tw.example.pay\n") as FieldResult.Valid
        assertEquals("com.bank.app, tw.example.pay", ok.value)
        assertEquals("將排除 2 個自訂套件", ok.note)
        assertNull((InputValidation.exclusions("  ") as FieldResult.Valid).note)

        val bad = InputValidation.exclusions("com.bank.app, banking, 1bad.pkg")
        assertTrue(bad.errorOrNull!!.contains("banking、1bad.pkg"))
    }
}
