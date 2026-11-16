package tw.skyhong.infovore.health.main

import android.Manifest
import android.content.Intent
import android.net.Uri
import android.provider.Settings
import android.view.View
import android.widget.Button
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
) {
    private val kit = host.kit
    private val activity = host.activity
    private val location = LocationSettings(activity)
    private val queue = LocationQueue(activity)

    lateinit var section: CollapsibleSection
        private set
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
        section.add(kit.text(Style.CAPTION, host.string(R.string.location_intro)), 4)
        statusBox = kit.statusBox()
        section.add(statusBox, 12)

        trackSwitch = switch(host.string(R.string.location_track_switch)) { checked -> onTrackSwitch(checked) }
        section.add(trackSwitch, 8)
        accuracySwitch = switch(host.string(R.string.location_accuracy_switch)) { checked ->
            location.highAccuracy = checked
            // The service reads the setting when it starts listening: restart it to apply.
            LocationTracking.restart(activity)
        }
        section.add(accuracySwitch)
        section.add(kit.text(Style.CAPTION, host.string(R.string.location_accuracy_note)).apply { setPadding(kit.dp(4), 0, 0, 0) })
        backgroundButton = kit.secondaryButton(host.string(R.string.location_background_action)).apply {
            setOnClickListener { backgroundPermission.launch(Manifest.permission.ACCESS_BACKGROUND_LOCATION) }
        }
        section.add(backgroundButton, 8)

        section.add(kit.heading(Style.SUBHEAD, host.string(R.string.location_last_heading)), 20)
        lastFixText = kit.liveText().apply { setTextIsSelectable(true) }
        section.add(lastFixText, 4)
        mapButton = kit.textButton(host.string(R.string.location_open_map)).apply { setOnClickListener { openLastFix() } }
        section.add(mapButton)
        uploadText = kit.liveText(Style.CAPTION)
        section.add(uploadText, 4)
        uploadButton = kit.secondaryButton(host.string(R.string.location_upload_now)).apply { setOnClickListener { uploadNow() } }
        section.add(uploadButton, 8)
        section.add(kit.textButton(host.string(R.string.location_open_web)).apply { setOnClickListener { openWeb() } })

        section.add(kit.heading(Style.SUBHEAD, host.string(R.string.location_import_heading)), 20)
        section.add(kit.text(Style.CAPTION, host.string(R.string.location_import_help)), 4)
        importButton = kit.primaryButton(host.string(R.string.location_import_action)).apply {
            setOnClickListener { pickExport.launch(arrayOf("application/json", "application/octet-stream", "text/plain", "*/*")) }
        }
        section.add(importButton, 8)
        cancelImportButton = kit.secondaryButton(host.string(R.string.location_import_cancel)).apply {
            setOnClickListener { TimelineImporter.cancel() }
        }
        section.add(cancelImportButton, 4)
        importText = kit.liveText().apply { setTextIsSelectable(true) }
        section.add(importText, 8)
        return section
    }

    private fun switch(label: String, onChange: (Boolean) -> Unit) = SwitchCompat(activity).apply {
        text = label
        textSize = 16f
        minHeight = kit.dp(48)
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
            LocationState.RECORDING -> host.string(R.string.location_status_on)
            LocationState.PAUSED -> problem ?: host.string(R.string.location_status_paused)
            LocationState.NO_PERMISSION -> host.string(R.string.location_status_no_permission)
        }
        kit.setTone(statusBox, if (ui.state == LocationState.OFF && permissionDenied) Tone.WARNING else ui.state.tone)
        section.setSummary(ui.state.summary, ui.state.tone)
        backgroundButton.visibility = if (ui.offerBackground) View.VISIBLE else View.GONE

        val fix = location.lastFix
        lastFixText.text = if (fix == null) {
            host.string(R.string.location_no_fix)
        } else {
            val accuracy = fix.accuracy?.let { host.string(R.string.location_accuracy_value, it.toInt()) }.orEmpty()
            host.string(R.string.location_fix_value, String.format(Locale.ROOT, "%.5f, %.5f", fix.lat, fix.lng),
                TimeText.friendly(Instant.ofEpochMilli(fix.timeMs), now, zone, host.use24Hour), accuracy)
        }
        mapButton.visibility = if (fix == null) View.GONE else View.VISIBLE

        val lastUpload = location.lastUploadStatus?.let { TimeText.humanizeStatus(it, now, zone, host.use24Hour) }
        uploadText.text = listOfNotNull(
            host.string(R.string.location_queue_value, number.format(queued)),
            lastUpload,
            if (!connectionReady()) host.string(R.string.location_needs_connection) else null,
        ).joinToString("\n")
        if (location.lastUploadFailed) kit.setTone(uploadText, Tone.WARNING, tintBackground = false) else uploadText.setTextColor(kit.color(R.color.text_secondary))
        uploadButton.isEnabled = ui.uploadEnabled && !uploading
        uploadButton.text = host.string(if (uploading) R.string.location_uploading else R.string.location_upload_now)

        importButton.isEnabled = ui.importEnabled
        cancelImportButton.visibility = if (importState.running) View.VISIBLE else View.GONE
        importText.text = when {
            importState.running -> listOfNotNull(importState.message, importState.percent?.let { "$it%" }).joinToString(" · ")
            importState.message != null -> importState.message
            else -> location.lastImportStatus?.let { TimeText.humanizeStatus(it, now, zone, host.use24Hour) }
                ?: host.string(R.string.location_import_none)
        }
        if (importState.failed) kit.setTone(importText, Tone.ERROR, tintBackground = false) else importText.setTextColor(kit.color(R.color.text_secondary))
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
