package tw.skyhong.infovore.health.main

import android.Manifest
import android.content.ActivityNotFoundException
import android.content.Intent
import android.health.connect.HealthConnectManager
import android.view.View
import android.view.WindowManager
import android.widget.Button
import android.widget.ImageView
import android.widget.LinearLayout
import android.widget.ProgressBar
import android.widget.TextView
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.widget.SwitchCompat
import tw.skyhong.infovore.health.ui.ViewKit
import androidx.core.net.toUri
import androidx.health.connect.client.HealthConnectClient
import androidx.health.connect.client.HealthConnectFeatures
import androidx.health.connect.client.permission.HealthPermission
import androidx.health.connect.client.records.SleepSessionRecord
import androidx.lifecycle.lifecycleScope
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import tw.skyhong.infovore.health.HealthConnectAccess
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
    /** Another section shows a fix button: it is the page's one filled button. */
    private val fixOfferedElsewhere: () -> Boolean = { false },
    /** Whether this section offers a fix changed: another section's fix steps back to tonal. */
    private val onFixChanged: (Boolean) -> Unit = {},
) {
    /** A Health Connect fix ("允許背景讀取", "授權") is showing; it comes first on the page. */
    var fixOffered = false
        private set
    private val kit = host.kit
    private val settings = host.settings
    private val model = host.model
    private val activity = host.activity

    val reconcile = ReconcileController(host, startReverify = { startSync(SyncKind.REVERIFY) }, onChanged = { render() })

    lateinit var section: CollapsibleSection
        private set
    private lateinit var staleBox: TextView
    private lateinit var staleNotifyButton: Button
    private lateinit var staleConnectionButton: Button
    private lateinit var statusBox: TextView
    private lateinit var actionButton: Button
    private lateinit var okRow: View
    private lateinit var okDot: ImageView
    private lateinit var okText: TextView
    private lateinit var okDetail: TextView
    private var okManageAllowed = true
    private lateinit var sleepButton: Button
    private lateinit var syncButton: Button
    private lateinit var syncTextButton: Button
    private lateinit var syncHint: TextView
    private lateinit var sleepNote: TextView
    private lateinit var pinnedSyncButton: Button
    private lateinit var backgroundNote: TextView
    private lateinit var progress: ProgressBar
    private lateinit var progressText: TextView
    private lateinit var errorBox: TextView
    private lateinit var retryButton: Button
    private lateinit var lastSyncText: TextView
    private lateinit var lastSleepText: TextView
    private lateinit var notifySwitch: SwitchCompat
    private lateinit var notifyNote: TextView
    private lateinit var notifySettingsButton: Button

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

    /** Whether the section's last render found nothing that needs attention. */
    var healthy = false
        private set

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
        // At the very top: no successful sync for over a day (see StaleSync), with its cause.
        staleBox = kit.statusBox().apply { visibility = View.GONE }
        section.add(staleBox, 4)
        staleNotifyButton = kit.textButton("", inline = true).apply {
            visibility = View.GONE
            // Only on this tap: the same path as turning on the switch below (asks for the permission),
            // or, when they are on but blocked in system settings, the settings to unblock them.
            setOnClickListener {
                if (notifyBlocked()) openNotificationSettings() else onNotifySwitch(true)
            }
        }
        section.add(staleNotifyButton)

        // Health Connect when something needs fixing: a tinted box with its fix (filled).
        statusBox = kit.statusBox()
        section.add(statusBox, 8)
        actionButton = kit.primaryButton("").apply { setOnClickListener { performAction() } }
        // Buttons have a 2dp inset: 10dp here reads as the same 12dp gap everywhere.
        section.add(actionButton, 10)
        // While a fix is offered: syncing anyway is a text button centred right under the fix, as its pair.
        syncTextButton = kit.textButton(host.string(R.string.action_sync_all)).apply {
            visibility = View.GONE
            setOnClickListener { startSync(SyncKind.FULL) }
        }
        section.add(syncTextButton, 0)

        reconcile.build(section)

        // The main action and the quicker sleep-only sync, side by side.
        // The workaround, not the everyday action: outlined, so 立即同步 is the card's one tonal button.
        sleepButton = kit.outlinedButton(host.string(R.string.action_sync_sleep)).apply {
            setOnClickListener { startSync(SyncKind.SLEEP) }
        }
        syncButton = kit.primaryButton(host.string(R.string.action_sync_all)).apply {
            setOnClickListener { startSync(SyncKind.FULL) }
        }
        val buttons = kit.buttonRow(sleepButton, syncButton)
        section.add(buttons, 10)
        // A failure may be the endpoint or token: the connection settings, one tap away, centred under
        // the retry as its pair (the same pattern as 立即同步 under a fix).
        staleConnectionButton = kit.textButton(host.string(R.string.action_open_connection)).apply {
            visibility = View.GONE
            setOnClickListener {
                val card = connection().section
                card.setExpanded(true, notify = true)
                host.scrollTo(card.root)
            }
        }
        section.add(staleConnectionButton, 0)
        syncHint = kit.liveText(Style.CAPTION).apply { setPadding(0, kit.dp(4), 0, 0) }
        section.add(syncHint)
        sleepNote = kit.text(Style.CAPTION, host.string(R.string.health_sync_sleep_note)).apply { setPadding(0, kit.dp(4), 0, 0) }
        section.add(sleepNote)

        // Health Connect when all is well, below the buttons (in a failure the retry sits right
        // under its cause): the headline with its action on one line, the detail at full width.
        okDot = kit.dot()
        okText = kit.liveText(Style.CAPTION).apply {
            setTextColor(kit.color(R.color.text_primary))
            typeface = kit.medium
        }
        okDetail = kit.text(Style.CAPTION)
        val okManage = kit.textButton(host.string(R.string.health_manage_permissions), trailing = true).apply {
            // Label size, like 檢查更新: the row's action must not outweigh the row.
            setTextSize(android.util.TypedValue.COMPLEX_UNIT_SP, 14f)
            setOnClickListener { performAction() }
        }
        // Very large text: when the headline would wrap beside 管理權限, the action moves under the detail.
        val okManageBelow = kit.textButton(host.string(R.string.health_manage_permissions), inline = true).apply {
            setOnClickListener { performAction() }
            visibility = View.GONE
        }
        val dotSize = kit.dp(10)
        val okHeadline = kit.row().apply {
            gravity = android.view.Gravity.TOP
            addView(okDot, LinearLayout.LayoutParams(dotSize, dotSize).apply { marginEnd = kit.dp(12) })
            addView(okText, LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f))
            addView(okManage)
        }
        okRow = object : LinearLayout(activity) {
            private var arranged: Pair<Boolean, Boolean>? = null

            override fun onMeasure(widthMeasureSpec: Int, heightMeasureSpec: Int) {
                if (MeasureSpec.getMode(widthMeasureSpec) != MeasureSpec.UNSPECIFIED) {
                    val unbounded = MeasureSpec.makeMeasureSpec(0, MeasureSpec.UNSPECIFIED)
                    okManage.measure(unbounded, unbounded)
                    val needed = dotSize + kit.dp(12) + okText.paint.measureText(okText.text.toString()) + okManage.measuredWidth
                    val fits = needed <= MeasureSpec.getSize(widthMeasureSpec)
                    // Re-arranged when the fit or the action's availability changes.
                    val key = fits to okManageAllowed
                    if (key != arranged) {
                        arranged = key
                        okManage.visibility = if (fits && okManageAllowed) View.VISIBLE else View.GONE
                        okManageBelow.visibility = if (!fits && okManageAllowed) View.VISIBLE else View.GONE
                        // Beside 管理權限 the one-line headline is centred on it and the detail is pulled
                        // up to the headline (the 48dp touch target is unchanged). Without it, a wrapped
                        // headline keeps its dot on the first line.
                        val lineHeight = okText.lineHeight
                        val beside = fits && okManageAllowed
                        okHeadline.gravity = if (beside) android.view.Gravity.CENTER_VERTICAL else android.view.Gravity.TOP
                        (okDot.layoutParams as LinearLayout.LayoutParams).topMargin = if (beside) 0 else (lineHeight - dotSize) / 2
                        val rowHeight = maxOf(kit.dp(48), okManage.measuredHeight)
                        (okDetail.layoutParams as LinearLayout.LayoutParams).topMargin =
                            if (beside) -((rowHeight - lineHeight) / 2 - kit.dp(2)) else kit.dp(2)
                    }
                }
                super.onMeasure(widthMeasureSpec, heightMeasureSpec)
            }
        }.apply {
            orientation = LinearLayout.VERTICAL
            addView(okHeadline)
            addView(okDetail, ViewKit.matchWrap().apply { marginStart = dotSize + kit.dp(12) })
            // Its 48dp box adds air of its own: pulled up so the action stays with the detail.
            addView(okManageBelow, ViewKit.matchWrap(-kit.dp(8)).apply { marginStart = dotSize + kit.dp(12) })
        }
        section.add(okRow, 12)

        progress = kit.progress(host.string(R.string.sync_in_progress))
        section.add(progress, 12)
        // Not a live region: page-by-page progress would make TalkBack talk constantly.
        progressText = kit.text(Style.BODY).apply { visibility = View.GONE }
        section.add(progressText, 4)

        errorBox = kit.statusBox().apply { visibility = View.GONE }
        section.add(errorBox, 12)
        retryButton = kit.textButton(host.string(R.string.action_retry), inline = true).apply {
            visibility = View.GONE
            setOnClickListener { model.sync.value.failed?.takeIf { it.retryable }?.let(::startSync) }
        }
        section.add(retryButton)

        section.add(kit.heading(Style.SUBHEAD, host.string(R.string.health_last_heading)), 20)
        lastSyncText = kit.liveText()
        section.add(kit.labelRow(host.string(R.string.result_full_sync), lastSyncText), 8)
        lastSleepText = kit.text(Style.BODY)
        section.add(kit.labelRow(host.string(R.string.result_sleep), lastSleepText), 8)

        notifySwitch = kit.switch(host.string(R.string.label_notify_switch)).apply {
            setOnCheckedChangeListener { _, checked -> onNotifySwitch(checked) }
        }
        section.add(notifySwitch, 16)
        notifyNote = kit.liveText(Style.CAPTION)
        section.add(notifyNote)
        notifySettingsButton = kit.textButton(host.string(R.string.action_open_notification_settings), inline = true).apply {
            visibility = View.GONE
            setOnClickListener { openNotificationSettings() }
        }
        section.add(notifySettingsButton)
        backgroundNote = kit.text(Style.CAPTION)
        section.add(backgroundNote, 16)

        // Collapsed, the card still offers its main action under the status line.
        // Tonal: the dot and summary carry the state, and a fix elsewhere stays the one filled button.
        pinnedSyncButton = kit.secondaryButton(host.string(R.string.action_sync_all)).apply {
            setOnClickListener { startSync(SyncKind.FULL) }
        }
        section.setCollapsedFooter(kit.column().apply {
            addView(pinnedSyncButton, ViewKit.matchWrap().apply { bottomMargin = kit.dp(16) })
        })
        return section
    }

    /** A saved status as "when" and, on the next line, "what"; a failure's line in the error color. */
    private fun resultText(status: String, failed: Boolean, causeShownAbove: Boolean, now: Instant, zone: ZoneId, warning: Boolean = false): CharSequence {
        val (instant, message) = TimeText.splitStatus(status)
        if (instant == null) return status
        // The cause is in the box above: the row adds how long it has been failing in the background.
        val what = when {
            failed && causeShownAbove && settings.backgroundFailures > 0 ->
                host.string(R.string.result_failed_count, settings.backgroundFailures)
            failed && causeShownAbove -> host.string(R.string.result_failed)
            else -> message
        }
        val text = android.text.SpannableStringBuilder(TimeText.friendlyWrapped(instant, now, zone, host.use24Hour)).append("\n")
        val start = text.length
        text.append(TimeText.result(what))
        // A failure whose cause is in the box above: only its outcome word is red, so the table says
        // "failed" at a glance while the box carries the cause.
        if (failed && causeShownAbove) {
            val word = host.string(R.string.result_failed)
            if (what.startsWith(word)) {
                // The shown text may carry invisible joiners: end the span at the word's last character.
                val end = text.indexOf(word.last(), start) + 1
                if (end > start) text.setSpan(android.text.style.ForegroundColorSpan(kit.color(R.color.tone_error)), start, end, android.text.Spanned.SPAN_EXCLUSIVE_EXCLUSIVE)
            }
        } else if (failed || warning) {
            val color = kit.color(if (failed) R.color.tone_error else R.color.tone_warning)
            text.setSpan(android.text.style.ForegroundColorSpan(color), start, text.length, android.text.Spanned.SPAN_EXCLUSIVE_EXCLUSIVE)
        }
        return text
    }

    /** Re-reads availability and permissions; they can change in system settings while we are away. */
    suspend fun refresh() {
        val status = HealthConnectAvailability.fromSdkStatus(HealthConnectAccess.sdkStatus(activity))
        availability = status
        if (status != HealthConnectAvailability.AVAILABLE) {
            granted = null
            permissionError = null
            return
        }
        try {
            val client = HealthConnectAccess.client(activity)
            granted = client.permissionController.getGrantedPermissions()
            backgroundSupported = HealthConnectAccess.featureAvailable(client, HealthConnectFeatures.FEATURE_READ_HEALTH_DATA_IN_BACKGROUND)
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
                backgroundSupported = backgroundSupported,
                firstRun = !settings.initialImportDone,
            ),
        )
        this.ui = ui
        val compact = ui.tone == Tone.OK
        // The permission context stays in place while a background-reading fix is offered.
        val grantedRow = compact || ui.grantedDetail != null
        okRow.visibility = if (grantedRow) View.VISIBLE else View.GONE
        okText.text = if (compact) ui.headline else host.string(R.string.health_granted)
        // Plain " · ": the text view breaks the list between items when it does not fit one line.
        // While the background fix shows, the detail still names the gap (its dot stays green: reading works).
        okDetail.text = if (compact) ui.detail else ui.grantedDetail?.let { detail ->
            // The one negative phrase in the warning color, like "失敗" in a failed row.
            android.text.SpannableString(detail).apply {
                val gap = ui.grantedDetailGap?.let { detail.lastIndexOf(it) } ?: -1
                if (gap >= 0) setSpan(android.text.style.ForegroundColorSpan(kit.color(R.color.tone_warning)), gap, detail.length, android.text.Spanned.SPAN_EXCLUSIVE_EXCLUSIVE)
            }
        }
        // Its words are all fine ("已授權 · 可讀取完整歷史"): green; the header and box carry the warning.
        kit.setDotTone(okDot, Tone.OK)
        // 管理權限 stays on the row in every granted state, so the row keeps one shape.
        okManageAllowed = true
        statusBox.visibility = if (compact) View.GONE else View.VISIBLE
        statusBox.text = kit.headlined(ui.headline, ui.detail)
        kit.setTone(statusBox, ui.tone)
        actionButton.visibility = if (compact || ui.actionLabel == null) View.GONE else View.VISIBLE
        actionButton.text = ui.actionLabel
        // One filled button per screen: while a fix is offered, syncing steps back to tonal and the
        // sleep-only shortcut steps aside.
        val fixOffered = actionButton.visibility == View.VISIBLE
        kit.setFilled(syncButton, !fixOffered && !fixOfferedElsewhere())
        if (fixOffered != this.fixOffered) {
            this.fixOffered = fixOffered
            onFixChanged(fixOffered)
        }
        sleepButton.isEnabled = ui.sleepEnabled
        syncButton.isEnabled = ui.syncEnabled
        pinnedSyncButton.isEnabled = ui.syncEnabled
        pinnedSyncButton.visibility = if (settings.initialImportDone) View.VISIBLE else View.GONE
        describeDisabled(sleepButton, ui.syncHint)
        describeDisabled(syncButton, ui.syncHint)
        describeDisabled(pinnedSyncButton, ui.syncHint)
        syncHint.text = ui.syncHint
        syncHint.visibility = if (ui.syncHint == null) View.GONE else View.VISIBLE
        // Only worth saying when the sleep sync is the one that works.
        sleepNote.visibility = if (ui.sleepEnabled && !ui.syncEnabled) View.VISIBLE else View.GONE
        sleepButton.visibility = if (fixOffered && ui.syncEnabled) View.GONE else View.VISIBLE
        // While a fix is offered it is the one big button; syncing anyway is a text button under it.
        val syncAsText = fixOffered && ui.syncEnabled
        syncButton.visibility = if (syncAsText) View.GONE else View.VISIBLE
        syncTextButton.visibility = if (syncAsText) View.VISIBLE else View.GONE
        // The text button's 48dp box already leaves air below it: keep the usual group rhythm.


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
        val sleepFailed = HealthStatus.sleepStatusFailed(settings.lastSleepStatus)
        lastSleepText.text = resultText(
            settings.lastSleepStatus, sleepFailed, causeShownAbove = false, now, zone,
            warning = HealthStatus.sleepStatusEmpty(settings.lastSleepStatus),
        )
        // Only promise a schedule that will actually run; while the fix is offered, the box says it.
        // The Health Connect row already says the background cadence (or the box says what is missing).
        backgroundNote.visibility = if (fixOffered || okRow.visibility == View.VISIBLE) View.GONE else View.VISIBLE
        backgroundNote.text = host.string(
            when (backgroundState()) {
                BackgroundSync.NOT_GRANTED -> R.string.health_background_note_not_granted
                BackgroundSync.UNSUPPORTED -> R.string.health_background_note_unsupported
                else -> R.string.health_background_note
            },
        )

        val gaps = reconcile.render(syncReady = ui.syncEnabled, syncHint = ui.syncHint, resultNotice = panel.notice)

        // One NotificationManager query per render (renders follow every sync progress line).
        val delivery = SyncFailureNotifier.delivery(activity)
        val notificationsOn = settings.notifyOnSyncFailure && delivery.shown
        val blocked = notifyBlocked(delivery)
        val lastError = if (settings.lastSyncFailed) TimeText.splitStatus(settings.lastStatus).second.removePrefix("同步失敗：") else null
        val stale = StaleSync.map(
            lastSuccess = StaleSync.lastSuccess(settings.lastSuccessfulSyncMs, settings.lastStatus, settings.lastSyncFailed),
            now = now,
            configured = settings.initialImportDone && connection().problem() == null,
            busy = panel.busy,
            notificationsOn = notificationsOn,
            lastError = lastError,
        )
        staleBox.visibility = if (stale == null) View.GONE else View.VISIBLE
        // After a failure the one thing to do is retry (立即同步); the sleep-only shortcut steps aside.
        if (lastError != null && stale != null) sleepButton.visibility = View.GONE
        staleBox.text = stale?.let { kit.headlined(it.headline, it.detail) }
        lastSyncText.text = resultText(settings.lastStatus, settings.lastSyncFailed, causeShownAbove = stale != null, now, zone)
        kit.setTone(staleBox, if (lastError != null) Tone.ERROR else Tone.WARNING)
        staleNotifyButton.visibility = if (stale?.notifyLabel == null) View.GONE else View.VISIBLE
        staleConnectionButton.visibility =
            if (stale != null && lastError != null && tw.skyhong.infovore.health.ui.ErrorText.fixableByConnection(lastError)) View.VISIBLE else View.GONE
        // A centred text button's 48dp box already leaves air below it: keep the usual group rhythm.
        val pairedTextButton = syncTextButton.visibility == View.VISIBLE || staleConnectionButton.visibility == View.VISIBLE
        (okRow.layoutParams as? LinearLayout.LayoutParams)?.let { it.topMargin = kit.dp(if (pairedTextButton) -6 else 12); okRow.layoutParams = it }
        staleNotifyButton.text = if (stale?.notifyLabel != null && blocked) {
            host.string(R.string.action_open_notification_settings)
        } else {
            stale?.notifyLabel
        }

        val lastSync = TimeText.splitStatus(settings.lastStatus).first
        val summary = when {
            stale != null -> stale.summary
            // First run, before the connection is saved: nothing to grant yet.
            !settings.initialImportDone && !connection().savedReady() -> host.string(R.string.health_summary_needs_connection)
            ui.tone != Tone.OK -> ui.headline
            else -> listOfNotNull(
                lastSync?.let {
                    host.string(if (settings.lastSyncFailed) R.string.health_summary_failed else R.string.health_summary_last, TimeText.relative(it, now))
                },
                if (gaps != null) host.string(R.string.health_summary_unverified) else null,
            ).joinToString(" · ").ifEmpty { ui.headline }
        }
        val summaryTone = when {
            stale != null && lastError != null -> Tone.ERROR
            settings.lastSyncFailed && ui.tone == Tone.OK -> Tone.ERROR
            else -> SyncPanel.summaryTone(ui.tone, unverified = gaps != null || stale != null, busy = panel.busy)
        }
        // The header already says the headline: the box keeps only the explanation.
        if (!compact && summary == ui.headline && ui.detail != null) {
            statusBox.text = ui.detail
            statusBox.setTextColor(kit.color(R.color.text_primary))
        }
        section.setSummary(
            if (panel.busy) host.string(R.string.sync_in_progress) else summary,
            if (panel.busy) Tone.NEUTRAL else summaryTone,
            // Not started yet (first run, before the connection is saved): an empty dot.
            idle = !panel.busy && !settings.initialImportDone && !connection().savedReady(),
        )
        // Nothing needs the owner's attention: the section may stay collapsed.
        healthy = !panel.busy && stale == null && ui.tone == Tone.OK && !settings.lastSyncFailed && gaps == null && settings.initialImportDone
        renderNotifications(delivery)
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

    private fun renderNotifications(delivery: SyncFailureAlerts.Delivery) {
        if (!::notifySwitch.isInitialized) return
        val notify = NotifyStatus.map(
            on = settings.notifyOnSyncFailure,
            permission = delivery != SyncFailureAlerts.Delivery.NO_PERMISSION,
            justDenied = notificationPermissionDenied,
            blocked = delivery == SyncFailureAlerts.Delivery.APP_BLOCKED || delivery == SyncFailureAlerts.Delivery.CHANNEL_BLOCKED,
        )
        updatingNotifySwitch = true
        notifySwitch.isChecked = notify.checked
        updatingNotifySwitch = false
        notifyNote.text = when (notify.state) {
            // Without background reading there are no background syncs to fail: say what it waits for.
            NotifyState.ON -> if (backgroundState() == BackgroundSync.NOT_GRANTED) {
                host.string(R.string.notify_on_needs_background)
            } else {
                host.string(R.string.notify_on, SyncFailureAlerts.THRESHOLD)
            }
            NotifyState.PERMISSION_REVOKED -> host.string(R.string.notify_permission_revoked)
            NotifyState.DENIED -> host.string(R.string.notify_denied)
            NotifyState.OFF -> host.string(R.string.notify_off, SyncFailureAlerts.THRESHOLD)
            NotifyState.BLOCKED -> host.string(
                if (delivery == SyncFailureAlerts.Delivery.CHANNEL_BLOCKED) R.string.notify_blocked_channel else R.string.notify_blocked_app,
            )
        }
        notifySettingsButton.visibility = if (notify.showSettingsButton) View.VISIBLE else View.GONE
        // Without background reading nothing can fail in the background: the switch stays operable
        // (the choice can still be turned off), its label is quiet, and TalkBack hears why.
        val paused = notify.state == NotifyState.ON && backgroundState() == BackgroundSync.NOT_GRANTED
        androidx.core.view.ViewCompat.setStateDescription(notifySwitch, if (paused) host.string(R.string.notify_paused_state) else null)
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

    /** On in the app, permission granted, but Infovore's notifications or the channel are off in system settings. */
    private fun notifyBlocked(delivery: SyncFailureAlerts.Delivery = SyncFailureNotifier.delivery(activity)): Boolean =
        settings.notifyOnSyncFailure && delivery != SyncFailureAlerts.Delivery.NO_PERMISSION && !delivery.shown

    private fun openNotificationSettings() {
        host.openSafely(SyncFailureNotifier.settingsIntent(activity, SyncFailureNotifier.delivery(activity)))
    }

    /**
     * Delivers, once, the warnings that already apply and were not shown yet: when notifications
     * were just turned on, and whenever the app returns to the foreground (they may have been
     * turned back on in system settings meanwhile).
     */
    fun catchUpNotifications() {
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
            permissionLauncher.launch(permissionsToRequest(HealthConnectAccess.client(activity)))
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

    /** TalkBack hears why a disabled button cannot be used. */
    private fun describeDisabled(button: Button, reason: String?) {
        button.contentDescription = if (!button.isEnabled && reason != null) {
            host.string(R.string.button_disabled_reason, button.text, reason)
        } else {
            null
        }
    }

    fun backgroundState(): BackgroundSync = when {
        backgroundSupported == false -> BackgroundSync.UNSUPPORTED
        granted == null || backgroundSupported == null -> BackgroundSync.UNKNOWN
        HealthPermission.PERMISSION_READ_HEALTH_DATA_IN_BACKGROUND in granted.orEmpty() -> BackgroundSync.GRANTED
        else -> BackgroundSync.NOT_GRANTED
    }

    private fun permissionsToRequest(client: HealthConnectClient): Set<String> = buildSet {
        addAll(HealthConnectSync.readPermissions)
        if (HealthConnectAccess.featureAvailable(client, HealthConnectFeatures.FEATURE_READ_HEALTH_DATA_IN_BACKGROUND)) add(HealthPermission.PERMISSION_READ_HEALTH_DATA_IN_BACKGROUND)
        if (HealthConnectAccess.featureAvailable(client, HealthConnectFeatures.FEATURE_READ_HEALTH_DATA_HISTORY)) add(HealthPermission.PERMISSION_READ_HEALTH_DATA_HISTORY)
    }

    private companion object {
        const val HEALTH_CONNECT_PACKAGE = "com.google.android.apps.healthdata"
    }
}
