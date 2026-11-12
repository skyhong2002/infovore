package tw.skyhong.infovore.health.robo

import android.content.Intent
import android.content.res.Configuration
import android.view.View
import android.widget.Button
import android.widget.CompoundButton
import android.widget.EditText
import androidx.appcompat.app.AlertDialog
import androidx.core.content.ContextCompat
import androidx.core.view.ViewCompat
import androidx.core.view.accessibility.AccessibilityNodeInfoCompat
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.Robolectric
import org.robolectric.RobolectricTestRunner
import org.robolectric.android.controller.ActivityController
import org.robolectric.annotation.Config
import org.robolectric.shadows.ShadowDialog
import tw.skyhong.infovore.health.MainActivity
import tw.skyhong.infovore.health.R
import tw.skyhong.infovore.health.ReconcileGap
import tw.skyhong.infovore.health.ReconcileGaps
import tw.skyhong.infovore.health.robo.Robo.descendants
import tw.skyhong.infovore.health.robo.Robo.hasVisibleText
import tw.skyhong.infovore.health.robo.Robo.textView
import tw.skyhong.infovore.health.screen.ObservationQueue

/**
 * The real MainActivity on Robolectric: what each section shows, TalkBack semantics, touch
 * targets, validation, the unsaved-changes dialog, and that it still renders with large text and
 * in dark mode. A phone-sized screen (411×891 dp, xxhdpi).
 */
@RunWith(RobolectricTestRunner::class)
@Config(qualifiers = "w411dp-h891dp-xxhdpi")
class MainActivityUiTest {
    private fun launch(intent: Intent? = null): ActivityController<MainActivity> {
        val controller = if (intent == null) Robolectric.buildActivity(MainActivity::class.java) else Robolectric.buildActivity(MainActivity::class.java, intent)
        controller.setup()
        Robo.waitFor { true }
        return controller
    }

    private val MainActivity.root: View get() = window.decorView

    private fun sectionHeader(activity: MainActivity, title: String): View = Robo.sectionHeader(activity.root, title)

    @Test
    fun firstRunShowsEverySectionWithHeadingsAndState() {
        val activity = launch().get()
        val root = activity.root
        // First-run steps, then the three sections and the privacy footer.
        assertTrue(hasVisibleText(root, activity.getString(R.string.setup_title)))
        assertTrue(ViewCompat.isAccessibilityHeading(textView(root, activity.getString(R.string.setup_title))))
        assertTrue(hasVisibleText(root, "Infovore"))
        assertTrue(hasVisibleText(root, activity.getString(R.string.footer_privacy)))

        // Nothing saved yet: the connection section starts open, health open, screen recording closed.
        val connection = sectionHeader(activity, activity.getString(R.string.section_connection))
        val health = sectionHeader(activity, activity.getString(R.string.section_health))
        val screen = sectionHeader(activity, activity.getString(R.string.section_screen))
        for (header in listOf(connection, health, screen)) {
            assertTrue("section header is a heading", ViewCompat.isAccessibilityHeading(header))
            assertTrue(header.isClickable)
        }
        assertEquals(activity.getString(R.string.state_expanded), ViewCompat.getStateDescription(connection))
        assertEquals(activity.getString(R.string.state_collapsed), ViewCompat.getStateDescription(screen))
        assertTrue(hasVisibleText(root, activity.getString(R.string.label_endpoint)))
        assertFalse("the sensitive section starts collapsed", hasVisibleText(root, activity.getString(R.string.screen_step_settings)))
        // The collapsed header names its state for TalkBack.
        assertTrue(screen.contentDescription.toString().startsWith(activity.getString(R.string.section_screen)))

        // Health Connect (a fake with nothing granted): the status asks for the permission.
        assertTrue(hasVisibleText(root, activity.getString(R.string.health_sync_heading)))
        // Nothing saved: no sync can start yet.
        assertFalse(Robo.button(root, activity.getString(R.string.action_sync_all)).isEnabled)

        // Expanding the screen section by tapping its header shows its steps.
        screen.performClick()
        Robo.idle()
        assertEquals(activity.getString(R.string.state_expanded), ViewCompat.getStateDescription(screen))
        assertTrue(hasVisibleText(root, activity.getString(R.string.screen_step_settings)))
        assertTrue(hasVisibleText(root, activity.getString(R.string.screen_warning)))
    }

    @Test
    fun everyVisibleControlIsAtLeast48dp() {
        val activity = launch().get()
        sectionHeader(activity, activity.getString(R.string.section_screen)).performClick()
        Robo.idle()
        assertTouchTargets(activity)
    }

