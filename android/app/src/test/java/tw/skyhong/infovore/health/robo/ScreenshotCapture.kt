package tw.skyhong.infovore.health.robo

import android.Manifest
import android.content.Intent
import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.Color
import android.view.View
import android.widget.EditText
import android.widget.ScrollView
import androidx.appcompat.app.AlertDialog
import org.junit.After
import org.junit.Assume.assumeTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.Robolectric
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode
import org.robolectric.shadows.ShadowDialog
import androidx.health.connect.client.permission.HealthPermission
import androidx.health.connect.client.testing.FakeHealthConnectClient
import androidx.health.connect.client.testing.FakePermissionController
import tw.skyhong.infovore.health.HealthConnectAccess
import tw.skyhong.infovore.health.HealthConnectSync
import tw.skyhong.infovore.health.MainActivity
import tw.skyhong.infovore.health.R
import tw.skyhong.infovore.health.location.LocationFix
import tw.skyhong.infovore.health.location.LocationSettings
import tw.skyhong.infovore.health.update.AppRelease
import tw.skyhong.infovore.health.update.UpdatePrompt
import java.io.File
import java.time.Instant

/**
 * Renders the main screen in its typical states to PNGs for design review: the whole scrolled
 * page (`<name>-full.png`) and the first screenful (`<name>.png`), on a 411×891 dp xxhdpi phone.
 * Skipped unless INFOVORE_SCREENSHOTS names an output directory.
 */
@RunWith(RobolectricTestRunner::class)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
// SDK 35: the line breaker honours the no-break clause spans there (as on the Pixel 7).
@Config(sdk = [35], qualifiers = "w411dp-h891dp-xxhdpi")
class ScreenshotCapture {
    private val outDir: String? = System.getProperty("infovore.screenshots")?.takeIf { it.isNotBlank() }
    private val now = Instant.now()

    @Before
    fun setUp() = assumeTrue(outDir != null)

    @After
    fun tearDown() {
        HealthConnectAccess.testClient = null
        HealthConnectAccess.testFeaturesAvailable = null
    }

    private fun launch(intent: Intent? = null): MainActivity {
        val controller = if (intent == null) Robolectric.buildActivity(MainActivity::class.java)
            else Robolectric.buildActivity(MainActivity::class.java, intent)
        return controller.setup().get().also { Robo.waitFor { true } }
    }

    private fun save(bitmap: Bitmap, name: String) {
        File(outDir!!).mkdirs()
        File(outDir, "$name.png").outputStream().use { bitmap.compress(Bitmap.CompressFormat.PNG, 100, it) }
    }

    /** The full page and the screenful at the current scroll position. */
    private fun capture(activity: MainActivity, name: String) {
        val root = activity.window.decorView
        val scroll = activity.findViewById<ScrollView>(R.id.scroll)
        val content = scroll.getChildAt(0)
        val width = root.width
        val height = content.height + scroll.paddingTop + scroll.paddingBottom
        val full = Bitmap.createBitmap(width, height, Bitmap.Config.ARGB_8888)
        val canvas = Canvas(full)
        canvas.drawColor(activity.getColor(R.color.screen_background))
        canvas.save()
        canvas.translate(content.left.toFloat(), scroll.paddingTop.toFloat())
        content.draw(canvas)
        canvas.restore()
        save(full, "$name-full")

        val screen = Bitmap.createBitmap(width, root.height, Bitmap.Config.ARGB_8888)
        root.draw(Canvas(screen))
        save(screen, name)
    }

    private fun captureDialog(activity: MainActivity, name: String) {
        val dialog = ShadowDialog.getLatestDialog() as AlertDialog
        Robo.idle()
        val root = activity.window.decorView
        val screen = Bitmap.createBitmap(root.width, root.height, Bitmap.Config.ARGB_8888)
        val canvas = Canvas(screen)
        root.draw(canvas)
        canvas.drawColor(Color.argb(140, 0, 0, 0))
        val decor = dialog.window!!.decorView
        canvas.translate(((root.width - decor.width) / 2).toFloat(), ((root.height - decor.height) / 2).toFloat())
        decor.draw(canvas)
        save(screen, name)
    }

    /** Saved connection, Health Connect granted (also in the background, as on the Pixel), a recent successful sync. */
    private fun healthy(background: Boolean = true) {
        val settings = Robo.settings()
        Robo.saveConnection(settings)
        HealthConnectAccess.testFeaturesAvailable = true
        HealthConnectAccess.testClient = FakeHealthConnectClient(
            permissionController = FakePermissionController(grantAll = false).apply {
                grantPermissions(
                    HealthConnectSync.readPermissions + HealthPermission.PERMISSION_READ_HEALTH_DATA_HISTORY +
                        (if (background) setOf(HealthPermission.PERMISSION_READ_HEALTH_DATA_IN_BACKGROUND) else emptySet()),
                )
            },
        )
        Robo.grantNotificationPermission()
        settings.notifyOnSyncFailure = true
        settings.lastStatus = "${now.minusSeconds(42 * 60)}：背景同步完成 · 新增 128 · 更新 6"
        settings.lastSleepStatus = "${now.minusSeconds(7 * 3600)}：睡眠同步完成 · 新增 1"
        settings.lastSuccessfulSyncMs = now.minusSeconds(42 * 60).toEpochMilli()
    }

