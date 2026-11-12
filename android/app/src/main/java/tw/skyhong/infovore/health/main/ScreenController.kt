package tw.skyhong.infovore.health.main

import android.content.ComponentName
import android.content.Intent
import android.net.Uri
import android.provider.Settings
import android.view.Gravity
import android.view.View
import android.widget.Button
import android.widget.ProgressBar
import android.widget.TextView
import androidx.appcompat.app.AlertDialog
import androidx.appcompat.widget.SwitchCompat
import tw.skyhong.infovore.health.MainViewModel.ScreenTask
import tw.skyhong.infovore.health.R
import tw.skyhong.infovore.health.SyncFailureNotifier
import tw.skyhong.infovore.health.screen.Exclusions
import tw.skyhong.infovore.health.screen.ObservationQueue
import tw.skyhong.infovore.health.screen.ScreenActivityService
import tw.skyhong.infovore.health.screen.ScreenUploader
import tw.skyhong.infovore.health.ui.CollapsibleSection
import tw.skyhong.infovore.health.ui.DialogText
import tw.skyhong.infovore.health.ui.Field
import tw.skyhong.infovore.health.ui.FieldResult
import tw.skyhong.infovore.health.ui.FormState
import tw.skyhong.infovore.health.ui.InputValidation
import tw.skyhong.infovore.health.ui.SaveState
import tw.skyhong.infovore.health.ui.ScreenInputs
import tw.skyhong.infovore.health.ui.ScreenStatus
import tw.skyhong.infovore.health.ui.ScreenTaskPanel
import tw.skyhong.infovore.health.ui.SecretDrafts
import tw.skyhong.infovore.health.ui.Tone
import tw.skyhong.infovore.health.ui.ViewKit
import tw.skyhong.infovore.health.ui.ViewKit.Style
import tw.skyhong.infovore.health.ui.isValid
import tw.skyhong.infovore.health.ui.valueOrNull
import java.time.ZoneId

/**
 * The opt-in phone screen recorder section (sensitive, collapsed by default): token and
 * exclusions, the accessibility service, recording controls, uploads, and the records that
 * cannot be uploaded (earlier destinations, server rejections). Never turns recording or the
 * accessibility service on by itself and never triggers a capture.
 */
