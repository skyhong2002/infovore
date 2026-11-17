package tw.skyhong.infovore.health.robo

import android.content.Intent
import androidx.appcompat.app.AppCompatActivity
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.Robolectric
import org.robolectric.RobolectricTestRunner
import tw.skyhong.infovore.health.MainViewModel
import tw.skyhong.infovore.health.R
import tw.skyhong.infovore.health.SecureSettings
import tw.skyhong.infovore.health.main.UiHost
import tw.skyhong.infovore.health.ui.ViewKit

/** An activity whose system refuses one intent, as Health Connect's permission screen can. */
class RefusingActivity : AppCompatActivity() {
    val started = mutableListOf<String?>()

    override fun onCreate(savedInstanceState: android.os.Bundle?) {
        setTheme(R.style.Theme_InfovoreHealth)
        super.onCreate(savedInstanceState)
    }

    override fun startActivity(intent: Intent) {
        if (intent.action == REFUSED) throw SecurityException("Permission Denial: starting $intent")
        started += intent.action
    }

    companion object {
        const val REFUSED = "android.health.connect.action.MANAGE_HEALTH_PERMISSIONS"
    }
}

@RunWith(RobolectricTestRunner::class)
class OpenSafelyTest {
    @Test
    fun anIntentTheSystemRefusesIsReportedNotThrown() {
        val activity = Robolectric.buildActivity(RefusingActivity::class.java).setup().get()
        val host = UiHost(activity, ViewKit(activity), SecureSettings(activity), MainViewModel(activity.application))

        // Refused: no crash, the caller is told to fall back.
        assertFalse(host.openSafely(Intent(RefusingActivity.REFUSED), showError = false))
        // The fallback still opens.
        assertTrue(host.openSafely(Intent("androidx.health.ACTION_HEALTH_CONNECT_SETTINGS")))
        assertEquals(listOf("androidx.health.ACTION_HEALTH_CONNECT_SETTINGS"), activity.started)
    }
}
