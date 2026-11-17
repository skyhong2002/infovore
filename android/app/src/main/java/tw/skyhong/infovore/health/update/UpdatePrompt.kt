package tw.skyhong.infovore.health.update

import com.google.android.material.dialog.MaterialAlertDialogBuilder
import android.content.Context
import android.content.Intent
import androidx.core.net.toUri
import android.provider.Settings
import android.text.format.Formatter
import android.widget.ProgressBar
import android.widget.TextView
import android.widget.Toast
import androidx.appcompat.app.AlertDialog
import androidx.appcompat.app.AppCompatActivity
import androidx.core.content.edit
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.lifecycleScope
import androidx.lifecycle.repeatOnLifecycle
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import tw.skyhong.infovore.health.BuildConfig
import tw.skyhong.infovore.health.R
import tw.skyhong.infovore.health.ui.ViewKit

/**
 * Asks whether to update when a newer GitHub release exists. [checkAutomatically] runs when the
 * app opens (at most every [CHECK_INTERVAL_MS]; "稍後" quiets that version for [SNOOZE_MS]);
 * [checkNow] is the settings screen's "檢查更新". "更新" downloads and installs it
 * ([UpdateInstaller]), first sending the user to allow "安裝未知應用程式" when needed.
 */
class UpdatePrompt(private val activity: AppCompatActivity) {
    private val preferences = activity.getSharedPreferences(PREFERENCES, Context.MODE_PRIVATE)
    private var dialog: AlertDialog? = null
    private var checking = false

    init {
        activity.lifecycleScope.launch {
            activity.repeatOnLifecycle(Lifecycle.State.STARTED) {
                UpdateInstaller.state.collect(::show)
            }
        }
    }

    /** From onResume: continues an update waiting for "安裝未知應用程式". */
    fun onResume() = resumePendingInstall()

    /** From the launch screen's onResume: also looks for a newer release, at most every [CHECK_INTERVAL_MS]. */
    fun checkAutomatically() {
        resumePendingInstall()
        val now = System.currentTimeMillis()
        if (now - preferences.getLong(KEY_LAST_CHECK, 0) < CHECK_INTERVAL_MS) return
        lookUp(manual = false)
    }

    fun checkNow() = lookUp(manual = true)

    private fun lookUp(manual: Boolean) {
        val busy = UpdateInstaller.state.value.let { it is UpdateInstaller.State.Downloading || it is UpdateInstaller.State.Installing }
        if (checking || busy) return
        checking = true
        activity.lifecycleScope.launch {
            val result = withContext(Dispatchers.IO) { runCatching { UpdateChecker.fetch() } }
            checking = false
            if (!activity.lifecycle.currentState.isAtLeast(Lifecycle.State.STARTED)) return@launch
            val releases = result.getOrElse {
                if (manual) toast(activity.getString(R.string.update_check_failed))
                return@launch
            }
            preferences.edit { putLong(KEY_LAST_CHECK, System.currentTimeMillis()) }
            val release = UpdateChecker.newest(releases, BuildConfig.VERSION_CODE)
            when {
                release == null -> if (manual) toast(activity.getString(R.string.update_latest, BuildConfig.VERSION_NAME))
                !manual && snoozed(release) -> Unit
                else -> offer(release)
            }
        }
    }

    private fun snoozed(release: AppRelease): Boolean =
        preferences.getInt(KEY_SNOOZED_CODE, 0) == release.versionCode &&
            System.currentTimeMillis() < preferences.getLong(KEY_SNOOZED_UNTIL, 0)

    private fun offer(release: AppRelease) {
        dialog?.dismiss()
        val size = if (release.sizeBytes > 0) Formatter.formatShortFileSize(activity, release.sizeBytes) else null
        // The version change leads (primary color, medium); the notes follow under their heading.
        val message = android.text.SpannableStringBuilder()
        val primary = androidx.core.content.ContextCompat.getColor(activity, R.color.text_primary)
        fun emphasized(text: String) {
            val start = message.length
            message.append(text)
            message.setSpan(android.text.style.ForegroundColorSpan(primary), start, message.length, android.text.Spanned.SPAN_EXCLUSIVE_EXCLUSIVE)
            message.setSpan(android.text.style.TypefaceSpan(android.graphics.Typeface.create(android.graphics.Typeface.DEFAULT, 500, false)), start, message.length, android.text.Spanned.SPAN_EXCLUSIVE_EXCLUSIVE)
        }
        emphasized(activity.getString(R.string.update_offer_message, BuildConfig.VERSION_NAME, release.versionName))
        if (size != null) message.append(activity.getString(R.string.update_offer_size, size))
        if (release.notes.isNotBlank()) {
            message.append("\n\n")
            emphasized(activity.getString(R.string.update_notes_heading))
            message.append("\n")
            // Notes in the normal text color; a wrapped item hangs under its text, not under the bullet.
            val bullet = "• "
            val indent = android.text.TextPaint().apply {
                textSize = 16f * activity.resources.displayMetrics.scaledDensity
            }.measureText(bullet).toInt()
            release.notes.take(800).lines().forEachIndexed { index, raw ->
                if (index > 0) message.append("\n")
                val line = raw.trim().replaceFirst(Regex("^[-*] "), bullet)
                val start = message.length
                message.append(line)
                message.setSpan(android.text.style.ForegroundColorSpan(primary), start, message.length, android.text.Spanned.SPAN_EXCLUSIVE_EXCLUSIVE)
                if (line.startsWith(bullet)) {
                    message.setSpan(android.text.style.LeadingMarginSpan.Standard(0, indent), start, message.length, android.text.Spanned.SPAN_EXCLUSIVE_EXCLUSIVE)
                }
            }
        }
        dialog = MaterialAlertDialogBuilder(activity)
            .setTitle(activity.getString(R.string.update_offer_title))
            .setMessage(message)
            .setPositiveButton(R.string.update_action_install) { _, _ -> install(release) }
            .setNegativeButton(R.string.update_action_later) { _, _ ->
                preferences.edit {
                    putInt(KEY_SNOOZED_CODE, release.versionCode)
                    putLong(KEY_SNOOZED_UNTIL, System.currentTimeMillis() + SNOOZE_MS)
                }
            }
            .show()
    }