    private fun assertTouchTargets(activity: MainActivity) {
        val min = Robo.dp(activity, 48)
        val controls = descendants(activity.root).filter {
            // Selectable status text is focusable for copying, not a control.
            val selectableText = it is android.widget.TextView && it !is EditText && it.isTextSelectable
            it.isShown && (it is Button || it is CompoundButton || it is EditText || (it.isClickable && it.isFocusable && !selectableText))
        }
        assertTrue("found the controls", controls.size >= 10)
        for (view in controls) {
            val label = (view as? android.widget.TextView)?.text ?: view.contentDescription
            assertTrue("\"$label\" is ${view.height}px tall, below 48dp ($min px)", view.height >= min)
            if (view is Button) assertTrue("\"$label\" is ${view.width}px wide", view.width >= min)
        }
    }

    @Test
    @Config(qualifiers = "w360dp-h740dp-night-xhdpi", fontScale = 1.3f)
    fun largeTextAndDarkModeStillRenderEverySection() {
        val activity = launch().get()
        val night = activity.resources.configuration.uiMode and Configuration.UI_MODE_NIGHT_MASK
        assertEquals(Configuration.UI_MODE_NIGHT_YES, night)
        assertEquals(1.3f, activity.resources.configuration.fontScale, 0.001f)
        // The dark palette is in use (values-night).
        val background = ContextCompat.getColor(activity, R.color.screen_background)
        val red = background shr 16 and 0xff
        assertTrue("dark background, red channel $red", red < 0x40)
        // Body text scales with the user's font size (Android 14 scales large text non-linearly):
        // 16sp at xhdpi (2.0) is 32px unscaled.
        val intro = textView(activity.root, activity.getString(R.string.header_intro))
        assertTrue("16sp body text is ${intro.textSize}px", intro.textSize > 16f * 2f * 1.2f)
        sectionHeader(activity, activity.getString(R.string.section_screen)).performClick()
        Robo.idle()
        assertTrue(hasVisibleText(activity.root, activity.getString(R.string.screen_step_recording)))
        assertTouchTargets(activity)
        assertTrue(hasVisibleText(activity.root, activity.getString(R.string.footer_privacy)))
    }

    @Test
    fun invalidEndpointAndTokenShowFieldErrors() {
        val activity = launch().get()
        val endpoint = activity.findViewById<EditText>(R.id.endpoint_input)
        val token = activity.findViewById<EditText>(R.id.token_input)
        endpoint.setText("ftp://infovore.example")
        token.setText("too-short")
        Robo.button(activity.root, activity.getString(R.string.action_save_connection)).performClick()
        Robo.idle()
        assertTrue(hasVisibleText(activity.root, "⚠ 網址需以 https:// 開頭"))
        assertTrue(hasVisibleText(activity.root, activity.getString(R.string.save_state_fix_errors)))
        // TalkBack hears the field as invalid, with the message as its error.
        val info = AccessibilityNodeInfoCompat.wrap(endpoint.createAccessibilityNodeInfo())
        assertTrue(info.isContentInvalid)
        assertEquals("網址需以 https:// 開頭", info.error.toString())
        val tokenInfo = AccessibilityNodeInfoCompat.wrap(token.createAccessibilityNodeInfo())
        assertTrue(tokenInfo.isContentInvalid)
        assertTrue(endpoint.hasFocus())
        // Nothing invalid was saved.
        assertEquals(tw.skyhong.infovore.health.SecureSettings.DEFAULT_ENDPOINT, Robo.settings().endpoint)
        assertEquals("", Robo.settings().token)
    }

    @Test
    fun backWithUnsavedChangesAsksFirst() {
        val controller = launch()
        val activity = controller.get()
        activity.findViewById<EditText>(R.id.endpoint_input).setText("https://other.example")
        Robo.idle()
        activity.onBackPressedDispatcher.onBackPressed()
        Robo.idle()
        val dialog = ShadowDialog.getLatestDialog() as AlertDialog
        assertTrue(dialog.isShowing)
        assertFalse(activity.isFinishing)
        assertEquals(activity.getString(R.string.unsaved_keep_editing), dialog.getButton(AlertDialog.BUTTON_NEUTRAL).text)
        // "繼續編輯" keeps the screen and the edit.
        dialog.getButton(AlertDialog.BUTTON_NEUTRAL).performClick()
        Robo.idle()
        assertFalse(activity.isFinishing)
        assertEquals("https://other.example", activity.findViewById<EditText>(R.id.endpoint_input).text.toString())
        // "捨棄" leaves without saving.
        activity.onBackPressedDispatcher.onBackPressed()
        Robo.idle()
        (ShadowDialog.getLatestDialog() as AlertDialog).getButton(AlertDialog.BUTTON_NEGATIVE).performClick()
        Robo.idle()
        assertTrue(activity.isFinishing)
        assertEquals(tw.skyhong.infovore.health.SecureSettings.DEFAULT_ENDPOINT, Robo.settings().endpoint)
    }

    @Test
    fun backWithoutChangesLeavesAtOnce() {
        val activity = launch().get()
        activity.onBackPressedDispatcher.onBackPressed()
        Robo.idle()
        assertTrue(activity.isFinishing)
    }

