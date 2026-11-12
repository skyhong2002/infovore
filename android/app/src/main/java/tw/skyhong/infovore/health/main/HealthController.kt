package tw.skyhong.infovore.health.main

import android.Manifest
import android.content.ActivityNotFoundException
import android.content.Intent
import android.health.connect.HealthConnectManager
import android.view.View
import android.view.WindowManager
import android.widget.Button
import android.widget.ProgressBar
import android.widget.TextView
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.widget.SwitchCompat
import androidx.core.net.toUri
import androidx.health.connect.client.HealthConnectClient
import androidx.health.connect.client.HealthConnectFeatures
import androidx.health.connect.client.permission.HealthPermission
import androidx.health.connect.client.records.SleepSessionRecord
import androidx.lifecycle.lifecycleScope
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import tw.skyhong.infovore.health.HealthConnectSync
import tw.skyhong.infovore.health.R
import tw.skyhong.infovore.health.SyncFailureAlerts
import tw.skyhong.infovore.health.SyncFailureNotifier
import tw.skyhong.infovore.health.SyncKind
import tw.skyhong.infovore.health.ui.BackgroundSync
import tw.skyhong.infovore.health.ui.CollapsibleSection
import tw.skyhong.infovore.health.ui.HealthAction
import tw.skyhong.infovore.health.ui.HealthConnectAvailability
import tw.skyhong.infovore.health.ui.HealthInputs
import tw.skyhong.infovore.health.ui.HealthStatus
import tw.skyhong.infovore.health.ui.HealthUi
import tw.skyhong.infovore.health.ui.NotifyState
import tw.skyhong.infovore.health.ui.NotifyStatus
import tw.skyhong.infovore.health.ui.StaleSync
import tw.skyhong.infovore.health.ui.SyncPanel
import tw.skyhong.infovore.health.ui.TimeText
import tw.skyhong.infovore.health.ui.Tone
import tw.skyhong.infovore.health.ui.ViewKit.Style
import java.time.Instant
import java.time.ZoneId

/**
 * The Health Connect section: availability and permissions, the sync buttons and progress, the
 * last results, the persistent re-verification box ([ReconcileController]) and the opt-in
 * sync-failure notification. Syncs themselves run in the process-wide [tw.skyhong.infovore.health.SyncRunner].
 */
