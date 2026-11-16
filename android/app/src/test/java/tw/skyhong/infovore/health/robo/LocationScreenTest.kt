package tw.skyhong.infovore.health.robo

import android.Manifest
import android.content.Intent
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
import tw.skyhong.infovore.health.MainActivity
import tw.skyhong.infovore.health.location.LocationBootReceiver
import tw.skyhong.infovore.health.location.LocationSettings
import tw.skyhong.infovore.health.location.LocationTrackingService

/** The "位置紀錄" section on the real settings screen, and the recorder's start-up paths. */
@RunWith(RobolectricTestRunner::class)
class LocationScreenTest {
    private fun launch(intent: Intent? = null): MainActivity {
        val controller = if (intent == null) Robolectric.buildActivity(MainActivity::class.java)
            else Robolectric.buildActivity(MainActivity::class.java, intent)
        return controller.setup().get().also { Robo.idle() }
    }

    private fun trackSwitch(activity: MainActivity): SwitchCompat =
        Robo.descendants(activity.window.decorView).filterIsInstance<SwitchCompat>().first { it.text == "持續記錄位置" }

    @Test
    fun turningRecordingOnWithPermissionStartsTheForegroundService() {
        shadowOf(Robo.app).grantPermissions(Manifest.permission.ACCESS_FINE_LOCATION, Manifest.permission.ACCESS_COARSE_LOCATION)
        val activity = launch(Intent(Robo.app, MainActivity::class.java).putExtra(MainActivity.EXTRA_OPEN_LOCATION, true))
        val root = activity.window.decorView
        Robo.textView(root, "未開啟。")

        trackSwitch(activity).performClick()
        Robo.idle()

        assertTrue(LocationSettings(Robo.app).trackingEnabled)
        assertEquals(LocationTrackingService::class.java.name, shadowOf(Robo.app).nextStartedService.component?.className)
        Robo.textView(root, "記錄中。")
        // Without "一律允許" the screen offers it, for restarts after a reboot.
        Robo.button(root, "允許「一律允許」位置（重新開機後自動繼續）")

        trackSwitch(activity).performClick()
        Robo.idle()
        assertFalse(LocationSettings(Robo.app).trackingEnabled)
    }

    @Test
    fun withoutPermissionTheSwitchAsksInsteadOfRecording() {
        val activity = launch()
        trackSwitch(activity).performClick()
        Robo.idle()
        val request = shadowOf(activity).lastRequestedPermission
        assertTrue(request.requestedPermissions.contains(Manifest.permission.ACCESS_FINE_LOCATION))
        assertFalse(LocationSettings(Robo.app).trackingEnabled)
        assertNull(shadowOf(Robo.app).nextStartedService)
    }

    @Test
    fun aRebootResumesRecordingOnlyWithBackgroundLocation() {
        LocationSettings(Robo.app).trackingEnabled = true
        shadowOf(Robo.app).grantPermissions(Manifest.permission.ACCESS_FINE_LOCATION)
        LocationBootReceiver().onReceive(Robo.app, Intent(Intent.ACTION_BOOT_COMPLETED))
        assertNull(shadowOf(Robo.app).nextStartedService)
        assertTrue(LocationSettings(Robo.app).serviceProblem!!.contains("重新啟動"))

        shadowOf(Robo.app).grantPermissions(Manifest.permission.ACCESS_BACKGROUND_LOCATION)
        LocationBootReceiver().onReceive(Robo.app, Intent(Intent.ACTION_BOOT_COMPLETED))
        assertEquals(LocationTrackingService::class.java.name, shadowOf(Robo.app).nextStartedService.component?.className)
    }
}