    @Test
    fun aDayWithoutSyncShowsTheStaleWarningWithItsActions() {
        Robo.saveConnection()
        Robo.settings().lastSuccessfulSyncMs = System.currentTimeMillis() - 30 * 3_600_000L
        Robo.grantHealthConnect()
        val activity = launch().get()
        val root = activity.root
        val warning = textView(root, "已超過 24 小時沒有成功同步")
        assertEquals(View.VISIBLE, warning.visibility)
        assertEquals(View.ACCESSIBILITY_LIVE_REGION_POLITE, warning.accessibilityLiveRegion)
        assertTrue(Robo.button(root, "立即同步").isEnabled)
        // Notifications are off: offered, only on tap.
        assertTrue(Robo.button(root, "開啟通知").isShown)
        val health = sectionHeader(activity, activity.getString(R.string.section_health))
        assertTrue(health.contentDescription.toString().contains("超過 24 小時未同步"))
    }

    @Test
    fun aRecentSyncShowsNoStaleWarning() {
        Robo.saveConnection()
        Robo.settings().lastSuccessfulSyncMs = System.currentTimeMillis() - 3_600_000L
        Robo.grantHealthConnect()
        val activity = launch().get()
        assertFalse(hasVisibleText(activity.root, "已超過 24 小時沒有成功同步"))
        // Ready: the first-run steps are done and syncing is allowed.
        assertTrue(Robo.button(activity.root, activity.getString(R.string.action_sync_all)).isEnabled)
    }

    @Test
    fun anUnverifiedWindowShowsTheReconcileReminder() {
        Robo.saveConnection()
        Robo.grantHealthConnect()
        val now = System.currentTimeMillis()
        Robo.settings().reconcileGapsText = ReconcileGaps.encode(
            listOf(ReconcileGap("steps", now - 7 * 86_400_000L, now - 86_400_000L, "interrupted", now - 3_600_000L)),
        )
        val activity = launch().get()
        val reverify = Robo.button(activity.root, activity.getString(R.string.action_reverify))
        assertTrue(reverify.isEnabled)
        assertTrue(hasVisibleText(activity.root, "步數"))
        val health = sectionHeader(activity, activity.getString(R.string.section_health))
        assertTrue(health.contentDescription.toString().contains(activity.getString(R.string.health_summary_unverified)))
    }

    @Test
    fun theQuarantineWarningIntentOpensTheScreenSection() {
        val intent = Intent(Robo.app, MainActivity::class.java).putExtra(MainActivity.EXTRA_OPEN_SCREEN, true)
        val activity = launch(intent).get()
        assertEquals(activity.getString(R.string.state_expanded), ViewCompat.getStateDescription(sectionHeader(activity, activity.getString(R.string.section_screen))))
        assertTrue(hasVisibleText(activity.root, activity.getString(R.string.screen_step_settings)))
        // Consumed: a recreation does not open it again.
        assertFalse(activity.intent.hasExtra(MainActivity.EXTRA_OPEN_SCREEN))
    }

    @Test
    fun droppedRecordsAreCountedOnScreenAndResetOnlyAfterConfirming() {
        val queue = ObservationQueue.get(Robo.app)
        val day = 86_400_000L
        val now = System.currentTimeMillis()
        val destination = tw.skyhong.infovore.health.DestinationChange.normalize(Robo.settings().endpoint)
        for (i in 0 until 2) queue.enqueueJson(destination, now - 9 * day + i, "old$i", "{}")
        Robo.idle()
        assertEquals(2L, queue.dropLog().expired)

        val activity = launch().get()
        val screen = sectionHeader(activity, activity.getString(R.string.section_screen))
        // Visible on the collapsed header too.
        assertTrue(screen.contentDescription.toString().contains("已淘汰 2 筆"))
        screen.performClick()
        Robo.idle()
        val box = activity.findViewById<android.widget.TextView>(R.id.screen_dropped)
        assertEquals(View.VISIBLE, box.visibility)
        assertTrue(box.text.toString().startsWith("已因過期淘汰 2 筆、因容量淘汰 0 筆（最近："))
        assertFalse("counts only, never content", box.text.contains("old0"))

        Robo.button(activity.root, activity.getString(R.string.action_reset_dropped)).performClick()
        Robo.idle()
        val dialog = ShadowDialog.getLatestDialog() as AlertDialog
        // Cancel keeps the counts.
        dialog.getButton(AlertDialog.BUTTON_NEGATIVE).performClick()
        Robo.idle()
        assertEquals(2L, queue.dropLog().expired)
        Robo.button(activity.root, activity.getString(R.string.action_reset_dropped)).performClick()
        Robo.idle()
        (ShadowDialog.getLatestDialog() as AlertDialog).getButton(AlertDialog.BUTTON_POSITIVE).performClick()
        Robo.idle()
        assertTrue(queue.dropLog().isEmpty)
        assertEquals(View.GONE, box.visibility)
    }
}