class ScreenController(
    private val host: UiHost,
    /** Unsaved edits changed: the activity re-evaluates its back handling. */
    private val onDirtyChanged: () -> Unit,
) {
    private val kit = host.kit
    private val screenSettings = host.screenSettings
    private val model = host.model

    lateinit var section: CollapsibleSection
        private set

    private lateinit var statusBox: TextView
    private lateinit var details: TextView
    private lateinit var phoneTokenField: Field
    private lateinit var exclusionsField: Field
    private lateinit var saveState: TextView
    private lateinit var accessibilityStatus: TextView
    private lateinit var recordingSwitch: SwitchCompat
    private lateinit var pauseButton: Button
    private lateinit var uploadButton: Button
    private lateinit var testButton: Button
    private lateinit var uploadHint: TextView
    private lateinit var progress: ProgressBar
    private lateinit var result: TextView
    private lateinit var retryButton: Button
    private lateinit var otherDestinationBox: TextView
    private lateinit var deleteOtherDestinationButton: Button
    private lateinit var rejectedBox: TextView
    private lateinit var requeueRejectedButton: Button
    private lateinit var deleteRejectedButton: Button

    private var justSaved = false
    private var updatingSwitch = false

    // Decrypted once and refreshed on save, so typing never triggers a Keystore operation per keystroke.
    private var savedPhoneToken = screenSettings.token

    /** Whether a phone token is saved (it is tied to the current destination). */
    val phoneTokenSaved: Boolean get() = savedPhoneToken.isNotEmpty()

    fun build(expanded: Boolean): CollapsibleSection {
        // Sensitive and opt-in: always starts collapsed unless the user had it open before a rotation.
        section = CollapsibleSection(kit, host.string(R.string.section_screen), expanded) { if (it) render() }
        section.add(kit.statusBox().apply {
            text = host.string(R.string.screen_warning)
            kit.setTone(this, Tone.WARNING)
            accessibilityLiveRegion = View.ACCESSIBILITY_LIVE_REGION_NONE
        }, 4)

        statusBox = kit.statusBox()
        section.add(statusBox, 12)
        details = kit.text(Style.CAPTION).apply {
            setTextIsSelectable(true)
            setPadding(kit.dp(4), kit.dp(6), 0, 0)
        }
        section.add(details)
        // Records left from an earlier destination: never uploaded, only deleted on request.
        otherDestinationBox = kit.statusBox().apply {
            visibility = View.GONE
            kit.setTone(this, Tone.WARNING)
        }
        section.add(otherDestinationBox, 8)
        deleteOtherDestinationButton = kit.secondaryButton(host.string(R.string.action_delete_other_destination)).apply {
            visibility = View.GONE
            setOnClickListener { confirmDeleteOtherDestination() }
        }
        section.add(deleteOtherDestinationButton, 4)
        // Records the server rejected (HTTP 400): quarantined, never sent automatically; the user
        // may put them back into the current destination's queue or delete them.
        rejectedBox = kit.statusBox().apply {
            visibility = View.GONE
            kit.setTone(this, Tone.WARNING)
        }
        section.add(rejectedBox, 8)
        requeueRejectedButton = kit.secondaryButton("").apply {
            visibility = View.GONE
            setOnClickListener { confirmRequeueRejected() }
        }
        section.add(requeueRejectedButton, 4)
        deleteRejectedButton = kit.secondaryButton(host.string(R.string.action_delete_rejected)).apply {
            visibility = View.GONE
            setOnClickListener { confirmDeleteRejected() }
        }
        section.add(deleteRejectedButton, 4)

        // Step 1: token and exclusions
        section.add(kit.heading(Style.SUBHEAD, host.string(R.string.screen_step_settings)), 20)
        phoneTokenField = kit.field(
            R.id.phone_token_input, host.string(R.string.label_phone_token), ViewKit.InputKind.SECRET, host.string(R.string.help_phone_token),
        )
        exclusionsField = kit.field(
            R.id.exclusions_input,
            host.string(R.string.label_exclusions),
            ViewKit.InputKind.MULTILINE,
            host.string(R.string.help_exclusions, Exclusions.DEFAULT_PACKAGES.size),
        ).apply { input.hint = "com.example.bank" }
        // Unsaved token edits come back from the ViewModel after a rotation; never from the Bundle.
        phoneTokenField.setValue(model.drafts.valueOr(SecretDrafts.Key.PHONE_TOKEN, savedPhoneToken))
        exclusionsField.setValue(screenSettings.exclusionsText)
        for (field in listOf(phoneTokenField, exclusionsField)) {
            section.add(field.input.parent as View)
            field.onChange {
                justSaved = false
                if (field == phoneTokenField) model.drafts.update(SecretDrafts.Key.PHONE_TOKEN, field.value, savedPhoneToken)
                field.clearErrorIfAny()
                renderSaveState()
                onDirtyChanged()
            }
            field.input.setOnFocusChangeListener { _, focused ->
                if (!focused && field.value.isNotBlank()) field.show(validate(field))
            }
        }
        section.add(kit.primaryButton(host.string(R.string.action_save_screen)).apply {
            setOnClickListener { save(showSuccess = true) }
        }, 16)
        saveState = kit.liveText(Style.CAPTION).apply { setPadding(kit.dp(4), kit.dp(8), 0, 0) }
        section.add(saveState)

        // Step 2: accessibility service (the user enables it in system settings; the app never does)
        section.add(kit.heading(Style.SUBHEAD, host.string(R.string.screen_step_service)), 20)
        accessibilityStatus = kit.liveText().apply { setPadding(0, kit.dp(4), 0, 0) }
        section.add(accessibilityStatus)
        section.add(kit.text(Style.CAPTION, host.string(R.string.screen_restricted_help)), 4)
        section.add(kit.textButton(host.string(R.string.action_open_app_info)).apply {
            gravity = Gravity.START or Gravity.CENTER_VERTICAL
            setOnClickListener {
                host.openSafely(Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.fromParts("package", host.activity.packageName, null)))
            }
        })
        section.add(kit.secondaryButton(host.string(R.string.action_open_accessibility)).apply {
            setOnClickListener { host.openSafely(Intent(Settings.ACTION_ACCESSIBILITY_SETTINGS)) }
        }, 4)

        // Step 3: recording controls
        section.add(kit.heading(Style.SUBHEAD, host.string(R.string.screen_step_recording)), 20)
        recordingSwitch = SwitchCompat(host.activity).apply {
            text = host.string(R.string.label_recording_switch)
            textSize = 16f
            minHeight = kit.dp(48)
            isChecked = screenSettings.enabled
            setOnCheckedChangeListener { _, checked -> onRecordingSwitch(checked) }
        }
        section.add(recordingSwitch, 4)
        pauseButton = kit.secondaryButton("").apply {
            setOnClickListener {
                screenSettings.pausedUntil = if (screenSettings.isPaused()) 0L else System.currentTimeMillis() + PAUSE_MS
                render()
            }
        }
        section.add(pauseButton, 4)

        // Upload
        section.add(kit.heading(Style.SUBHEAD, host.string(R.string.screen_upload_heading)), 20)
        section.add(kit.text(Style.CAPTION, host.string(R.string.screen_upload_note)), 4)
        uploadButton = kit.secondaryButton(host.string(R.string.action_upload_now)).apply {
            setOnClickListener { if (ensureSaved()) model.uploadScreen() }
        }
        section.add(uploadButton, 8)
        testButton = kit.secondaryButton(host.string(R.string.action_test_connection)).apply {
            setOnClickListener { if (ensureSaved()) model.testScreenConnection(host.use24Hour) }
        }
        section.add(testButton, 4)
        uploadHint = kit.liveText(Style.CAPTION).apply { setPadding(kit.dp(4), kit.dp(4), 0, 0) }
        section.add(uploadHint)
        progress = kit.progress(host.string(R.string.screen_task_in_progress))
        section.add(progress, 8)
        result = kit.statusBox().apply {
            visibility = View.GONE
            setTextIsSelectable(true)
        }
        section.add(result, 8)
        retryButton = kit.secondaryButton(host.string(R.string.action_retry)).apply {
            visibility = View.GONE
            setOnClickListener {
                when (model.screen.value.failed) {
                    ScreenTask.UPLOAD -> uploadButton.performClick()
                    ScreenTask.TEST -> testButton.performClick()
                    null -> Unit
                }
            }
        }
        section.add(retryButton, 4)
        return section
    }

    fun validate(field: Field): FieldResult<*> = when (field) {
        phoneTokenField -> InputValidation.token(field.value, "DAYFLOW_PHONE_TOKEN", required = false)
        exclusionsField -> InputValidation.exclusions(field.value)
        else -> FieldResult.Valid(field.value)
    }

    fun dirty(): Boolean =
        phoneTokenField.value.trim() != savedPhoneToken ||
            exclusionsField.value.trim() != screenSettings.exclusionsText

    fun save(showSuccess: Boolean): Boolean {
        val token = InputValidation.token(phoneTokenField.value, "DAYFLOW_PHONE_TOKEN", required = false)
        val exclusions = InputValidation.exclusions(exclusionsField.value)
        phoneTokenField.show(token)
        exclusionsField.show(exclusions)
        val invalid = listOf(phoneTokenField to token, exclusionsField to exclusions).firstOrNull { !it.second.isValid }
        if (invalid != null) {
            section.setExpanded(true)
            host.focusField(invalid.first)
            saveState.text = host.string(R.string.save_state_fix_errors)
            kit.setTone(saveState, Tone.ERROR, tintBackground = false)
            return false
        }
        savedPhoneToken = requireNotNull(token.valueOrNull())
        // Bound to the destination saved right now; uploads never send it anywhere else.
        screenSettings.saveToken(savedPhoneToken, host.currentDestination())
        model.drafts.clear(SecretDrafts.Key.PHONE_TOKEN)
        screenSettings.exclusionsText = requireNotNull(exclusions.valueOrNull())
        if (phoneTokenField.value != savedPhoneToken) phoneTokenField.setValue(savedPhoneToken)
        justSaved = showSuccess
        render()
        return true
    }

    /**
     * The sync destination changed (under the upload lock, which already cleared the saved
     * token): the old destination's phone token and its unsaved draft are dropped here too.
     */
    fun forgetTokenForNewDestination() {
        savedPhoneToken = ""
        model.drafts.clear(SecretDrafts.Key.PHONE_TOKEN)
        if (phoneTokenField.value.isNotEmpty()) phoneTokenField.setValue("")
    }

    /** Upload and connection test use saved values; pending edits are validated and saved first. */
    private fun ensureSaved(): Boolean = !dirty() || save(showSuccess = false)

    private fun renderSaveState() {
        val state = FormState.screen(dirty(), justSaved)
        saveState.text = when (state) {
            SaveState.UNSAVED -> host.string(R.string.save_state_unsaved)
            SaveState.JUST_SAVED, SaveState.SAVED_NEW_DESTINATION -> host.string(
                R.string.screen_saved, screenSettings.exclusions.size, Exclusions.DEFAULT_PACKAGES.size,
            )
            SaveState.CLEAN, SaveState.INCOMPLETE -> host.string(R.string.save_state_clean)
        }
        if (state.tone == Tone.NEUTRAL) saveState.setTextColor(kit.color(R.color.text_secondary)) else kit.setTone(saveState, state.tone, tintBackground = false)
    }

    fun render() {
        if (!::statusBox.isInitialized) return
        val serviceEnabled = isServiceEnabled()
        val queue = ObservationQueue.get(host.activity)
        val destination = host.currentDestination()
        val tokenUsable = savedPhoneToken.length >= InputValidation.MIN_TOKEN_LENGTH &&
            screenSettings.tokenDestination == destination
        val ui = ScreenStatus.map(
            ScreenInputs(
                recordingEnabled = screenSettings.enabled,
                pausedUntilMs = screenSettings.pausedUntil,
                serviceEnabled = serviceEnabled,
                tokenConfigured = tokenUsable,
                pending = queue.count(destination),
                lastCaptureAtMs = screenSettings.lastCaptureAt,
                lastUploadStatus = screenSettings.lastUploadStatus,
                nowMs = System.currentTimeMillis(),
                zone = ZoneId.systemDefault(),
                use24Hour = host.use24Hour,
                otherDestinationPending = queue.countOtherDestinations(destination),
                rejected = queue.countRejected(),
                requeueable = queue.countRequeueable(destination),
                notificationsOn = host.settings.notifyOnSyncFailure && SyncFailureNotifier.permissionGranted(host.activity),
            ),
        )
        rejectedBox.text = listOfNotNull(ui.rejectedNote, ui.notificationHint).joinToString("\n\n")
        rejectedBox.visibility = if (ui.rejectedNote == null) View.GONE else View.VISIBLE
        kit.setTone(rejectedBox, if (ui.quarantineFull) Tone.ERROR else Tone.WARNING)
        deleteRejectedButton.visibility = rejectedBox.visibility
        requeueRejectedButton.text = ui.requeueLabel
        requeueRejectedButton.visibility = if (ui.requeueLabel == null) View.GONE else View.VISIBLE
        otherDestinationBox.text = ui.otherDestinationNote
        otherDestinationBox.visibility = if (ui.otherDestinationNote == null) View.GONE else View.VISIBLE
        deleteOtherDestinationButton.visibility = otherDestinationBox.visibility
        statusBox.text = listOfNotNull(ui.headline, ui.nextStep).joinToString("\n")
        kit.setTone(statusBox, ui.tone)
        details.text = ui.details
        section.setSummary(
            ui.summary,
            when {
                ui.quarantineFull -> Tone.WARNING
                ui.tone == Tone.OK -> Tone.OK
                else -> Tone.NEUTRAL
            },
        )

        accessibilityStatus.text = host.string(if (serviceEnabled) R.string.accessibility_on else R.string.accessibility_off)
        kit.setTone(accessibilityStatus, if (serviceEnabled) Tone.OK else Tone.NEUTRAL, tintBackground = false)

        updatingSwitch = true
        recordingSwitch.isChecked = screenSettings.enabled
        updatingSwitch = false
        pauseButton.text = ui.pauseLabel
        pauseButton.isEnabled = ui.pauseEnabled

        val task = model.screen.value
        val panel = ScreenTaskPanel.map(task, uploadAllowed = ui.uploadEnabled, tokenUsable = tokenUsable)
        uploadButton.isEnabled = panel.uploadEnabled
        testButton.isEnabled = panel.testEnabled
        uploadHint.text = ui.uploadHint
        uploadHint.visibility = if (ui.uploadHint == null) View.GONE else View.VISIBLE
        progress.visibility = if (panel.progressVisible) View.VISIBLE else View.GONE
        result.visibility = if (panel.resultVisible) View.VISIBLE else View.GONE
        result.text = when (panel.running) {
            ScreenTask.UPLOAD -> host.string(R.string.screen_uploading)
            ScreenTask.TEST -> host.string(R.string.screen_testing)
            null -> task.result
        }
        kit.setTone(result, panel.tone)
        retryButton.visibility = if (panel.retryVisible) View.VISIBLE else View.GONE
        renderSaveState()
    }

    private fun onRecordingSwitch(checked: Boolean) {
        if (updatingSwitch) return
        if (!checked) {
            screenSettings.enabled = false
            render()
            return
        }
        // Turning recording on is always an explicit, confirmed user choice.
        AlertDialog.Builder(host.activity)
            .setTitle(R.string.confirm_recording_title)
            .setMessage(R.string.confirm_recording_message)
            .setPositiveButton(R.string.confirm_recording_ok) { _, _ ->
                screenSettings.enabled = true
                render()
            }
            .setNegativeButton(R.string.action_cancel, null)
            .setOnDismissListener { render() }
            .show()
    }

    /** Deletes, after confirmation, the queued records of earlier destinations. Never migrates them. */
    private fun confirmDeleteOtherDestination() {
        val count = ObservationQueue.get(host.activity).countOtherDestinations(host.currentDestination())
        if (count == 0) {
            render()
            return
        }
        host.confirm(
            DialogText(
                host.string(R.string.delete_other_destination_title),
                host.string(R.string.delete_other_destination_message, count),
                host.string(R.string.delete_other_destination_ok),
            ),
        ) {
            val removed = ScreenUploader.deleteOtherDestinations(host.activity)
            host.toast(
                if (removed == null) host.string(R.string.delete_other_destination_busy)
                else host.string(R.string.delete_other_destination_done, removed),
            )
            render()
        }
    }

    /**
     * Puts, after confirmation, the rejected records of the current destination back into its
     * upload queue. Records of another destination (or quarantined before 0.4.1) never go back.
     */
    private fun confirmRequeueRejected() {
        val queue = ObservationQueue.get(host.activity)
        val count = queue.countRequeueable(host.currentDestination())
        if (count == 0) {
            render()
            return
        }
        val others = queue.countRejected() - count
        host.confirm(
            DialogText(
                host.string(R.string.requeue_rejected_title),
                host.string(R.string.requeue_rejected_message, count) +
                    if (others > 0) host.string(R.string.requeue_rejected_others, others) else "",
                host.string(R.string.requeue_rejected_ok),
            ),
        ) {
            val moved = ScreenUploader.requeueRejected(host.activity)
            host.toast(
                if (moved == null) host.string(R.string.screen_records_busy)
                else host.string(R.string.requeue_rejected_done, moved),
            )
            render()
        }
    }

    /** Deletes, after confirmation, the records the server rejected. Never re-sends them. */
    private fun confirmDeleteRejected() {
        val count = ObservationQueue.get(host.activity).countRejected()
        if (count == 0) {
            render()
            return
        }
        host.confirm(
            DialogText(
                host.string(R.string.delete_rejected_title),
                host.string(R.string.delete_rejected_message, count),
                host.string(R.string.delete_other_destination_ok),
            ),
        ) {
            val removed = ScreenUploader.deleteRejected(host.activity)
            host.toast(
                if (removed == null) host.string(R.string.delete_other_destination_busy)
                else host.string(R.string.delete_rejected_done, removed),
            )
            render()
        }
    }

    private fun isServiceEnabled(): Boolean {
        val expected = ComponentName(host.activity, ScreenActivityService::class.java)
        val enabled = Settings.Secure.getString(host.activity.contentResolver, Settings.Secure.ENABLED_ACCESSIBILITY_SERVICES).orEmpty()
        return enabled.split(':').any { ComponentName.unflattenFromString(it) == expected }
    }

    private companion object {
        const val PAUSE_MS = 60 * 60_000L
    }
}