    private fun recording() {
        shadowOf(Robo.app).grantPermissions(Manifest.permission.ACCESS_FINE_LOCATION, Manifest.permission.ACCESS_COARSE_LOCATION)
        LocationSettings(Robo.app).apply {
            trackingEnabled = true
            lastFix = LocationFix(now.minusSeconds(50).toEpochMilli(), 25.0330, 121.5654, accuracy = 18.0)
            lastUploadStatus = "${now.minusSeconds(9 * 60)}：已上傳 214 個定位點"
        }
    }

    @Test
    fun a01FirstRun() = capture(launch(), "01-first-run")

    @Test
    fun a02Healthy() {
        healthy()
        capture(launch(), "02-healthy")
    }

    @Test
    @Config(qualifiers = "w411dp-h891dp-night-xxhdpi")
    fun a03HealthyDark() {
        healthy()
        recording()
        capture(launch(), "03-healthy-dark")
    }

    @Test
    fun a04SyncFailing() {
        healthy()
        val settings = Robo.settings()
        settings.lastStatus = "${now.minusSeconds(3 * 3600)}：同步失敗：伺服器回應 502 Bad Gateway"
        settings.lastSyncFailed = true
        settings.backgroundFailures = 3
        settings.lastSuccessfulSyncMs = now.minusSeconds(26 * 3600).toEpochMilli()
        capture(launch(), "04-sync-failing")
    }

    @Test
    fun a05LocationRecording() {
        healthy()
        recording()
        val activity = launch(Intent(Robo.app, MainActivity::class.java).putExtra(MainActivity.EXTRA_OPEN_LOCATION, true))
        Robo.idle()
        capture(activity, "05-location-recording")
    }

    @Test
    fun a06InvalidForm() {
        val activity = launch()
        val inputs = Robo.descendants(activity.window.decorView).filterIsInstance<EditText>()
        inputs[0].setText("http://example.com")
        inputs[1].setText("short")
        Robo.button(activity.window.decorView, activity.getString(R.string.action_save_connection)).performClick()
        Robo.idle()
        activity.findViewById<ScrollView>(R.id.scroll).scrollTo(0, 0)
        Robo.idle()
        capture(activity, "06-invalid-form")
    }

    @Test
    fun a07UpdateOffer() {
        healthy()
        val activity = launch()
        val prompt = MainActivity::class.java.getDeclaredField("updates").apply { isAccessible = true }.get(activity) as UpdatePrompt
        val release = AppRelease("0.10.0", 27, "- 全新的 Material 3 介面\n- 同步失敗時直接顯示原因\n- 位置紀錄提醒重新開機後是否會繼續", "https://example.invalid/a.apk", 7_340_032, null)
        UpdatePrompt::class.java.getDeclaredMethod("offer", AppRelease::class.java).apply { isAccessible = true }.invoke(prompt, release)
        captureDialog(activity, "07-update-offer")
    }

    @Test
    fun a08LargeText() {
        RuntimeEnvironment.setFontScale(1.3f)
        healthy()
        recording()
        // Both data sections open, so the label/value rows are seen at the larger size.
        val activity = launch(Intent(Robo.app, MainActivity::class.java).putExtra(MainActivity.EXTRA_OPEN_HEALTH, true))
        Robo.sectionHeader(activity.window.decorView, activity.getString(R.string.section_location)).performClick()
        Robo.idle()
        activity.findViewById<ScrollView>(R.id.scroll).scrollTo(0, 0)
        Robo.idle()
        capture(activity, "08-large-text")
    }

    @Test
    fun a09BackgroundNotAllowed() {
        healthy(background = false)
        capture(launch(), "09-background-not-allowed")
    }

    @Test
    fun a10HugeText() {
        RuntimeEnvironment.setFontScale(2.0f)
        healthy()
        recording()
        val activity = launch(Intent(Robo.app, MainActivity::class.java).putExtra(MainActivity.EXTRA_OPEN_HEALTH, true))
        Robo.sectionHeader(activity.window.decorView, activity.getString(R.string.section_location)).performClick()
        Robo.idle()
        activity.findViewById<ScrollView>(R.id.scroll).scrollTo(0, 0)
        Robo.idle()
        capture(activity, "10-huge-text")
    }

    @Test
    fun a11TwoFixes() {
        // Health Connect background reading and background location both missing: one filled button.
        healthy(background = false)
        recording()
        val activity = launch()
        Robo.sectionHeader(activity.window.decorView, activity.getString(R.string.section_location)).performClick()
        Robo.idle()
        activity.findViewById<ScrollView>(R.id.scroll).scrollTo(0, 0)
        Robo.idle()
        capture(activity, "11-two-fixes")
    }

    @Test
    @Config(qualifiers = "w411dp-h891dp-night-xxhdpi")
    fun a12TwoFixesDark() {
        healthy(background = false)
        recording()
        val activity = launch()
        Robo.sectionHeader(activity.window.decorView, activity.getString(R.string.section_location)).performClick()
        Robo.idle()
        activity.findViewById<ScrollView>(R.id.scroll).scrollTo(0, 0)
        Robo.idle()
        capture(activity, "12-two-fixes-dark")
    }
}
