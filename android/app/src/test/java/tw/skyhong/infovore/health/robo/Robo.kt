package tw.skyhong.infovore.health.robo

import android.Manifest
import android.app.Application
import android.app.NotificationManager
import android.content.Context
import android.os.Looper
import android.view.View
import android.view.ViewGroup
import android.widget.TextView
import androidx.health.connect.client.testing.FakeHealthConnectClient
import androidx.health.connect.client.testing.FakePermissionController
import androidx.test.core.app.ApplicationProvider
import org.robolectric.Shadows.shadowOf
import org.robolectric.shadows.ShadowNotificationManager
import tw.skyhong.infovore.health.HealthConnectAccess
import tw.skyhong.infovore.health.HealthConnectSync
import tw.skyhong.infovore.health.SecureSettings
import java.util.concurrent.TimeUnit

/** Shared helpers of the Robolectric tests. Endpoints are reserved .example names: nothing real is ever contacted. */
object Robo {
    const val ENDPOINT = "https://infovore.example"
    const val HEALTH_TOKEN = "robolectric-health-token-0123456789abcdef"
    const val PHONE_TOKEN = "robolectric-phone-token-0123456789abcdef"

    val app: Application get() = ApplicationProvider.getApplicationContext()

    fun settings(): SecureSettings = SecureSettings(app)

    val notifications: NotificationManager get() = app.getSystemService(NotificationManager::class.java)

    val shadowNotifications: ShadowNotificationManager get() = shadowOf(notifications)

    fun grantNotificationPermission() = shadowOf(app).grantPermissions(Manifest.permission.POST_NOTIFICATIONS)

    fun denyNotificationPermission() = shadowOf(app).denyPermissions(Manifest.permission.POST_NOTIFICATIONS)

    /** An endpoint and Health Connect token are saved and the first full sync has finished. */
    fun saveConnection(settings: SecureSettings = settings()) {
        settings.endpoint = ENDPOINT
        settings.token = HEALTH_TOKEN
        settings.initialImportDone = true
    }

    /** Health Connect reports every read permission (and background reading) as granted. */
    fun grantHealthConnect() {
        HealthConnectAccess.testClient = FakeHealthConnectClient(
            permissionController = FakePermissionController(grantAll = false).apply {
                grantPermissions(HealthConnectSync.readPermissions)
            },
        )
    }

    /** Puts [count] records into the current destination's quarantine, as rejected uploads would. */
    fun fillQuarantine(count: Int) {
        val destination = tw.skyhong.infovore.health.DestinationChange.normalize(settings().endpoint)
        val dir = java.io.File(app.noBackupFilesDir, "screen-queue/rejected/" + tw.skyhong.infovore.health.screen.ObservationQueue.bucketName(destination))
        dir.mkdirs()
        val now = System.currentTimeMillis()
        repeat(count) { i -> java.io.File(dir, "${(now - i).toString().padStart(15, '0')}-r$i.json").writeText("{}") }
    }

    fun idle() = shadowOf(Looper.getMainLooper()).idle()

    /** Runs the main looper until [condition] holds; work on Dispatchers.IO finishes on its own threads. */
    fun waitFor(timeoutMs: Long = 5_000, condition: () -> Boolean) {
        val deadline = System.nanoTime() + TimeUnit.MILLISECONDS.toNanos(timeoutMs)
        while (true) {
            idle()
            if (condition()) return
            check(System.nanoTime() < deadline) { "condition not met within $timeoutMs ms" }
            Thread.sleep(10)
        }
    }

    fun descendants(root: View): List<View> = buildList {
        add(root)
        if (root is ViewGroup) for (i in 0 until root.childCount) addAll(descendants(root.getChildAt(i)))
    }

    /** The visible TextView (or Button) whose text contains [text]; fails when there is none. */
    fun textView(root: View, text: String): TextView =
        descendants(root).filterIsInstance<TextView>().firstOrNull { it.text?.toString()?.contains(text) == true && it.isShownOnScreen() }
            ?: error("no visible view with text containing \"$text\"")

    /** The visible Button labelled exactly [label]. */
    fun button(root: View, label: String): android.widget.Button =
        descendants(root).filterIsInstance<android.widget.Button>().firstOrNull { it.text?.toString() == label && it.isShown }
            ?: error("no visible button \"$label\"")

    /** The tappable header row of the collapsible section titled [title]. */
    fun sectionHeader(root: View, title: String): View =
        descendants(root).filterIsInstance<TextView>().firstOrNull { it.text?.toString() == title }?.parent?.parent as? View
            ?: error("no section \"$title\"")

    fun hasVisibleText(root: View, text: String): Boolean =
        descendants(root).filterIsInstance<TextView>().any { it.text?.toString()?.contains(text) == true && it.isShownOnScreen() }

    /** Visible: this view and all its ancestors are VISIBLE (not scrolled-to; the screen scrolls). */
    fun View.isShownOnScreen(): Boolean = isShown

    fun dp(context: Context, value: Int): Int = (value * context.resources.displayMetrics.density + 0.5f).toInt()
}