    private fun install(release: AppRelease) {
        if (!UpdateInstaller.canInstall(activity)) {
            // Remember it: coming back from the settings page continues the update.
            pending = release
            dialog = MaterialAlertDialogBuilder(activity)
                .setTitle(R.string.update_permission_title)
                .setMessage(R.string.update_permission_message)
                .setPositiveButton(R.string.update_permission_open) { _, _ ->
                    try {
                        activity.startActivity(Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES, "package:${activity.packageName}".toUri()))
                    } catch (_: android.content.ActivityNotFoundException) {
                        toast(activity.getString(R.string.error_no_activity))
                    }
                }
                .setNegativeButton(R.string.action_cancel) { _, _ -> pending = null }
                .show()
            return
        }
        pending = null
        UpdateInstaller.start(activity, release)
    }

    private fun resumePendingInstall() {
        val release = pending ?: return
        if (UpdateInstaller.canInstall(activity)) install(release)
    }

    private fun show(state: UpdateInstaller.State) {
        when (state) {
            is UpdateInstaller.State.Downloading -> progress(state)
            is UpdateInstaller.State.Installing -> {
                dialog?.dismiss()
                dialog = null
            }
            is UpdateInstaller.State.Failed -> {
                dialog?.dismiss()
                dialog = MaterialAlertDialogBuilder(activity)
                    .setTitle(R.string.update_failed_title)
                    .setMessage(state.message)
                    .setPositiveButton(android.R.string.ok, null)
                    .setOnDismissListener { UpdateInstaller.reset() }
                    .show()
            }
            UpdateInstaller.State.Idle -> Unit
        }
    }

    private var progressText: TextView? = null
    private var progressBar: ProgressBar? = null

    private fun progress(state: UpdateInstaller.State.Downloading) {
        val text = if (state.percent == null) activity.getString(R.string.update_downloading, state.release.versionName)
            else activity.getString(R.string.update_downloading_percent, state.release.versionName, state.percent)
        val current = dialog
        if (current != null && current.isShowing && progressText != null) {
            progressText?.text = text
            progressBar?.isIndeterminate = state.percent == null
            state.percent?.let { progressBar?.progress = it }
            return
        }
        val kit = ViewKit(activity)
        val bar = com.google.android.material.progressindicator.LinearProgressIndicator(activity).apply {
            max = 100
            isIndeterminate = state.percent == null
            progress = state.percent ?: 0
        }
        val label = kit.liveText().apply { this.text = text }
        val body = kit.column().apply {
            setPadding(kit.dp(24), kit.dp(16), kit.dp(24), 0)
            addView(label)
            addView(bar, ViewKit.matchWrap(kit.dp(12)))
        }
        progressText = label
        progressBar = bar
        current?.dismiss()
        dialog = MaterialAlertDialogBuilder(activity)
            .setTitle(R.string.update_progress_title)
            .setView(body)
            .setCancelable(false)
            .setNegativeButton(R.string.action_cancel) { _, _ -> UpdateInstaller.cancel() }
            .setOnDismissListener { progressText = null; progressBar = null }
            .show()
    }

    private fun toast(text: String) = Toast.makeText(activity, text, Toast.LENGTH_LONG).show()

    companion object {
        private const val PREFERENCES = "infovore_update"
        private const val KEY_LAST_CHECK = "last_check_ms"
        private const val KEY_SNOOZED_CODE = "snoozed_code"
        private const val KEY_SNOOZED_UNTIL = "snoozed_until_ms"
        const val CHECK_INTERVAL_MS = 3 * 3_600_000L
        const val SNOOZE_MS = 24 * 3_600_000L

        /** The release waiting for "安裝未知應用程式" to be allowed (kept across the settings round trip). */
        @Volatile
        private var pending: AppRelease? = null
    }
}
