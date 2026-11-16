package tw.skyhong.infovore.health.robo

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.provider.Settings
import android.view.View
import androidx.appcompat.widget.SwitchCompat
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.Robolectric
import org.robolectric.RobolectricTestRunner
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config
import tw.skyhong.infovore.health.MainActivity
import tw.skyhong.infovore.health.R
import tw.skyhong.infovore.health.SyncFailureAlerts
import tw.skyhong.infovore.health.SyncFailureAlerts.Outcome
import tw.skyhong.infovore.health.SyncFailureNotifier

/**
 * The "同步問題" notifications as the system receives them (Robolectric's NotificationManager):
 * what is posted, on which channel, with what text and tap target, and that a warning the system
 * would hide (permission, Infovore's notifications or the channel off) is not counted as delivered
 * and is delivered once it can be.
 */
@RunWith(RobolectricTestRunner::class)
@Config(qualifiers = "w411dp-h891dp-xxhdpi")
class NotificationsTest {
    private val channelId = SyncFailureNotifier.CHANNEL_ID

    private fun optIn() {
        Robo.grantNotificationPermission()
        Robo.settings().notifyOnSyncFailure = true
    }

    private fun posted(id: Int): Notification? = Robo.shadowNotifications.getNotification(id)

    /** What the user does in system settings: the channel set to "off" (importance NONE). */
    private fun setChannelImportance(importance: Int) {
        Robo.notifications.createNotificationChannel(NotificationChannel(channelId, "同步問題", importance))
        Robo.notifications.getNotificationChannel(channelId).importance = importance
        assertEquals(importance, Robo.notifications.getNotificationChannel(channelId).importance)
    }

    private fun Notification.allText(): String =
        listOf(Notification.EXTRA_TITLE, Notification.EXTRA_TEXT, Notification.EXTRA_BIG_TEXT)
            .joinToString("\n") { extras.getCharSequence(it)?.toString().orEmpty() }

    private fun assertNoSecrets(text: String) {
        for (secret in listOf(Robo.ENDPOINT, "infovore.example", Robo.HEALTH_TOKEN, "http", "Exception", "com.")) {
            assertFalse("notification mentions \"$secret\": $text", text.contains(secret))
        }
    }

    private fun assertOpens(notification: Notification, extra: String) {
        val intent = shadowOf(notification.contentIntent).savedIntent
        assertTrue(notification.contentIntent.isActivity)
        assertEquals(MainActivity::class.java.name, intent.component?.className)
        assertTrue(intent.getBooleanExtra(extra, false))
    }

    @Test
    fun repeatedBackgroundFailuresPostOnePrivateWarningThatOpensTheHealthSection() {
        Robo.saveConnection()
        optIn()
        repeat(SyncFailureAlerts.THRESHOLD) { SyncFailureNotifier.record(Robo.app, Robo.settings(), Outcome.FINAL_FAILURE) }
        val notification = requireNotNull(posted(SyncFailureNotifier.NOTIFICATION_ID))
        assertEquals(channelId, notification.channelId)
        assertEquals(Robo.app.getString(R.string.notification_channel_sync), Robo.notifications.getNotificationChannel(channelId).name)
        assertEquals(NotificationManager.IMPORTANCE_DEFAULT, Robo.notifications.getNotificationChannel(channelId).importance)
        assertEquals(Notification.VISIBILITY_PRIVATE, notification.visibility)
        assertEquals(Notification.CATEGORY_ERROR, notification.category)
        assertNoSecrets(notification.allText())
        assertOpens(notification, MainActivity.EXTRA_OPEN_HEALTH)
        assertEquals(1, Robo.shadowNotifications.size())
    }

    @Test
    fun withoutTheOptInOrThePermissionNothingIsPostedOrCounted() {
        Robo.grantNotificationPermission()
        repeat(SyncFailureAlerts.THRESHOLD) { SyncFailureNotifier.record(Robo.app, Robo.settings(), Outcome.FINAL_FAILURE) }
        assertEquals(0, Robo.shadowNotifications.size())

        Robo.settings().backgroundFailures = 0
        Robo.settings().notifyOnSyncFailure = true
        Robo.denyNotificationPermission()
        repeat(SyncFailureAlerts.THRESHOLD) { SyncFailureNotifier.record(Robo.app, Robo.settings(), Outcome.FINAL_FAILURE) }
        assertEquals(0, Robo.shadowNotifications.size())
        assertFalse(Robo.settings().syncFailureNotified)
        assertEquals(SyncFailureAlerts.Delivery.NO_PERMISSION, SyncFailureNotifier.delivery(Robo.app))
    }

    @Test
    fun aBlockedChannelIsNotCountedAsNotifiedAndCatchesUpOnceReopened() {
        Robo.saveConnection()
        optIn()
        setChannelImportance(NotificationManager.IMPORTANCE_NONE)
        assertEquals(SyncFailureAlerts.Delivery.CHANNEL_BLOCKED, SyncFailureNotifier.delivery(Robo.app))

        repeat(SyncFailureAlerts.THRESHOLD) { SyncFailureNotifier.record(Robo.app, Robo.settings(), Outcome.FINAL_FAILURE) }
        assertEquals(0, Robo.shadowNotifications.size())
        assertFalse(Robo.settings().syncFailureNotified)
        assertEquals(SyncFailureAlerts.THRESHOLD, Robo.settings().backgroundFailures)

        // The user turns the channel back on in system settings and returns to the app.
        setChannelImportance(NotificationManager.IMPORTANCE_DEFAULT)
        val controller = Robolectric.buildActivity(MainActivity::class.java).setup()
        Robo.waitFor { posted(SyncFailureNotifier.NOTIFICATION_ID) != null }
        assertTrue(posted(SyncFailureNotifier.NOTIFICATION_ID)!!.allText().contains("連續失敗 3 次"))
        assertTrue(Robo.settings().syncFailureNotified)

        // Delivered once: dismissed by the user, a later return to the app does not repeat it.
        Robo.notifications.cancelAll()
        controller.pause().resume()
        Thread.sleep(200)
        Robo.idle()
        assertEquals(0, Robo.shadowNotifications.size())
    }

