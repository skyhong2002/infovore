package tw.skyhong.infovore.health

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import tw.skyhong.infovore.health.BackgroundRetry.Kind
import tw.skyhong.infovore.health.BackgroundRetry.Plan
import java.io.IOException
import java.net.SocketTimeoutException
import java.time.Instant

/** [RetryAfter] parsing with an injected clock, and [BackgroundRetry]'s classification and plans. */
class RetryPolicyTest {
    private val now = Instant.parse("2026-11-13T04:00:00Z")

    @Test
    fun retryAfterAcceptsDeltaSecondsAndHttpDates() {
        assertEquals(15_000L, RetryAfter.parseMs("15", now))
        assertEquals(0L, RetryAfter.parseMs("0", now))
        assertEquals(120_000L, RetryAfter.parseMs(" 120 ", now))
        // IMF-fixdate, relative to the injected clock.
        assertEquals(90_000L, RetryAfter.parseMs("Fri, 13 Nov 2026 04:01:30 GMT", now))
        // A date already past means "now".
        assertEquals(0L, RetryAfter.parseMs("Fri, 13 Nov 2026 03:00:00 GMT", now))
    }

    @Test
    fun anInvalidOrMissingRetryAfterIsIgnored() {
        for (value in listOf(null, "", "  ", "-5", "1.5", "soon", "15s", "2026-11-13T04:01:30Z", "Friday, 13-Nov-26 04:01:30 GMT", "99999999999")) {
            assertNull(value, RetryAfter.parseMs(value, now))
        }
    }

    @Test
    fun waitsAreDescribedRoundedUp() {
        assertEquals("1 秒", RetryAfter.describe(0))
        assertEquals("15 秒", RetryAfter.describe(15_000))
        assertEquals("2 分鐘", RetryAfter.describe(61_000))
        assertEquals("15 分鐘", RetryAfter.describe(900_000))
        assertEquals("2 小時", RetryAfter.describe(7_200_000))
        assertEquals("6 小時", RetryAfter.describe(BackgroundRetry.MAX_WAIT_MS))
    }

    @Test
    fun errorsTheUserMustFixAreNotRetried() {
        assertEquals(Kind.NEEDS_ACTION, BackgroundRetry.classify(InfovoreApi.HttpStatusException(401, "Infovore HTTP 401")))
        assertEquals(Kind.NEEDS_ACTION, BackgroundRetry.classify(InfovoreApi.HttpStatusException(503, "not configured")))
        assertEquals(Kind.NEEDS_ACTION, BackgroundRetry.classify(IllegalArgumentException("自訂 endpoint 必須使用 HTTPS")))
        assertEquals(Kind.NEEDS_ACTION, BackgroundRetry.classify(SecurityException("permission")))
        assertEquals(Kind.TRANSIENT, BackgroundRetry.classify(InfovoreApi.RetryableHttpException(503, "busy")))
        assertEquals(Kind.TRANSIENT, BackgroundRetry.classify(SocketTimeoutException()))
        assertEquals(Kind.TRANSIENT, BackgroundRetry.classify(RuntimeException("unexpected")))
    }

    @Test
    fun theServersHintIsFoundAlsoWhenWrapped() {
        val hinted = InfovoreApi.RetryableHttpException(503, "busy", retryAfterMs = 900_000)
        assertEquals(900_000L, BackgroundRetry.retryAfterMs(hinted))
        assertEquals(900_000L, BackgroundRetry.retryAfterMs(IOException("wrapped", hinted)))
        assertNull(BackgroundRetry.retryAfterMs(InfovoreApi.RetryableHttpException(503, "busy")))
        assertNull(BackgroundRetry.retryAfterMs(SocketTimeoutException()))
    }

    @Test
    fun plansFollowTheKindTheHintAndTheAttempt() {
        fun plan(kind: Kind, hint: Long?, attempt: Int = 0, run: Int = attempt, later: Boolean = true) =
            BackgroundRetry.plan(kind, hint, attempt, run, later)

        assertEquals(Plan.NeedsAction, plan(Kind.NEEDS_ACTION, null))
        assertEquals("a hint does not make a fix-it error retryable", Plan.NeedsAction, plan(Kind.NEEDS_ACTION, 5_000))
        assertEquals(Plan.Backoff, plan(Kind.TRANSIENT, null))
        // WorkManager's next backoff (30 s × 2^run) already covers a hint up to that long.
        assertEquals(30_000L, BackgroundRetry.backoffMs(0))
        assertEquals(120_000L, BackgroundRetry.backoffMs(2))
        assertEquals(Plan.Backoff, plan(Kind.TRANSIENT, 15_000))
        assertEquals(Plan.Backoff, plan(Kind.TRANSIENT, 120_000, attempt = 2))
        assertEquals(Plan.Later(120_000), plan(Kind.TRANSIENT, 120_000, attempt = 1))
        assertEquals(Plan.Later(900_000), plan(Kind.TRANSIENT, 900_000))
        // A longer wait than one period is capped: the periodic schedule takes over after it.
        assertEquals(Plan.Later(BackgroundRetry.MAX_WAIT_MS), plan(Kind.TRANSIENT, 86_400_000))
        // Without a way to schedule later (a follow-up run), a long hint ends this period's tries.
        assertEquals(Plan.GiveUp, plan(Kind.TRANSIENT, 900_000, later = false))
        assertEquals(Plan.Backoff, plan(Kind.TRANSIENT, 15_000, later = false))
        // The last attempt of a period gives up whatever the hint.
        val last = SyncFailureAlerts.MAX_RETRIES
        assertEquals(Plan.GiveUp, plan(Kind.TRANSIENT, null, attempt = last))
        assertEquals(Plan.GiveUp, plan(Kind.TRANSIENT, 900_000, attempt = last, run = 0))

        assertTrue(BackgroundRetry.countsAsFinal(Plan.NeedsAction))
        assertTrue(BackgroundRetry.countsAsFinal(Plan.GiveUp))
        assertFalse(BackgroundRetry.countsAsFinal(Plan.Backoff))
        assertFalse(BackgroundRetry.countsAsFinal(Plan.Later(1)))
    }

    @Test
    fun theStatusSaysWhetherTheUserMustActAndWhenTheNextTryIs() {
        assertTrue(BackgroundRetry.syncStatus(Plan.NeedsAction, "伺服器拒絕了 token。").startsWith("背景同步失敗，需要處理：伺服器拒絕了 token。"))
        assertTrue(BackgroundRetry.syncStatus(Plan.NeedsAction, "x").contains("不會重試這個錯誤"))
        assertTrue(BackgroundRetry.syncStatus(Plan.Backoff, "x").contains("稍後自動重試"))
        assertTrue(BackgroundRetry.syncStatus(Plan.Later(900_000), "x").contains("約 15 分鐘後自動重試"))
        assertEquals("背景同步失敗：x", BackgroundRetry.syncStatus(Plan.GiveUp, "x"))
    }
}
