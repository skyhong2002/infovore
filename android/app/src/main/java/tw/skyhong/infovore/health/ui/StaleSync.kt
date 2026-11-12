package tw.skyhong.infovore.health.ui

import java.time.Duration
import java.time.Instant

/** The warning shown at the top of the health section when the last successful full sync is too old. */
data class StaleSyncUi(
    val text: String,
    /** The section header's short version. */
    val summary: String,
    val syncLabel: String,
    val syncEnabled: Boolean,
    /** "開啟通知" when notifications are not on (opt-in and permission); null when they are. */
    val notifyLabel: String?,
)

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
        syncEnabled: Boolean,
        notificationsOn: Boolean,
    ): StaleSyncUi? {
        if (!configured || busy || lastSuccess == null) return null
        if (Duration.between(lastSuccess, now) <= Duration.ofHours(THRESHOLD_HOURS)) return null
        val text = buildString {
            append("已超過 ").append(THRESHOLD_HOURS).append(" 小時沒有成功同步（上次成功：")
            append(TimeText.relative(lastSuccess, now)).append("）。")
            append("背景同步可能根本沒有執行：系統可能限制了 Infovore 的背景活動（電池最佳化），或 App 曾被強制停止。")
            append("公開網站的健康資料會停在上次同步的時間。請按「立即同步」，並確認系統沒有限制 Infovore 在背景執行。")
            if (!notificationsOn) {
                append("開啟通知後，背景同步連續失敗時會提醒你；但 App 完全沒有執行時無法發出任何通知，仍請不時開啟 App 確認。")
            }
        }
        return StaleSyncUi(
            text = text,
            summary = "超過 $THRESHOLD_HOURS 小時未同步",
            syncLabel = "立即同步",
            syncEnabled = syncEnabled,
            notifyLabel = if (notificationsOn) null else "開啟通知",
        )
    }
}
