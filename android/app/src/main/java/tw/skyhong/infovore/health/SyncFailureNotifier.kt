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

/**
 * Applies [SyncFailureAlerts] decisions: keeps the consecutive-failure count in [SecureSettings]
 * and shows one local notification on the "同步問題" channel, which opens the app's health
 * section. Notifications are posted only when the user turned them on in the app and granted
 * POST_NOTIFICATIONS; the text never contains health values, error details or tokens.
 */
object SyncFailureNotifier {
    private const val CHANNEL_ID = "sync_problems"
    private const val NOTIFICATION_ID = 1001

    fun record(context: Context, settings: SecureSettings, outcome: SyncFailureAlerts.Outcome) {
        val decision = SyncFailureAlerts.next(settings.backgroundFailures, outcome, settings.notifyOnSyncFailure)
        if (decision.failures != settings.backgroundFailures) settings.backgroundFailures = decision.failures
        if (decision.clear) cancel(context)
        if (decision.notify) show(context, decision.failures)
    }

    fun permissionGranted(context: Context): Boolean =
        ContextCompat.checkSelfPermission(context, Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED

    fun cancel(context: Context) {
        NotificationManagerCompat.from(context).cancel(NOTIFICATION_ID)
    }

    private fun show(context: Context, failures: Int) {
        if (ContextCompat.checkSelfPermission(context, Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) return
        val manager = NotificationManagerCompat.from(context)
        manager.createNotificationChannel(
            NotificationChannel(CHANNEL_ID, context.getString(R.string.notification_channel_sync), NotificationManager.IMPORTANCE_DEFAULT).apply {
                description = context.getString(R.string.notification_channel_sync_description)
            },
        )
        val open = PendingIntent.getActivity(
            context,
            0,
            Intent(context, MainActivity::class.java)
                .putExtra(MainActivity.EXTRA_OPEN_HEALTH, true)
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP or Intent.FLAG_ACTIVITY_SINGLE_TOP),
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
        )
        val text = SyncFailureAlerts.text(failures)
        val notification = NotificationCompat.Builder(context, CHANNEL_ID)
            .setSmallIcon(R.drawable.ic_stat_sync_problem)
            .setContentTitle(SyncFailureAlerts.title())
            .setContentText(text)
            .setStyle(NotificationCompat.BigTextStyle().bigText(text))
            .setContentIntent(open)
            .setAutoCancel(true)
            .setOnlyAlertOnce(true)
            .setCategory(NotificationCompat.CATEGORY_ERROR)
            .setVisibility(NotificationCompat.VISIBILITY_PRIVATE)
            .build()
        try {
            manager.notify(NOTIFICATION_ID, notification)
        } catch (_: SecurityException) {
            // The permission was revoked in between; the in-app status still shows the failure.
        }
    }
}
