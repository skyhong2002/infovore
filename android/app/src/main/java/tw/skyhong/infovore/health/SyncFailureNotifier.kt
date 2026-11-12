package tw.skyhong.infovore.health

import android.Manifest
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.provider.Settings
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import androidx.core.content.ContextCompat
import tw.skyhong.infovore.health.SyncFailureAlerts.Delivery
import tw.skyhong.infovore.health.screen.ScreenUploader

/**
 * Applies [SyncFailureAlerts] decisions: keeps the consecutive-failure count in [SecureSettings]
 * and shows one local notification on the "同步問題" channel, which opens the app's health
 * section. Notifications are posted only when the user turned them on in the app and the system
 * would show them ([delivery]: POST_NOTIFICATIONS, Infovore's notifications and the channel all
 * on); the text never contains health values, error details or tokens. A warning that could not
 * be shown is not counted as delivered, and is delivered by [catchUp] once it can be. The same
 * channel and opt-in carry the screen-record quarantine warning ([QuarantineNotifier]).
 */
object SyncFailureNotifier {
    const val CHANNEL_ID = "sync_problems"
    const val NOTIFICATION_ID = 1001

    fun record(context: Context, settings: SecureSettings, outcome: SyncFailureAlerts.Outcome) {
        val shown = delivery(context).shown
        val decision = SyncFailureAlerts.next(settings.backgroundFailures, outcome, settings.notifyOnSyncFailure && shown)
        if (decision.failures != settings.backgroundFailures) settings.backgroundFailures = decision.failures
        // A successful sync removes only its own warning; the screen quarantine's stays.
        if (decision.clear) {
            NotificationManagerCompat.from(context).cancel(NOTIFICATION_ID)
            settings.syncFailureNotified = false
        }
        when {
            decision.notify -> settings.syncFailureNotified = show(context, decision.failures)
            // Hidden by the system: whatever was shown is gone, so it is delivered again later.
            !shown && settings.syncFailureNotified -> settings.syncFailureNotified = false
        }
    }

    /**
     * Called when notifications were just turned on (the switch, or the permission granted) and
     * whenever the app comes back to the foreground, where the user may have turned Infovore's
     * notifications or the "同步問題" channel back on in system settings: shows the warnings that
     * already apply (background syncs failing, the screen quarantine filling or full) and were
     * not delivered yet, instead of waiting for the next change. Each still shows once.
     */
    fun catchUp(context: Context, settings: SecureSettings) {
        val shown = delivery(context).shown
        val enabled = settings.notifyOnSyncFailure && shown
        if (!shown && settings.syncFailureNotified) settings.syncFailureNotified = false
        if (SyncFailureAlerts.catchUp(settings.backgroundFailures, enabled, settings.syncFailureNotified)) {
            settings.syncFailureNotified = show(context, settings.backgroundFailures)
        }
        ScreenUploader.recheckQuarantine(context)
    }

    fun permissionGranted(context: Context): Boolean =
        ContextCompat.checkSelfPermission(context, Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED

    /** Whether a notification on the "同步問題" channel would be shown right now, and if not, why. */
    fun delivery(context: Context): Delivery {
        val manager = NotificationManagerCompat.from(context)
        return SyncFailureAlerts.delivery(
            permission = permissionGranted(context),
            appEnabled = manager.areNotificationsEnabled(),
            channelBlocked = manager.getNotificationChannel(CHANNEL_ID)?.importance == NotificationManager.IMPORTANCE_NONE,
        )
    }

    /** The user's opt-in and [delivery] both hold: warnings reach the user in the background. */
    fun notificationsOn(context: Context, settings: SecureSettings): Boolean = settings.notifyOnSyncFailure && delivery(context).shown

    /** System settings where the user turns the blocked notifications back on. */
    fun settingsIntent(context: Context, delivery: Delivery): Intent =
        if (delivery == Delivery.CHANNEL_BLOCKED) {
            Intent(Settings.ACTION_CHANNEL_NOTIFICATION_SETTINGS)
                .putExtra(Settings.EXTRA_APP_PACKAGE, context.packageName)
                .putExtra(Settings.EXTRA_CHANNEL_ID, CHANNEL_ID)
        } else {
            Intent(Settings.ACTION_APP_NOTIFICATION_SETTINGS).putExtra(Settings.EXTRA_APP_PACKAGE, context.packageName)
        }

    /**
     * When the user turns notifications off: removes this notification and the screen-record
     * quarantine warning, and forgets that they were shown, so turning them on again delivers
     * the warnings that still apply ([catchUp]).
     */
    fun cancel(context: Context) {
        NotificationManagerCompat.from(context).cancel(NOTIFICATION_ID)
        SecureSettings(context).syncFailureNotified = false
        QuarantineNotifier.withdraw(context)
    }

    private fun show(context: Context, failures: Int): Boolean {
        val text = SyncFailureAlerts.text(failures)
        return post(context, NOTIFICATION_ID, SyncFailureAlerts.title(), text, MainActivity.EXTRA_OPEN_HEALTH)
    }

    /**
     * Posts [title]/[text] as notification [id] on the "同步問題" channel; tapping it opens the
     * app with [openExtra] set. Returns whether the system will show it: false, without posting,
     * when [delivery] says it would be hidden.
     */
    internal fun post(context: Context, id: Int, title: String, text: String, openExtra: String): Boolean {
        if (!permissionGranted(context)) return false
        val manager = NotificationManagerCompat.from(context)
        // Keeps the user's importance if the channel exists; creates it at the default otherwise.
        manager.createNotificationChannel(
            NotificationChannel(CHANNEL_ID, context.getString(R.string.notification_channel_sync), NotificationManager.IMPORTANCE_DEFAULT).apply {
                description = context.getString(R.string.notification_channel_sync_description)
            },
        )
        if (!delivery(context).shown) return false
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
        return try {
            manager.notify(id, notification)
            true
        } catch (_: SecurityException) {
            // The permission was revoked in between; the in-app status still shows the failure.
            false
        }
    }
}
