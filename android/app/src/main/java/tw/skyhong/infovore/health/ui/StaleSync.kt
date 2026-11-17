package tw.skyhong.infovore.health.ui

import java.time.Duration
import java.time.Instant

/** The warning shown at the top of the health section when the last successful full sync is too old. */
data class StaleSyncUi(
    /** The box's first line: the failure's cause, or what probably happened. */
    val headline: String,
    /** What to check. */
    val detail: String,
    /** The section header's short version. */
    val summary: String,
    /** "開啟失敗通知" when notifications are not on (opt-in and permission); null when they are. */
    val notifyLabel: String?,
) {
    val text: String get() = "$headline\n$detail"
}

/**
 * When the app is opened more than [THRESHOLD_HOURS] after the last successful full sync, the
 * background sync has most likely not been running at all (the system restricted or stopped the
 * app), which no notification can report: the app is the only place to say so. Android-free so
 * it can be unit tested. Offers "sync now" and, if they are off, "turn on notifications" (only on
 * the user's tap; never turned on automatically).
 */
object StaleSync {
    /** Four of the six-hourly background syncs; the server shows Health as delayed after the same 24 h. */
    const val THRESHOLD_HOURS = 24L

    /**
     * The last successful full sync: the saved time ([savedMs], 0.4.4+), or for older installs the
     * time on the last status line when that sync did not fail; null when unknown.
     */
    fun lastSuccess(savedMs: Long?, lastStatus: String, lastSyncFailed: Boolean): Instant? =
        savedMs?.let(Instant::ofEpochMilli) ?: if (lastSyncFailed) null else TimeText.splitStatus(lastStatus).first

    /**
     * [configured]: an endpoint and token are saved and a first full sync has finished (before
     * that, the setup steps guide the user). [busy]: a sync is running (no warning meanwhile).
     */
    fun map(
        lastSuccess: Instant?,
        now: Instant,
        configured: Boolean,
        busy: Boolean,
        notificationsOn: Boolean,
        /** Why the last sync failed, when it did. */
        lastError: String? = null,
    ): StaleSyncUi? {
        if (!configured || busy || lastSuccess == null) return null
        if (Duration.between(lastSuccess, now) <= Duration.ofHours(THRESHOLD_HOURS)) return null
        val since = TimeText.relative(lastSuccess, now)
        return StaleSyncUi(
            headline = lastError ?: "背景同步可能沒有執行",
            detail = if (lastError != null) {
                // The header already says how long ago the last success was.
                "若重試仍失敗，請檢查伺服器。"
            } else {
                "已超過 $THRESHOLD_HOURS 小時沒有成功同步。請確認系統沒有限制 Infovore 的背景活動（電池用量）；使用私網位址時需保持 Tailscale 連線。"
            },
            // "完整同步": the sleep-only sync may have succeeded since, so the header names which one failed.
            summary = if (lastError != null) "完整同步失敗 · 上次成功 $since" else "超過 $THRESHOLD_HOURS 小時未同步 · 上次成功 $since",
            notifyLabel = if (notificationsOn) null else "開啟失敗通知",
        )
    }
}