    @Test
    fun appNotificationsTurnedOffInSystemSettingsAreNotCountedEither() {
        Robo.saveConnection()
        optIn()
        Robo.shadowNotifications.setNotificationsEnabled(false)
        assertEquals(SyncFailureAlerts.Delivery.APP_BLOCKED, SyncFailureNotifier.delivery(Robo.app))
        repeat(SyncFailureAlerts.THRESHOLD) { SyncFailureNotifier.record(Robo.app, Robo.settings(), Outcome.FINAL_FAILURE) }
        assertEquals(0, Robo.shadowNotifications.size())
        assertFalse(Robo.settings().syncFailureNotified)

        Robo.shadowNotifications.setNotificationsEnabled(true)
        SyncFailureNotifier.catchUp(Robo.app, Robo.settings())
        val notification = requireNotNull(posted(SyncFailureNotifier.NOTIFICATION_ID))
        assertOpens(notification, MainActivity.EXTRA_OPEN_HEALTH)
        assertTrue(Robo.settings().syncFailureNotified)

        // Shown, then hidden by the system again: forgotten, so it is delivered again later.
        Robo.shadowNotifications.setNotificationsEnabled(false)
        SyncFailureNotifier.catchUp(Robo.app, Robo.settings())
        assertFalse(Robo.settings().syncFailureNotified)

        // A successful sync removes it and resets the count.
        Robo.shadowNotifications.setNotificationsEnabled(true)
        SyncFailureNotifier.catchUp(Robo.app, Robo.settings())
        SyncFailureNotifier.record(Robo.app, Robo.settings(), Outcome.SUCCESS)
        assertNull(posted(SyncFailureNotifier.NOTIFICATION_ID))
        assertEquals(0, Robo.settings().backgroundFailures)
        assertFalse(Robo.settings().syncFailureNotified)
    }

    @Test
    fun turningTheSwitchOnDeliversTheWarningThatAlreadyApplies() {
        Robo.saveConnection()
        Robo.grantNotificationPermission()
        repeat(SyncFailureAlerts.THRESHOLD) { SyncFailureNotifier.record(Robo.app, Robo.settings(), Outcome.FINAL_FAILURE) }
        assertEquals(0, Robo.shadowNotifications.size())

        val activity = Robolectric.buildActivity(MainActivity::class.java).setup().get()
        Robo.idle()
        val switch = Robo.descendants(activity.window.decorView).filterIsInstance<SwitchCompat>()
            .first { it.text == activity.getString(R.string.label_notify_switch) }
        assertFalse(switch.isChecked)
        switch.performClick()
        Robo.waitFor { posted(SyncFailureNotifier.NOTIFICATION_ID) != null }
        val notification = posted(SyncFailureNotifier.NOTIFICATION_ID)!!
        assertTrue(notification.allText().contains("背景同步已連續失敗 3 次"))
        assertNoSecrets(notification.allText())
        assertTrue(Robo.settings().notifyOnSyncFailure)

        // Off again: withdrawn and forgotten.
        switch.performClick()
        Robo.idle()
        assertNull(posted(SyncFailureNotifier.NOTIFICATION_ID))
        assertFalse(Robo.settings().notifyOnSyncFailure)
        assertFalse(Robo.settings().syncFailureNotified)
    }

    @Test
    fun theScreenExplainsABlockedChannelAndOpensItsSettings() {
        Robo.saveConnection()
        optIn()
        setChannelImportance(NotificationManager.IMPORTANCE_NONE)
        val activity = Robolectric.buildActivity(MainActivity::class.java).setup().get()
        Robo.idle()
        val root = activity.window.decorView
        assertTrue(Robo.hasVisibleText(root, activity.getString(R.string.notify_blocked_channel)))
        val open = Robo.button(root, activity.getString(R.string.action_open_notification_settings))
        assertEquals(View.VISIBLE, open.visibility)
        open.performClick()
        val started = shadowOf(activity).nextStartedActivity
        assertEquals(Settings.ACTION_CHANNEL_NOTIFICATION_SETTINGS, started.action)
        assertEquals(channelId, started.getStringExtra(Settings.EXTRA_CHANNEL_ID))
        assertEquals(activity.packageName, started.getStringExtra(Settings.EXTRA_APP_PACKAGE))
    }

    @Test
    fun theScreenHidesTheSettingsButtonWhenNotificationsWork() {
        optIn()
        val activity = Robolectric.buildActivity(MainActivity::class.java).setup().get()
        Robo.idle()
        val root = activity.window.decorView
        assertFalse(Robo.hasVisibleText(root, activity.getString(R.string.action_open_notification_settings)))
        assertTrue(Robo.hasVisibleText(root, "背景同步連續失敗 3 次"))
    }
}