class HealthController(
    private val host: UiHost,
    private val connection: () -> ConnectionController,
    /** Rendered: the first-run steps depend on the same state. */
    private val onRendered: () -> Unit,
) {
    private val kit = host.kit
    private val settings = host.settings
    private val model = host.model
    private val activity = host.activity

    val reconcile = ReconcileController(host, startReverify = { startSync(SyncKind.REVERIFY) }, onChanged = { render() })

    lateinit var section: CollapsibleSection
        private set
    private lateinit var staleBox: TextView
    private lateinit var staleSyncButton: Button
    private lateinit var staleNotifyButton: Button
    private lateinit var statusBox: TextView
    private lateinit var actionButton: Button
    private lateinit var sleepButton: Button
    private lateinit var syncButton: Button
    private lateinit var syncHint: TextView
    private lateinit var progress: ProgressBar
    private lateinit var progressText: TextView
    private lateinit var errorBox: TextView
    private lateinit var retryButton: Button
    private lateinit var lastSyncText: TextView
    private lateinit var lastSleepText: TextView
    private lateinit var notifySwitch: SwitchCompat
    private lateinit var notifyNote: TextView

    private var availability: HealthConnectAvailability? = null

    /** Granted Health Connect permissions, or null when unknown (unavailable or the query failed). */
    var granted: Set<String>? = null
        private set
    private var backgroundSupported: Boolean? = null
    private var permissionError: String? = null
    private var permissionRequestHadNoEffect = false
    private var grantedBeforeRequest: Set<String> = emptySet()
    private var updatingNotifySwitch = false

    /** Set when the user just denied the notification permission, to explain it once. */
    private var notificationPermissionDenied = false

    /** The last mapped status, used by the action button and the first-run steps. */
    var ui: HealthUi? = null
        private set

    private val permissionLauncher = activity.registerForActivityResult(HealthConnectSync.permissionContract()) { result ->
        val newlyGranted = result - grantedBeforeRequest
        activity.lifecycleScope.launch {
            refresh()
            val missing = HealthConnectSync.readPermissions - granted.orEmpty()
            permissionRequestHadNoEffect = newlyGranted.isEmpty() && missing.isNotEmpty()
            render()
        }
    }

    // Asked only when the user turns on "同步失敗時通知我", never at app start.
    private val notificationPermissionLauncher = activity.registerForActivityResult(ActivityResultContracts.RequestPermission()) { ok ->
        settings.notifyOnSyncFailure = ok
        notificationPermissionDenied = !ok
        // Also updates the stale-sync box's "開啟通知" button.
        render()
        if (ok) catchUpNotifications()
    }

    val historyPermissionGranted: Boolean
        get() = HealthPermission.PERMISSION_READ_HEALTH_DATA_HISTORY in granted.orEmpty()

    val readPermissionsGranted: Boolean
        get() = granted?.containsAll(HealthConnectSync.readPermissions) == true

    fun build(expanded: Boolean): CollapsibleSection {
        section = CollapsibleSection(kit, host.string(R.string.section_health), expanded)
        // At the very top: no successful sync for over a day (see StaleSync).
        staleBox = kit.statusBox().apply { visibility = View.GONE }
        section.add(staleBox, 4)
        staleSyncButton = kit.primaryButton("").apply {
            visibility = View.GONE
            setOnClickListener { startSync(SyncKind.FULL) }
        }
        section.add(staleSyncButton, 8)
        staleNotifyButton = kit.secondaryButton("").apply {
            visibility = View.GONE
            // Only on this tap: the same path as turning on the switch below (asks for the permission).
            setOnClickListener { onNotifySwitch(true) }
        }
        section.add(staleNotifyButton, 4)
        statusBox = kit.statusBox()
        section.add(statusBox, 12)
        actionButton = kit.primaryButton("").apply { setOnClickListener { performAction() } }
        section.add(actionButton, 8)

        reconcile.build(section)

        section.add(kit.heading(Style.SUBHEAD, host.string(R.string.health_sync_heading)), 20)
        section.add(kit.text(Style.CAPTION, host.string(R.string.health_sync_explainer)), 4)
        sleepButton = kit.secondaryButton(host.string(R.string.action_sync_sleep)).apply {
            setOnClickListener { startSync(SyncKind.SLEEP) }
        }
        section.add(sleepButton, 8)
        syncButton = kit.primaryButton(host.string(R.string.action_sync_all)).apply {
            setOnClickListener { startSync(SyncKind.FULL) }
        }
        section.add(syncButton, 4)
        syncHint = kit.liveText(Style.CAPTION).apply { setPadding(kit.dp(4), kit.dp(4), 0, 0) }
        section.add(syncHint)

        progress = kit.progress(host.string(R.string.sync_in_progress))
        section.add(progress, 12)
        // Not a live region: page-by-page progress would make TalkBack talk constantly.
        progressText = kit.text(Style.BODY).apply { visibility = View.GONE }
        section.add(progressText, 4)

        errorBox = kit.statusBox().apply { visibility = View.GONE }
        section.add(errorBox, 12)
        retryButton = kit.secondaryButton(host.string(R.string.action_retry)).apply {
            visibility = View.GONE
            setOnClickListener { model.sync.value.failed?.takeIf { it.retryable }?.let(::startSync) }
        }
        section.add(retryButton, 4)

        section.add(kit.heading(Style.SUBHEAD, host.string(R.string.health_last_heading)), 20)
        lastSyncText = kit.liveText().apply { setTextIsSelectable(true) }
        section.add(lastSyncText, 4)
        lastSleepText = kit.text(Style.BODY).apply { setTextIsSelectable(true) }
        section.add(lastSleepText, 8)
        section.add(kit.text(Style.CAPTION, host.string(R.string.health_background_note)), 12)

        notifySwitch = SwitchCompat(activity).apply {
            text = host.string(R.string.label_notify_switch)
            textSize = 16f
            minHeight = kit.dp(48)
            setOnCheckedChangeListener { _, checked -> onNotifySwitch(checked) }
        }
        section.add(notifySwitch, 8)
        notifyNote = kit.liveText(Style.CAPTION).apply { setPadding(kit.dp(4), 0, 0, 0) }
        section.add(notifyNote)
        return section
    }

    /** Re-reads availability and permissions; they can change in system settings while we are away. */
    suspend fun refresh() {
        val status = HealthConnectAvailability.fromSdkStatus(HealthConnectClient.getSdkStatus(activity))
        availability = status
        if (status != HealthConnectAvailability.AVAILABLE) {
            granted = null
            permissionError = null
            return
        }
        try {
            val client = HealthConnectClient.getOrCreate(activity)
            granted = client.permissionController.getGrantedPermissions()
            backgroundSupported = client.features.getFeatureStatus(HealthConnectFeatures.FEATURE_READ_HEALTH_DATA_IN_BACKGROUND) ==
                HealthConnectFeatures.FEATURE_STATUS_AVAILABLE
            permissionError = null
        } catch (cancelled: CancellationException) {
            throw cancelled
        } catch (error: Exception) {
            granted = null
            permissionError = error.message ?: error.javaClass.simpleName
        }
    }

    fun render() {
        if (!::statusBox.isInitialized) return
        val sync = model.sync.value
        val ui = HealthStatus.map(
            HealthInputs(
                availability = availability,
                granted = granted,
                requiredRead = HealthConnectSync.readPermissions,
                sleepPermission = HealthPermission.getReadPermission(SleepSessionRecord::class),
                backgroundPermission = HealthPermission.PERMISSION_READ_HEALTH_DATA_IN_BACKGROUND,
                historyPermission = HealthPermission.PERMISSION_READ_HEALTH_DATA_HISTORY,
                connectionProblem = connection().problem(),
                syncing = sync.running != null,
                backgroundSyncRunning = sync.backgroundRunning,
                permissionRequestHadNoEffect = permissionRequestHadNoEffect,
                permissionError = permissionError,
            ),
        )
        this.ui = ui
        statusBox.text = listOfNotNull(ui.headline, ui.detail).joinToString("\n")
        kit.setTone(statusBox, ui.tone)
        actionButton.visibility = if (ui.actionLabel == null) View.GONE else View.VISIBLE
        actionButton.text = ui.actionLabel
        sleepButton.isEnabled = ui.sleepEnabled
        syncButton.isEnabled = ui.syncEnabled
        syncHint.text = ui.syncHint
        syncHint.visibility = if (ui.syncHint == null) View.GONE else View.VISIBLE

        val panel = SyncPanel.map(sync, sleepEnabled = ui.sleepEnabled, syncEnabled = ui.syncEnabled)
        progress.visibility = if (panel.progressVisible) View.VISIBLE else View.GONE
        progressText.visibility = progress.visibility
        progressText.text = panel.progressText ?: if (panel.showBackgroundProgress) host.string(R.string.background_sync_in_progress) else null
        val errorKind = panel.errorKind
        errorBox.visibility = if (errorKind == null) View.GONE else View.VISIBLE
        errorBox.text = sync.error?.let {
            host.string(
                when (errorKind) {
                    SyncKind.SLEEP -> R.string.sync_failed_sleep
                    SyncKind.REVERIFY -> R.string.sync_failed_reverify
                    SyncKind.CONFIRM_DELETE -> R.string.sync_failed_confirm_delete
                    else -> R.string.sync_failed_full
                },
                it,
            )
        }
        kit.setTone(errorBox, Tone.ERROR)
        retryButton.visibility = if (panel.retryVisible) View.VISIBLE else View.GONE
        retryButton.isEnabled = panel.retryEnabled

        val now = Instant.now()
        val zone = ZoneId.systemDefault()
        lastSyncText.text = host.string(R.string.last_full_sync, TimeText.humanizeStatus(settings.lastStatus, now, zone, host.use24Hour))
        kit.setTone(lastSyncText, if (settings.lastSyncFailed) Tone.ERROR else Tone.NEUTRAL, tintBackground = false)
        lastSleepText.text = host.string(R.string.last_sleep_sync, TimeText.humanizeStatus(settings.lastSleepStatus, now, zone, host.use24Hour))
        kit.setTone(lastSleepText, if (HealthStatus.sleepStatusFailed(settings.lastSleepStatus)) Tone.ERROR else Tone.NEUTRAL, tintBackground = false)

        val gaps = reconcile.render(syncReady = ui.syncEnabled, syncHint = ui.syncHint, resultNotice = panel.notice)

        val notificationsOn = settings.notifyOnSyncFailure && SyncFailureNotifier.permissionGranted(activity)
        val stale = StaleSync.map(
            lastSuccess = StaleSync.lastSuccess(settings.lastSuccessfulSyncMs, settings.lastStatus, settings.lastSyncFailed),
            now = now,
            configured = settings.initialImportDone && connection().problem() == null,
            busy = panel.busy,
            syncEnabled = ui.syncEnabled,
            notificationsOn = notificationsOn,
        )
        staleBox.visibility = if (stale == null) View.GONE else View.VISIBLE
        staleBox.text = stale?.text
        kit.setTone(staleBox, Tone.WARNING)
        staleSyncButton.visibility = if (stale == null) View.GONE else View.VISIBLE
        staleSyncButton.text = stale?.syncLabel
        staleSyncButton.isEnabled = stale?.syncEnabled == true
        staleNotifyButton.visibility = if (stale?.notifyLabel == null) View.GONE else View.VISIBLE
        staleNotifyButton.text = stale?.notifyLabel

        val lastSync = TimeText.splitStatus(settings.lastStatus).first
        val summary = buildString {
            if (stale != null) append(stale.summary).append(" · ")
            append(ui.headline)
            if (gaps != null) append(" · ").append(host.string(R.string.health_summary_unverified))
            if (lastSync != null) append(" · ").append(host.string(R.string.health_summary_last, TimeText.relative(lastSync, now)))
        }
        section.setSummary(
            if (panel.busy) host.string(R.string.sync_in_progress) else summary,
            SyncPanel.summaryTone(ui.tone, unverified = gaps != null || stale != null, busy = panel.busy),
        )
        renderNotifications()
        onRendered()
    }

    /** Keeps the display awake while a manual sync reads Health Connect in the foreground. */
    fun applyKeepScreenOn() {
        val keep = SyncPanel.map(model.sync.value, sleepEnabled = false, syncEnabled = false).keepScreenOn
        if (keep) {
            activity.window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        } else {
            activity.window.clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        }
    }

    private fun renderNotifications() {
        if (!::notifySwitch.isInitialized) return
        val notify = NotifyStatus.map(
            on = settings.notifyOnSyncFailure,
            permission = SyncFailureNotifier.permissionGranted(activity),
            justDenied = notificationPermissionDenied,
        )
        updatingNotifySwitch = true
        notifySwitch.isChecked = notify.checked
        updatingNotifySwitch = false
        notifyNote.text = when (notify.state) {
            NotifyState.ON -> host.string(R.string.notify_on, SyncFailureAlerts.THRESHOLD, SyncFailureAlerts.THRESHOLD * SyncFailureAlerts.PERIOD_HOURS)
            NotifyState.PERMISSION_REVOKED -> host.string(R.string.notify_permission_revoked)
            NotifyState.DENIED -> host.string(R.string.notify_denied)
            NotifyState.OFF -> host.string(R.string.notify_off, SyncFailureAlerts.THRESHOLD)
        }
        if (notify.tone == Tone.NEUTRAL) notifyNote.setTextColor(kit.color(R.color.text_secondary)) else kit.setTone(notifyNote, notify.tone, tintBackground = false)
    }

    private fun onNotifySwitch(checked: Boolean) {
        if (updatingNotifySwitch) return
        notificationPermissionDenied = false
        if (!checked) {
            settings.notifyOnSyncFailure = false
            SyncFailureNotifier.cancel(activity)
            render()
            return
        }
        if (SyncFailureNotifier.permissionGranted(activity)) {
            settings.notifyOnSyncFailure = true
            render()
            catchUpNotifications()
        } else {
            // Show the switch as off until the user answers the system dialog.
            updatingNotifySwitch = true
            notifySwitch.isChecked = false
            updatingNotifySwitch = false
            notificationPermissionLauncher.launch(Manifest.permission.POST_NOTIFICATIONS)
        }
    }

    /** Delivers, once, the warnings that already apply now that notifications are on. */
    private fun catchUpNotifications() {
        val context = activity.applicationContext
        activity.lifecycleScope.launch(Dispatchers.IO) { SyncFailureNotifier.catchUp(context, settings) }
    }

    fun performAction() {
        when (ui?.action) {
            HealthAction.INSTALL_OR_UPDATE -> openHealthConnectInstall()
            HealthAction.GRANT -> requestPermissions()
            HealthAction.MANAGE -> openHealthConnectSettings()
            HealthAction.NONE, null -> Unit
        }
    }

    private fun requestPermissions() {
        if (availability != HealthConnectAvailability.AVAILABLE) return
        grantedBeforeRequest = granted.orEmpty()
        permissionRequestHadNoEffect = false
        try {
            permissionLauncher.launch(permissionsToRequest(HealthConnectClient.getOrCreate(activity)))
        } catch (_: ActivityNotFoundException) {
            openHealthConnectSettings()
        }
    }

    /** Opens Infovore's page in Health Connect's permission settings, falling back to Health Connect itself. */
    private fun openHealthConnectSettings() {
        val appPermissions = Intent(HealthConnectManager.ACTION_MANAGE_HEALTH_PERMISSIONS)
            .putExtra(Intent.EXTRA_PACKAGE_NAME, activity.packageName)
        if (host.openSafely(appPermissions, showError = false)) return
        val manage = runCatching { HealthConnectClient.getHealthConnectManageDataIntent(activity) }.getOrNull()
        if (manage != null && host.openSafely(manage, showError = false)) return
        host.openSafely(Intent(HealthConnectClient.ACTION_HEALTH_CONNECT_SETTINGS))
    }

    private fun openHealthConnectInstall() {
        val market = Intent(Intent.ACTION_VIEW, "market://details?id=$HEALTH_CONNECT_PACKAGE&url=healthconnect%3A%2F%2Fonboarding".toUri())
            .setPackage("com.android.vending")
            .putExtra("overlay", true)
            .putExtra("callerId", activity.packageName)
        if (host.openSafely(market, showError = false)) return
        host.openSafely(Intent(Intent.ACTION_VIEW, "https://play.google.com/store/apps/details?id=$HEALTH_CONNECT_PACKAGE".toUri()))
    }

    fun startSync(kind: SyncKind) {
        if (model.sync.value.busy) return
        val connection = connection()
        if (connection.dirty()) {
            when (connection.save(showSuccess = false) { startSync(kind) }) {
                ConnectionController.SaveResult.SAVED -> Unit
                ConnectionController.SaveResult.INVALID -> {
                    syncHint.text = host.string(R.string.sync_blocked_invalid_inputs)
                    syncHint.visibility = View.VISIBLE
                    return
                }
                // Continues from the confirmation dialog, or a running sync blocks the change.
                ConnectionController.SaveResult.AWAITING_CONFIRMATION, ConnectionController.SaveResult.BLOCKED -> return
            }
        }
        val ui = ui
        // Re-verification reads the same types as a full sync, so it needs the same permissions.
        val allowed = if (kind == SyncKind.SLEEP) ui?.sleepEnabled else ui?.syncEnabled
        if (allowed != true) {
            render()
            return
        }
        model.startSync(kind)
    }

    fun backgroundState(): BackgroundSync = when {
        backgroundSupported == false -> BackgroundSync.UNSUPPORTED
        granted == null || backgroundSupported == null -> BackgroundSync.UNKNOWN
        HealthPermission.PERMISSION_READ_HEALTH_DATA_IN_BACKGROUND in granted.orEmpty() -> BackgroundSync.GRANTED
        else -> BackgroundSync.NOT_GRANTED
    }

    private fun permissionsToRequest(client: HealthConnectClient): Set<String> = buildSet {
        addAll(HealthConnectSync.readPermissions)
        if (client.features.getFeatureStatus(HealthConnectFeatures.FEATURE_READ_HEALTH_DATA_IN_BACKGROUND) ==
            HealthConnectFeatures.FEATURE_STATUS_AVAILABLE
        ) add(HealthPermission.PERMISSION_READ_HEALTH_DATA_IN_BACKGROUND)
        if (client.features.getFeatureStatus(HealthConnectFeatures.FEATURE_READ_HEALTH_DATA_HISTORY) ==
            HealthConnectFeatures.FEATURE_STATUS_AVAILABLE
        ) add(HealthPermission.PERMISSION_READ_HEALTH_DATA_HISTORY)
    }

    private companion object {
        const val HEALTH_CONNECT_PACKAGE = "com.google.android.apps.healthdata"
    }
}
