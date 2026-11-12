package tw.skyhong.infovore.health

import java.io.IOException
import java.time.Instant
import java.time.ZonedDateTime
import java.time.format.DateTimeFormatter
import java.time.format.DateTimeParseException
import kotlin.math.ceil

/** The HTTP `Retry-After` header: how long the server asks the client to wait before trying again. */
object RetryAfter {
    private val DELTA_SECONDS = Regex("\\d{1,10}")

    /**
     * [value] as milliseconds from [now]: delta-seconds (`120`) or an HTTP-date
     * (`Wed, 21 Oct 2026 07:28:00 GMT`; a date already past is 0). Null when absent or invalid
     * (negative numbers, fractions, other date formats), in which case the caller uses its own backoff.
     */
    fun parseMs(value: String?, now: Instant): Long? {
        val text = value?.trim().orEmpty()
        if (text.isEmpty()) return null
        if (DELTA_SECONDS.matches(text)) return text.toLong() * 1_000L
        return try {
            val at = ZonedDateTime.parse(text, DateTimeFormatter.RFC_1123_DATE_TIME).toInstant()
            (at.toEpochMilli() - now.toEpochMilli()).coerceAtLeast(0L)
        } catch (_: DateTimeParseException) {
            null
        }
    }

    /** "15 秒", "15 分鐘", "3 小時": a wait as shown to the user, rounded up. */
    fun describe(ms: Long): String = when {
        ms < 60_000L -> "${ceil(ms / 1_000.0).toLong().coerceAtLeast(1)} 秒"
        ms < 2 * 3_600_000L -> "${ceil(ms / 60_000.0).toLong()} 分鐘"
        else -> "${ceil(ms / 3_600_000.0).toLong()} 小時"
    }
}

/**
 * How background work (SyncWorker, ScreenUploadWorker) reacts to a failed run. Android-free so
 * it can be unit tested.
 *
 * - [Kind.NEEDS_ACTION]: retrying cannot help until the user (or the server's owner) changes
 *   something: HTTP 400/401/403/404/409/413, a 503 the server marks `"retryable": false` (feature
 *   not configured), an endpoint the policy refuses, missing settings or Health Connect
 *   permissions. The run ends with `Result.failure()`; the reason stays in the status.
 * - [Kind.TRANSIENT]: network failures and HTTP 408/429/5xx. [InfovoreApi] already retried within
 *   the run, waiting out a short `Retry-After`; the worker then either lets WorkManager's backoff
 *   retry ([Plan.Backoff], when that backoff is at least the server's hint) or schedules the next
 *   attempt for when the server asked ([Plan.Later]).
 *
 * For periodic work, `Result.failure()` and `Result.success()` both end this run and keep the
 * schedule; failure() is used for runs that did not complete, so WorkManager's own records match
 * the status the app shows.
 */
object BackgroundRetry {
    enum class Kind { NEEDS_ACTION, TRANSIENT }

    sealed interface Plan {
        /** Stop until the next period; the user must fix something first. */
        data object NeedsAction : Plan

        /** `Result.retry()`: WorkManager's next backoff already waits at least as long as the server asked. */
        data object Backoff : Plan

        /** Run again after [delayMs] (the server's `Retry-After`, capped at [MAX_WAIT_MS]). */
        data class Later(val delayMs: Long) : Plan

        /** Attempts used up (or no later run can be scheduled from here): wait for the next period. */
        data object GiveUp : Plan
    }

    /** WorkManager's exponential backoff base, set explicitly on every background request. */
    const val BACKOFF_MS = 30_000L

    /** WorkManager caps any backoff at five hours. */
    private const val MAX_BACKOFF_MS = 5 * 3_600_000L

    /** The longest server-requested wait honoured; the periodic schedule takes over after that. */
    const val MAX_WAIT_MS = SyncFailureAlerts.PERIOD_HOURS * 3_600_000L

    /** The delay WorkManager applies before re-running work that returned retry() at [runAttemptCount]. */
    fun backoffMs(runAttemptCount: Int): Long =
        (BACKOFF_MS shl runAttemptCount.coerceIn(0, 20)).coerceAtMost(MAX_BACKOFF_MS)

    fun classify(error: Throwable): Kind = when (error) {
        is InfovoreApi.HttpStatusException -> Kind.NEEDS_ACTION
        is IOException -> Kind.TRANSIENT
        // require() failures: settings, endpoint policy, Health Connect permissions.
        is IllegalArgumentException, is SecurityException -> Kind.NEEDS_ACTION
        // Anything unexpected keeps the bounded retry it always had.
        else -> Kind.TRANSIENT
    }

    /** The server's `Retry-After` carried by [error] (or its causes), if any. */
    fun retryAfterMs(error: Throwable): Long? =
        generateSequence(error) { it.cause }.filterIsInstance<InfovoreApi.RetryableHttpException>().firstOrNull()?.retryAfterMs

    /**
     * [attempt]: failed attempts of this period so far (0-based, counting the follow-up's
     * predecessors). [runAttemptCount]: WorkManager's count for this very request, which sets its
     * backoff. [canScheduleLater]: whether this run may schedule another one at the server's time.
     */
    fun plan(kind: Kind, retryAfterMs: Long?, attempt: Int, runAttemptCount: Int, canScheduleLater: Boolean): Plan = when {
        kind == Kind.NEEDS_ACTION -> Plan.NeedsAction
        SyncFailureAlerts.isFinalAttempt(attempt) -> Plan.GiveUp
        retryAfterMs == null || retryAfterMs <= backoffMs(runAttemptCount) -> Plan.Backoff
        canScheduleLater -> Plan.Later(retryAfterMs.coerceAtMost(MAX_WAIT_MS))
        else -> Plan.GiveUp
    }

    /** Whether the run counts towards the "同步問題" warning: only one that gives up for this period. */
    fun countsAsFinal(plan: Plan): Boolean = plan == Plan.NeedsAction || plan == Plan.GiveUp

    /** The background sync's status line (after the time) for a failed run; [reason] is ErrorText's. */
    fun syncStatus(plan: Plan, reason: String): String = when (plan) {
        Plan.NeedsAction -> "背景同步失敗，需要處理：$reason 背景同步不會重試這個錯誤，下次排程（約 ${SyncFailureAlerts.PERIOD_HOURS} 小時後）才會再試；修正後可按「立即同步」。"
        Plan.Backoff -> "背景同步失敗：$reason 稍後自動重試。"
        is Plan.Later -> "背景同步延後：$reason 約 ${RetryAfter.describe(plan.delayMs)}後自動重試。"
        Plan.GiveUp -> "背景同步失敗：$reason"
    }
}
