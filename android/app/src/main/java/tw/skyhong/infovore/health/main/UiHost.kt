package tw.skyhong.infovore.health.main

import android.content.ActivityNotFoundException
import android.content.Intent
import android.text.format.DateFormat
import android.view.View
import android.widget.ScrollView
import android.widget.Toast
import androidx.appcompat.app.AlertDialog
import androidx.appcompat.app.AppCompatActivity
import tw.skyhong.infovore.health.DestinationChange
import tw.skyhong.infovore.health.MainViewModel
import tw.skyhong.infovore.health.R
import tw.skyhong.infovore.health.SecureSettings
import tw.skyhong.infovore.health.screen.ScreenSettings
import tw.skyhong.infovore.health.ui.DialogText
import tw.skyhong.infovore.health.ui.Field
import tw.skyhong.infovore.health.ui.ViewKit

/**
 * What every section controller of the main screen shares: the activity, settings, the view
 * kit and ViewModel, and small view helpers. Owns no section state.
 */
class UiHost(
    val activity: AppCompatActivity,
    val kit: ViewKit,
    val settings: SecureSettings,
    val screenSettings: ScreenSettings,
    val model: MainViewModel,
) {
    /** Set once the content is built. */
    lateinit var scroll: ScrollView

    val use24Hour: Boolean get() = DateFormat.is24HourFormat(activity)

    /** The normalised saved endpoint: where syncs and screen uploads go. */
    fun currentDestination(): String = DestinationChange.normalize(settings.endpoint)

    fun string(id: Int, vararg args: Any): String = activity.getString(id, *args)

    fun focusField(field: Field) {
        field.input.requestFocus()
        scrollTo(field.input)
    }

    fun scrollTo(view: View) {
        scroll.post {
            val rect = android.graphics.Rect()
            view.getDrawingRect(rect)
            scroll.offsetDescendantRectToMyCoords(view, rect)
            scroll.smoothScrollTo(0, (rect.top - kit.dp(24)).coerceAtLeast(0))
        }
    }

    fun openSafely(intent: Intent, showError: Boolean = true): Boolean = try {
        activity.startActivity(intent)
        true
    } catch (_: ActivityNotFoundException) {
        if (showError) toast(string(R.string.error_no_activity))
        false
    }

    fun toast(text: String) {
        Toast.makeText(activity, text, Toast.LENGTH_LONG).show()
    }

    /** A confirmation dialog with a cancel button; [onOk] runs only when confirmed. */
    fun confirm(text: DialogText, onOk: () -> Unit) {
        AlertDialog.Builder(activity)
            .setTitle(text.title)
            .setMessage(text.message)
            .setPositiveButton(text.ok) { _, _ -> onOk() }
            .setNegativeButton(R.string.action_cancel, null)
            .show()
    }
}
