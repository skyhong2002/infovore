package tw.skyhong.infovore.health

import android.Manifest
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import androidx.core.content.ContextCompat
import tw.skyhong.infovore.health.screen.ScreenUploader

/**
 * Applies [SyncFailureAlerts] decisions: keeps the consecutive-failure count in [SecureSettings]
 * and shows one local notification on the "同步問題" channel, which opens the app's health
 * section. Notifications are posted only when the user turned them on in the app and granted
 * POST_NOTIFICATIONS; the text never contains health values, error details or tokens. The same
 * channel and opt-in carry the screen-record quarantine warning ([QuarantineNotifier]).
 */
object SyncFailureNotifier {
    private const val CHANNEL_ID = "sync_problems"
    private const val NOTIFICATION_ID = 1001

    fun record(context: Context, settings: SecureSettings, outcome: SyncFailureAlerts.Outcome) {
        val decision = SyncFailureAlerts.next(settings.backgroundFailures, outcome, settings.notifyOnSyncFailure)
        if (decision.failures != settings.backgroundFailures) settings.backgroundFailures = decision.failures
        // A successful sync removes only its own warning; the screen quarantine's stays.
        if (decision.clear) NotificationManagerCompat.from(context).cancel(NOTIFICATION_ID)
        if (decision.notify) show(context, decision.failures)
    }

    /**
     * Called when notifications were just turned on (the switch, or the permission granted):
     * shows at once the warnings that already apply (background syncs failing, the screen
     * quarantine filling or full) instead of waiting for the next change. Each still shows once.
     */
    fun catchUp(context: Context, settings: SecureSettings) {
        val enabled = settings.notifyOnSyncFailure && permissionGranted(context)
        if (SyncFailureAlerts.catchUp(settings.backgroundFailures, enabled)) show(context, settings.backgroundFailures)
        ScreenUploader.recheckQuarantine(context)
    }

    fun permissionGranted(context: Context): Boolean =
        ContextCompat.checkSelfPermission(context, Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED

    /**
     * When the user turns notifications off: removes this notification and the screen-record
     * quarantine warning, and forgets that the latter was shown, so turning them on again
     * delivers the warnings that still apply ([catchUp]).
     */
    fun cancel(context: Context) {
        NotificationManagerCompat.from(context).cancel(NOTIFICATION_ID)
        QuarantineNotifier.withdraw(context)
    }

    private fun show(context: Context, failures: Int) {
        val text = SyncFailureAlerts.text(failures)
        post(context, NOTIFICATION_ID, SyncFailureAlerts.title(), text, MainActivity.EXTRA_OPEN_HEALTH)
    }

    /**
     * Posts [title]/[text] as notification [id] on the "同步問題" channel; tapping it opens the
     * app with [openExtra] set. Does nothing without POST_NOTIFICATIONS.
     */
    internal fun post(context: Context, id: Int, title: String, text: String, openExtra: String) {
        if (!permissionGranted(context)) return
        val manager = NotificationManagerCompat.from(context)
        manager.createNotificationChannel(
            NotificationChannel(CHANNEL_ID, context.getString(R.string.notification_channel_sync), NotificationManager.IMPORTANCE_DEFAULT).apply {
                description = context.getString(R.string.notification_channel_sync_description)
            },
        )
        val open = PendingIntent.getActivity(
            context,
            id,
            Intent(context, MainActivity::class.java)
                .putExtra(openExtra, true)
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP or Intent.FLAG_ACTIVITY_SINGLE_TOP),
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
        )
        val notification = NotificationCompat.Builder(context, CHANNEL_ID)
            .setSmallIcon(R.drawable.ic_stat_sync_problem)
            .setContentTitle(title)
            .setContentText(text)
            .setStyle(NotificationCompat.BigTextStyle().bigText(text))
            .setContentIntent(open)
            .setAutoCancel(true)
            .setOnlyAlertOnce(true)
            .setCategory(NotificationCompat.CATEGORY_ERROR)
            .setVisibility(NotificationCompat.VISIBILITY_PRIVATE)
            .build()
        try {
            manager.notify(id, notification)
        } catch (_: SecurityException) {
            // The permission was revoked in between; the in-app status still shows the failure.
        }
    }
}
