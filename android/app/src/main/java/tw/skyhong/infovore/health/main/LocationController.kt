package tw.skyhong.infovore.health.main

import android.Manifest
import android.content.Intent
import android.net.Uri
import android.provider.Settings
import android.view.View
import android.widget.Button
import android.widget.LinearLayout
import android.widget.TextView
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.widget.SwitchCompat
import androidx.core.net.toUri
import androidx.lifecycle.lifecycleScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import tw.skyhong.infovore.health.R
import tw.skyhong.infovore.health.location.LocationQueue
import tw.skyhong.infovore.health.location.LocationSettings
import tw.skyhong.infovore.health.location.LocationTracking
import tw.skyhong.infovore.health.location.LocationUploader
import tw.skyhong.infovore.health.location.TimelineImporter
import tw.skyhong.infovore.health.ui.CollapsibleSection
import tw.skyhong.infovore.health.ui.LocationPanel
import tw.skyhong.infovore.health.ui.LocationState
import tw.skyhong.infovore.health.ui.TimeText
import tw.skyhong.infovore.health.ui.Tone
import tw.skyhong.infovore.health.ui.ViewKit.Style
import java.text.NumberFormat
import java.time.Instant
import java.time.ZoneId
import java.util.Locale

/**
 * The "位置紀錄" section: the location recorder switch and its permissions, the latest fix and
 * upload, and importing a Google Maps Timeline export. Recording and uploads run in
 * [tw.skyhong.infovore.health.location.LocationTrackingService] and WorkManager, imports in
 * [TimelineImporter]; this only starts them and shows their state.
 */
