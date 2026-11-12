package tw.skyhong.infovore.health

import android.content.Context
import androidx.core.app.NotificationManagerCompat
import tw.skyhong.infovore.health.screen.ObservationQueue
import tw.skyhong.infovore.health.screen.QuarantineAlerts
import tw.skyhong.infovore.health.screen.ScreenSettings

/**
 * Applies [QuarantineAlerts] decisions after every screen upload run and every requeue or delete
 * of rejected records: keeps the last level in [ScreenSettings] and shows one notification on
 * the "同步問題" channel when the quarantine reaches 80% of its limit and again when it is full
 * (uploads stopped). It uses the same opt-in as background-sync failures ("同步失敗時通知我"
 * and POST_NOTIFICATIONS); the text holds counts only, never screen content or app names.
 */
object QuarantineNotifier {
    private const val NOTIFICATION_ID = 1002

    fun record(context: Context, rejected: Int, pending: Int, maxRejected: Int = ObservationQueue.MAX_REJECTED) {
        val screen = ScreenSettings(context)
        val previous = screen.quarantineAlertLevel
        val decision = QuarantineAlerts.next(previous, rejected, maxRejected, SecureSettings(context).notifyOnSyncFailure)
        if (decision.level != previous) screen.quarantineAlertLevel = decision.level
        if (decision.clear) cancel(context)
        if (decision.notify) {
            SyncFailureNotifier.post(
                context,
                NOTIFICATION_ID,
                QuarantineAlerts.title(decision.level),
                QuarantineAlerts.text(decision.level, rejected, maxRejected, pending),
                MainActivity.EXTRA_OPEN_SCREEN,
            )
        }
    }

    fun cancel(context: Context) {
        NotificationManagerCompat.from(context).cancel(NOTIFICATION_ID)
    }
}