class LocationController(
    private val host: UiHost,
    private val connectionReady: () -> Boolean,
    /** Whether this section offers a fix button changed: the page keeps one filled button. */
    private val onFixChanged: (Boolean) -> Unit = {},
    /** The health section's fix is showing: it is the page's one filled button, this one is tonal. */
    private val fixOfferedElsewhere: () -> Boolean = { false },
) {
    /** "允許背景位置" is showing (the page's one filled button). */
    var fixOffered = false
        private set
    private val kit = host.kit
    private val activity = host.activity
    private val location = LocationSettings(activity)
    private val queue = LocationQueue(activity)

    lateinit var section: CollapsibleSection
        private set

    private lateinit var backgroundNote: TextView
    private lateinit var queueText: TextView
    private lateinit var uploadRow: View
    private lateinit var connectionNote: TextView
    private lateinit var statusBox: TextView
    private lateinit var trackSwitch: SwitchCompat
    private lateinit var accuracySwitch: SwitchCompat
    private lateinit var backgroundButton: Button
    private lateinit var lastFixText: TextView
    private lateinit var mapButton: Button
    private lateinit var uploadText: TextView
    private lateinit var uploadButton: Button
    private lateinit var importButton: Button
    private lateinit var cancelImportButton: Button
    private lateinit var importText: TextView
    private var queued = 0
    private var rendering = false
    private var uploading = false
    private var permissionDenied = false

    private val locationPermission = activity.registerForActivityResult(ActivityResultContracts.RequestMultiplePermissions()) { result ->
        if (result[Manifest.permission.ACCESS_FINE_LOCATION] == true) {
            permissionDenied = false
            LocationTracking.enable(activity)
        } else {
            permissionDenied = true
        }
        render()
    }

    private val backgroundPermission = activity.registerForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
        // Android may not show its page again after repeated refusals: open the app's settings instead.
        if (!granted && !activity.shouldShowRequestPermissionRationale(Manifest.permission.ACCESS_BACKGROUND_LOCATION)) openAppSettings()
        render()
    }

    private val pickExport = activity.registerForActivityResult(ActivityResultContracts.OpenDocument()) { uri: Uri? ->
        if (uri != null && !TimelineImporter.start(activity, uri)) host.toast(host.string(R.string.location_import_busy))
        render()
    }

    fun build(expanded: Boolean): CollapsibleSection {
        section = CollapsibleSection(kit, host.string(R.string.section_location), expanded)
        // Recording without "一律允許" stops at the next reboot: a warning with its fix, at the top
        // like the health section's.
        backgroundNote = kit.statusBox().apply {
            text = host.string(R.string.location_background_note)
            kit.setTone(this, Tone.WARNING)
            // The header carries the warning; the box explains, in the normal text color.
            setTextColor(kit.color(R.color.text_primary))
        }
        section.add(backgroundNote, 4)
        // The fix is the one filled button in this section, as in the health section.
        backgroundButton = kit.primaryButton(host.string(R.string.location_background_action)).apply {
            setOnClickListener { backgroundPermission.launch(Manifest.permission.ACCESS_BACKGROUND_LOCATION) }
        }
        section.add(backgroundButton, 10)
        // The switches together; what each does right under it.
        trackSwitch = switch(host.string(R.string.location_track_switch)) { checked -> onTrackSwitch(checked) }
        section.add(trackSwitch, 8)
        statusBox = kit.liveText(Style.CAPTION)
        section.add(statusBox)
        accuracySwitch = switch(host.string(R.string.location_accuracy_switch)) { checked ->
            location.highAccuracy = checked
            // The service reads the setting when it starts listening: restart it to apply.
            LocationTracking.restart(activity)
        }
        section.add(accuracySwitch, 16)
        section.add(kit.text(Style.CAPTION, host.string(R.string.location_accuracy_note)))

        section.add(kit.heading(Style.SUBHEAD, host.string(R.string.location_last_heading)), 20)
        lastFixText = kit.liveText()
        section.add(kit.labelRow(host.string(R.string.location_label_fix), lastFixText), 8)
        queueText = kit.text(Style.BODY)
        section.add(kit.labelRow(host.string(R.string.location_label_queue), queueText), 8)
        uploadText = kit.liveText()
        uploadRow = kit.labelRow(host.string(R.string.location_label_upload), uploadText)
        section.add(uploadRow, 8)
        connectionNote = kit.text(Style.CAPTION, host.string(R.string.location_needs_connection)).apply {
            kit.setTone(this, Tone.WARNING, tintBackground = false)
        }
        section.add(connectionNote, 6)
        mapButton = kit.textButton(host.string(R.string.location_open_map), inline = true).apply { setOnClickListener { openLastFix() } }
        val webButton = kit.textButton(host.string(R.string.location_open_web), inline = true).apply { setOnClickListener { openWeb() } }
        // Both open another app: the trailing "open in new" icon says so.
        for (link in listOf(mapButton, webButton)) {
            (link as com.google.android.material.button.MaterialButton).apply {
                setIconResource(R.drawable.ic_open_in_new)
                iconGravity = com.google.android.material.button.MaterialButton.ICON_GRAVITY_TEXT_END
                iconPadding = kit.dp(4)
                // Scales with the text (the drawable's 18dp would shrink beside 2.0× text).
                iconSize = (textSize * 0.9f).toInt()
            }
        }
        section.add(kit.linkRow(mapButton, webButton), 4)
        uploadButton = kit.secondaryButton(host.string(R.string.location_upload_now)).apply { setOnClickListener { uploadNow() } }
        section.add(uploadButton, 4)

        // A separate, one-off job: set apart from the live status above by a divider and its own heading.
        section.add(kit.divider(), 12)
        section.add(kit.heading(Style.BODY, host.string(R.string.location_import_heading)).apply { typeface = kit.medium }, 16)
        section.add(kit.text(Style.CAPTION, host.string(R.string.location_import_help, TimeText.unbreakable(host.string(R.string.location_import_path)))), 4)
        // The import's current status sits with its explanation, above the action.
        importText = kit.liveText(Style.CAPTION)
        section.add(importText, 4)
        // Optional, never a fix: outlined, so a tonal fix in this card always outranks it.
        importButton = kit.outlinedButton(host.string(R.string.location_import_action)).apply {
            setOnClickListener { pickExport.launch(arrayOf("application/json", "application/octet-stream", "text/plain", "*/*")) }
        }
        section.add(importButton, 12)
        cancelImportButton = kit.textButton(host.string(R.string.location_import_cancel), inline = true).apply {
            setOnClickListener { TimelineImporter.cancel() }
        }
        section.add(cancelImportButton, 4)
        return section
    }

    private fun switch(label: String, onChange: (Boolean) -> Unit) = kit.switch(label).apply {
        setOnCheckedChangeListener { _, checked -> if (!rendering) onChange(checked) }
    }

    /** Collects the recorder's and the importer's changes while the screen is started. */
    fun observe(scope: kotlinx.coroutines.CoroutineScope) {
        scope.launch { LocationTracking.changes.collect { refreshQueue() } }
        scope.launch { TimelineImporter.state.collect { render() } }
    }

    private suspend fun refreshQueue() {
        queued = withContext(Dispatchers.IO) { queue.size() }
        render()
    }

    fun resume() {
        LocationTracking.resumeIfEnabled(activity)
        activity.lifecycleScope.launch { refreshQueue() }
    }

    private fun onTrackSwitch(checked: Boolean) {
        if (!checked) {
            LocationTracking.disable(activity)
        } else if (LocationTracking.foregroundGranted(activity)) {
            LocationTracking.enable(activity)
        } else {
            locationPermission.launch(arrayOf(Manifest.permission.ACCESS_FINE_LOCATION, Manifest.permission.ACCESS_COARSE_LOCATION))
        }
        render()
    }

    private fun uploadNow() {
        if (uploading) return
        uploading = true
        render()
        activity.lifecycleScope.launch {
            withContext(Dispatchers.IO) { LocationUploader.uploadAndRecord(activity) }
            uploading = false
            refreshQueue()
        }
    }

    fun render() {
        if (!::statusBox.isInitialized) return
        val importState = TimelineImporter.state.value
        val ui = LocationPanel.map(
            enabled = location.trackingEnabled,
            fineGranted = LocationTracking.foregroundGranted(activity),
            backgroundGranted = LocationTracking.backgroundGranted(activity),
            problem = location.serviceProblem,
            queued = queued,
            connectionReady = connectionReady(),
            importing = importState.running,
        )
        val now = Instant.now()
        val zone = ZoneId.systemDefault()
        val number = NumberFormat.getIntegerInstance()
        rendering = true
        trackSwitch.isChecked = ui.checked
        accuracySwitch.isChecked = location.highAccuracy
        rendering = false

        val problem = location.serviceProblem
        statusBox.text = when (ui.state) {
            LocationState.OFF -> host.string(if (permissionDenied) R.string.location_status_denied else R.string.location_status_off)
            // The header and the box below already say what is missing: here only how recording works.
            LocationState.RECORDING -> host.string(if (ui.offerBackground) R.string.location_status_on_short else R.string.location_status_on)
            LocationState.PAUSED -> problem ?: host.string(R.string.location_status_paused)
            LocationState.NO_PERMISSION -> host.string(R.string.location_status_no_permission)
        }
        val statusTone = if (ui.state == LocationState.OFF && permissionDenied) Tone.WARNING else ui.state.tone
        if (statusTone == Tone.OK || statusTone == Tone.NEUTRAL) statusBox.setTextColor(kit.color(R.color.text_secondary)) else kit.setTone(statusBox, statusTone, tintBackground = false)
        val fix = location.lastFix
        val recordingWithoutBackground = ui.offerBackground && ui.state == LocationState.RECORDING
        section.setSummary(
            // A paused recorder says so first; "won't resume after a reboot" is only about one that runs.
            when {
                recordingWithoutBackground -> host.string(R.string.location_summary_no_restart)
                ui.state == LocationState.RECORDING && fix != null ->
                    host.string(R.string.location_summary_recording, TimeText.relative(Instant.ofEpochMilli(fix.timeMs), now))
                else -> ui.state.summary
            },
            if (recordingWithoutBackground) Tone.WARNING else ui.state.tone,
            idle = ui.state == LocationState.OFF,
        )
        backgroundButton.visibility = if (ui.offerBackground) View.VISIBLE else View.GONE
        kit.setFilled(backgroundButton, !fixOfferedElsewhere())
        backgroundNote.visibility = backgroundButton.visibility

        lastFixText.text = if (fix == null) {
            host.string(R.string.location_no_fix)
        } else {
            val accuracy = fix.accuracy?.let { host.string(R.string.location_accuracy_value, it.toInt()) }.orEmpty()
            host.string(R.string.location_fix_value, String.format(Locale.ROOT, "%.5f, %.5f", fix.lat, fix.lng),
                TimeText.friendlyWrapped(Instant.ofEpochMilli(fix.timeMs), now, zone, host.use24Hour), accuracy)
        }
        mapButton.visibility = if (fix == null) View.GONE else View.VISIBLE

        queueText.text = if (queued == 0) host.string(R.string.location_queue_empty) else host.string(R.string.location_queue_value, number.format(queued))
        val lastUpload = location.lastUploadStatus
        uploadRow.visibility = if (lastUpload == null) View.GONE else View.VISIBLE
        val upload: CharSequence? = lastUpload?.let {
            val (instant, message) = TimeText.splitStatus(it)
            if (instant == null) it else host.string(R.string.location_upload_value, TimeText.friendlyWrapped(instant, now, zone, host.use24Hour), message)
        }
        // A failed upload in the warning color (a span, so it wins over the quieter detail line).
        uploadText.text = if (upload != null && location.lastUploadFailed) {
            android.text.SpannableString(upload).apply {
                setSpan(android.text.style.ForegroundColorSpan(kit.color(R.color.tone_warning)), 0, length, android.text.Spanned.SPAN_EXCLUSIVE_EXCLUSIVE)
            }
        } else {
            upload
        }
        connectionNote.visibility = if (connectionReady()) View.GONE else View.VISIBLE
        // Only offered when there is something to send (or a send is running).
        uploadButton.visibility = if (queued > 0 || uploading) View.VISIBLE else View.GONE
        uploadButton.isEnabled = ui.uploadEnabled && !uploading
        uploadButton.text = host.string(if (uploading) R.string.location_uploading else R.string.location_upload_now)
        uploadButton.contentDescription = if (!uploadButton.isEnabled && !connectionReady()) {
            host.string(R.string.button_disabled_reason, uploadButton.text, host.string(R.string.location_needs_connection))
        } else {
            null
        }

        importButton.isEnabled = ui.importEnabled
        importButton.contentDescription = when {
            ui.importEnabled -> null
            !connectionReady() -> host.string(R.string.button_disabled_reason, importButton.text, host.string(R.string.location_import_needs_connection))
            importState.running -> host.string(R.string.button_disabled_reason, importButton.text, host.string(R.string.location_import_busy))
            else -> null
        }
        cancelImportButton.visibility = if (importState.running) View.VISIBLE else View.GONE
        importText.text = when {
            importState.running -> listOfNotNull(importState.message, importState.percent?.let { "$it%" }).joinToString(" · ")
            importState.message != null -> importState.message
            else -> location.lastImportStatus?.let { TimeText.humanizeStatus(it, now, zone, host.use24Hour) }
                ?: host.string(R.string.location_import_none)
        }
        if (importState.failed) kit.setTone(importText, Tone.ERROR, tintBackground = false) else importText.setTextColor(kit.color(R.color.text_secondary))
        // Only an error is worth copying (e.g. to report it).
        importText.setTextIsSelectable(importState.failed)
        // Nothing imported yet: no lone "尚未匯入" caption under the button.
        importText.visibility = if (!importState.running && importState.message == null && location.lastImportStatus == null) View.GONE else View.VISIBLE
        val offered = backgroundButton.visibility == View.VISIBLE
        if (offered != fixOffered) {
            fixOffered = offered
            onFixChanged(offered)
        }
    }

    private fun openLastFix() {
        val fix = location.lastFix ?: return
        val coords = String.format(Locale.ROOT, "%.6f,%.6f", fix.lat, fix.lng)
        host.openSafely(Intent(Intent.ACTION_VIEW, "geo:$coords?q=$coords".toUri()))
    }

    private fun openWeb() {
        host.openSafely(Intent(Intent.ACTION_VIEW, "${host.settings.endpoint.trimEnd('/')}/location".toUri()))
    }

    private fun openAppSettings() {
        host.openSafely(Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.fromParts("package", activity.packageName, null)))
    }
}
