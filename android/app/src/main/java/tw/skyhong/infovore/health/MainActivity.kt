package tw.skyhong.infovore.health

import android.Manifest
import android.content.ActivityNotFoundException
import android.content.ComponentName
import android.content.Intent
import android.health.connect.HealthConnectManager
import android.net.Uri
import android.os.Bundle
import android.provider.Settings
import android.text.format.DateFormat
import android.view.Gravity
import android.view.View
import android.view.WindowManager
import android.widget.Button
import android.widget.FrameLayout
import android.widget.ImageView
import android.widget.LinearLayout
import android.widget.ProgressBar
import android.widget.ScrollView
import android.widget.TextView
import android.widget.Toast
import androidx.activity.OnBackPressedCallback
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AlertDialog
import androidx.appcompat.app.AppCompatActivity
import androidx.appcompat.widget.SwitchCompat
import androidx.core.net.toUri
import androidx.core.view.ViewCompat
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import androidx.health.connect.client.HealthConnectClient
import androidx.health.connect.client.HealthConnectFeatures
import androidx.health.connect.client.permission.HealthPermission
import androidx.health.connect.client.records.SleepSessionRecord
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.ViewModelProvider
import androidx.lifecycle.lifecycleScope
import androidx.lifecycle.repeatOnLifecycle
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.launch
import tw.skyhong.infovore.health.MainViewModel.ScreenTask
import tw.skyhong.infovore.health.screen.Exclusions
import tw.skyhong.infovore.health.screen.ObservationQueue
import tw.skyhong.infovore.health.screen.ScreenActivityService
import tw.skyhong.infovore.health.screen.ScreenSettings
import tw.skyhong.infovore.health.screen.ScreenUploader
import tw.skyhong.infovore.health.ui.CollapsibleSection
import tw.skyhong.infovore.health.ui.Field
import tw.skyhong.infovore.health.ui.FormState
import tw.skyhong.infovore.health.ui.FieldResult
import tw.skyhong.infovore.health.ui.HealthAction
import tw.skyhong.infovore.health.ui.HealthConnectAvailability
import tw.skyhong.infovore.health.ui.HealthInputs
import tw.skyhong.infovore.health.ui.HealthStatus
import tw.skyhong.infovore.health.ui.HealthUi
import tw.skyhong.infovore.health.ui.InputValidation
import tw.skyhong.infovore.health.ui.ReconcileStatus
import tw.skyhong.infovore.health.ui.ScreenInputs
import tw.skyhong.infovore.health.ui.ScreenStatus
import tw.skyhong.infovore.health.ui.BackgroundSync
import tw.skyhong.infovore.health.ui.SaveState
import tw.skyhong.infovore.health.ui.SecretDrafts
import tw.skyhong.infovore.health.ui.SetupProgress
import tw.skyhong.infovore.health.ui.SetupStep
import tw.skyhong.infovore.health.ui.StepState
import tw.skyhong.infovore.health.ui.TimeText
import tw.skyhong.infovore.health.ui.Tone
import tw.skyhong.infovore.health.ui.ViewKit
import tw.skyhong.infovore.health.ui.ViewKit.Style
import tw.skyhong.infovore.health.ui.errorOrNull
import tw.skyhong.infovore.health.ui.isValid
import tw.skyhong.infovore.health.ui.setClickActionLabel
import tw.skyhong.infovore.health.ui.valueOrNull
import java.time.Instant
import java.time.ZoneId

/**
 * Settings and status screen, organised as: first-run steps, connection settings, Health Connect
 * sync, and the opt-in phone screen recorder (collapsed, advanced). Views are built in code with
 * [ViewKit]; every decision about what to show lives in the pure, unit-tested classes in `ui/`.
 */
class MainActivity : AppCompatActivity() {
    private lateinit var settings: SecureSettings
    private lateinit var screenSettings: ScreenSettings
    private lateinit var kit: ViewKit
    private lateinit var model: MainViewModel

    private lateinit var scroll: ScrollView

    // First-run steps
    private lateinit var setupSummary: TextView
    private lateinit var setupRows: List<TextView>
    private lateinit var setupNextButton: Button

    // Connection
    private lateinit var connectionSection: CollapsibleSection
    private lateinit var endpointField: Field
    private lateinit var tokenField: Field
    private lateinit var historyDaysField: Field
    private lateinit var connectionSaveState: TextView

    // Health Connect
    private lateinit var healthSection: CollapsibleSection
    private lateinit var healthStatusBox: TextView
    private lateinit var healthActionButton: Button
    private lateinit var sleepButton: Button
    private lateinit var syncButton: Button
    private lateinit var syncHint: TextView
    private lateinit var syncProgress: ProgressBar
    private lateinit var syncProgressText: TextView
    private lateinit var syncErrorBox: TextView
    private lateinit var syncRetryButton: Button
    private lateinit var lastSyncText: TextView
    private lateinit var lastSleepText: TextView
    private lateinit var reconcileBox: TextView
    private lateinit var reverifyButton: Button
    private lateinit var reverifyHint: TextView
    private lateinit var notifySwitch: SwitchCompat
    private lateinit var notifyNote: TextView

    // Phone screen recording
    private lateinit var screenSection: CollapsibleSection
    private lateinit var screenStatusBox: TextView
    private lateinit var screenDetails: TextView
    private lateinit var phoneTokenField: Field
    private lateinit var exclusionsField: Field
    private lateinit var screenSaveState: TextView
    private lateinit var accessibilityStatus: TextView
    private lateinit var recordingSwitch: SwitchCompat
    private lateinit var pauseButton: Button
    private lateinit var uploadButton: Button
    private lateinit var testButton: Button
    private lateinit var uploadHint: TextView
    private lateinit var screenProgress: ProgressBar
    private lateinit var screenResult: TextView
    private lateinit var screenRetryButton: Button
    private lateinit var otherDestinationBox: TextView
    private lateinit var deleteOtherDestinationButton: Button
    private lateinit var rejectedBox: TextView
    private lateinit var deleteRejectedButton: Button

    private var availability: HealthConnectAvailability? = null
    private var granted: Set<String>? = null
    private var backgroundSupported: Boolean? = null
    private var permissionError: String? = null
    private var permissionRequestHadNoEffect = false
    private var grantedBeforeRequest: Set<String> = emptySet()
    private var connectionJustSaved = false
    /** The last save changed the sync destination, so the next full sync re-imports this many days. */
    private var reimportDaysAfterSave: Int? = null
    private var screenJustSaved = false
    private var updatingSwitch = false
    private var updatingNotifySwitch = false
    /** Set when the user just denied the notification permission, to explain it once. */
    private var notificationPermissionDenied = false
    private var healthUi: HealthUi? = null

    // Decrypted once and refreshed on save, so typing never triggers a Keystore operation per keystroke.
    private var savedHealthToken = ""
    private var savedPhoneToken = ""

    private val use24Hour: Boolean get() = DateFormat.is24HourFormat(this)

    private val permissionLauncher = registerForActivityResult(HealthConnectSync.permissionContract()) { result ->
        val newlyGranted = result - grantedBeforeRequest
        lifecycleScope.launch {
            refreshHealth()
            val missing = HealthConnectSync.readPermissions - granted.orEmpty()
            permissionRequestHadNoEffect = newlyGranted.isEmpty() && missing.isNotEmpty()
            renderHealth()
        }
    }

    // Asked only when the user turns on "同步失敗時通知我", never at app start.
    private val notificationPermissionLauncher = registerForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
        settings.notifyOnSyncFailure = granted
        notificationPermissionDenied = !granted
        renderNotifications()
    }

    private val backCallback = object : OnBackPressedCallback(false) {
        override fun handleOnBackPressed() = confirmDiscardChanges()
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        WindowCompat.setDecorFitsSystemWindows(window, false)
        settings = SecureSettings(this)
        screenSettings = ScreenSettings(this)
        savedHealthToken = settings.token
        savedPhoneToken = screenSettings.token
        kit = ViewKit(this)
        model = ViewModelProvider(this)[MainViewModel::class.java]
        setContentView(buildContent(savedInstanceState))
        onBackPressedDispatcher.addCallback(this, backCallback)
        observeModel()
        renderAll()
        handleOpenIntent(intent)
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        handleOpenIntent(intent)
    }

    /** The "同步問題" notification opens the health section. */
    private fun handleOpenIntent(intent: Intent?) {
        if (intent?.getBooleanExtra(EXTRA_OPEN_HEALTH, false) != true) return
        intent.removeExtra(EXTRA_OPEN_HEALTH)
        healthSection.setExpanded(true)
        scrollTo(healthSection.root)
    }

    override fun onResume() {
        super.onResume()
        // Permissions and the accessibility service can change in system settings while we are away.
        lifecycleScope.launch {
            refreshHealth()
            renderHealth()
        }
        renderScreen()
    }

    override fun onSaveInstanceState(outState: Bundle) {
        super.onSaveInstanceState(outState)
        outState.putBoolean(STATE_CONNECTION_OPEN, connectionSection.expanded)
        outState.putBoolean(STATE_HEALTH_OPEN, healthSection.expanded)
        outState.putBoolean(STATE_SCREEN_OPEN, screenSection.expanded)
    }

    // region Layout

    private fun buildContent(saved: Bundle?): View {
        val content = MaxWidthColumn(this, kit.dp(640)).apply {
            setPadding(kit.dp(16), kit.dp(16), kit.dp(16), kit.dp(24))
        }
        content.addView(buildHeader())
        content.addView(buildSetupCard(), ViewKit.matchWrap(kit.dp(16)))

        val connectionReady = savedConnectionReady()
        connectionSection = CollapsibleSection(
            kit, getString(R.string.section_connection), saved?.getBoolean(STATE_CONNECTION_OPEN) ?: !connectionReady,
        )
        buildConnectionSection(connectionSection)
        content.addView(connectionSection.root, ViewKit.matchWrap(kit.dp(16)))

        healthSection = CollapsibleSection(kit, getString(R.string.section_health), saved?.getBoolean(STATE_HEALTH_OPEN) ?: true)
        buildHealthSection(healthSection)
        content.addView(healthSection.root, ViewKit.matchWrap(kit.dp(16)))

        // Sensitive and opt-in: always starts collapsed unless the user had it open before a rotation.
        screenSection = CollapsibleSection(kit, getString(R.string.section_screen), saved?.getBoolean(STATE_SCREEN_OPEN) ?: false) {
            if (it) renderScreen()
        }
        buildScreenSection(screenSection)
        content.addView(screenSection.root, ViewKit.matchWrap(kit.dp(16)))

        content.addView(kit.text(Style.CAPTION, getString(R.string.footer_privacy)).apply {
            setPadding(kit.dp(4), kit.dp(16), kit.dp(4), 0)
        })

        scroll = ScrollView(this).apply {
            id = R.id.scroll
            isFillViewport = true
            clipToPadding = false
            addView(content, FrameLayout.LayoutParams(
                FrameLayout.LayoutParams.MATCH_PARENT,
                FrameLayout.LayoutParams.WRAP_CONTENT,
                Gravity.CENTER_HORIZONTAL,
            ))
        }
        ViewCompat.setOnApplyWindowInsetsListener(scroll) { view, insets ->
            val bars = insets.getInsets(
                WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.displayCutout() or WindowInsetsCompat.Type.ime(),
            )
            view.setPadding(bars.left, bars.top, bars.right, bars.bottom)
            WindowInsetsCompat.CONSUMED
        }
        return scroll
    }

    private fun buildHeader(): View {
        val row = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
        }
        row.addView(ImageView(this).apply {
            setImageResource(R.drawable.infovore_logo)
            importantForAccessibility = View.IMPORTANT_FOR_ACCESSIBILITY_NO
        }, LinearLayout.LayoutParams(kit.dp(56), kit.dp(56)))
        val titles = kit.column().apply { setPadding(kit.dp(12), 0, 0, 0) }
        titles.addView(kit.heading(Style.TITLE, getString(R.string.app_name)))
        titles.addView(kit.text(Style.CAPTION, getString(R.string.header_version, BuildConfig.VERSION_NAME)))
        row.addView(titles, LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f))
        return kit.column().apply {
            addView(row)
            addView(kit.text(Style.BODY, getString(R.string.header_intro)), ViewKit.matchWrap(kit.dp(12)))
        }
    }

    private fun buildSetupCard(): View {
        val card = kit.card().apply { setPadding(kit.dp(16), kit.dp(12), kit.dp(16), kit.dp(12)) }
        card.addView(kit.heading(Style.SECTION, getString(R.string.setup_title)))
        setupSummary = kit.liveText(Style.CAPTION)
        card.addView(setupSummary)
        setupRows = SetupStep.entries.map { _ ->
            kit.text(Style.BODY).apply { setPadding(0, kit.dp(8), 0, 0) }.also { card.addView(it, ViewKit.matchWrap()) }
        }
        setupNextButton = kit.primaryButton("").apply { setOnClickListener { goToNextStep() } }
        card.addView(setupNextButton, ViewKit.matchWrap(kit.dp(12)))
        return card
    }

    private fun buildConnectionSection(section: CollapsibleSection) {
        endpointField = kit.field(
            R.id.endpoint_input, getString(R.string.label_endpoint), ViewKit.InputKind.URL, getString(R.string.help_endpoint),
        ).apply { input.hint = SecureSettings.DEFAULT_ENDPOINT }
        tokenField = kit.field(
            R.id.token_input, getString(R.string.label_health_token), ViewKit.InputKind.SECRET, getString(R.string.help_health_token),
        )
        historyDaysField = kit.field(
            R.id.history_days_input,
            getString(R.string.label_history_days, SecureSettings.MAX_HISTORY_DAYS),
            ViewKit.InputKind.NUMBER,
            getString(R.string.help_history_days, SecureSettings.DEFAULT_HISTORY_DAYS),
        )
        endpointField.setValue(settings.endpoint)
        // Unsaved token edits come back from the ViewModel after a rotation; never from the Bundle.
        tokenField.setValue(model.drafts.valueOr(SecretDrafts.Key.HEALTH_TOKEN, savedHealthToken))
        historyDaysField.setValue(settings.historyDays.toString())
        for (field in listOf(endpointField, tokenField, historyDaysField)) {
            section.add(field.input.parent as View)
            field.onChange {
                connectionJustSaved = false
                reimportDaysAfterSave = null
                if (field == tokenField) model.drafts.update(SecretDrafts.Key.HEALTH_TOKEN, field.value, savedHealthToken)
                field.clearErrorIfAny()
                if (field == endpointField) showEndpointNote()
                renderConnectionState()
                renderHealth()
            }
            field.input.setOnFocusChangeListener { _, focused ->
                if (!focused && field.value.isNotBlank()) field.show(validate(field))
            }
        }
        section.add(kit.primaryButton(getString(R.string.action_save_connection)).apply {
            setOnClickListener { saveConnection(showSuccess = true) }
        }, 16)
        connectionSaveState = kit.liveText(Style.CAPTION).apply { setPadding(kit.dp(4), kit.dp(8), 0, 0) }
        section.add(connectionSaveState)
    }

    private fun buildHealthSection(section: CollapsibleSection) {
        healthStatusBox = kit.statusBox()
        section.add(healthStatusBox, 4)
        healthActionButton = kit.primaryButton("").apply { setOnClickListener { performHealthAction() } }
        section.add(healthActionButton, 8)

        // Persistent until a re-verification completes; independent of the last sync's result.
        reconcileBox = kit.statusBox().apply {
            visibility = View.GONE
            setTextIsSelectable(true)
        }
        section.add(reconcileBox, 12)
        reverifyButton = kit.secondaryButton(getString(R.string.action_reverify)).apply {
            visibility = View.GONE
            setOnClickListener { startSync(SyncKind.REVERIFY) }
        }
        section.add(reverifyButton, 4)
        reverifyHint = kit.text(Style.CAPTION).apply {
            visibility = View.GONE
            setPadding(kit.dp(4), kit.dp(4), 0, 0)
        }
        section.add(reverifyHint)

        section.add(kit.heading(Style.SUBHEAD, getString(R.string.health_sync_heading)), 20)
        section.add(kit.text(Style.CAPTION, getString(R.string.health_sync_explainer)), 4)
        sleepButton = kit.secondaryButton(getString(R.string.action_sync_sleep)).apply {
            setOnClickListener { startSync(SyncKind.SLEEP) }
        }
        section.add(sleepButton, 8)
        syncButton = kit.primaryButton(getString(R.string.action_sync_all)).apply {
            setOnClickListener { startSync(SyncKind.FULL) }
        }
        section.add(syncButton, 4)
        syncHint = kit.liveText(Style.CAPTION).apply { setPadding(kit.dp(4), kit.dp(4), 0, 0) }
        section.add(syncHint)

        syncProgress = kit.progress(getString(R.string.sync_in_progress))
        section.add(syncProgress, 12)
        // Not a live region: page-by-page progress would make TalkBack talk constantly.
        syncProgressText = kit.text(Style.BODY).apply { visibility = View.GONE }
        section.add(syncProgressText, 4)

        syncErrorBox = kit.statusBox().apply { visibility = View.GONE }
        section.add(syncErrorBox, 12)
        syncRetryButton = kit.secondaryButton(getString(R.string.action_retry)).apply {
            visibility = View.GONE
            setOnClickListener { model.sync.value.failed?.let(::startSync) }
        }
        section.add(syncRetryButton, 4)

        section.add(kit.heading(Style.SUBHEAD, getString(R.string.health_last_heading)), 20)
        lastSyncText = kit.liveText().apply { setTextIsSelectable(true) }
        section.add(lastSyncText, 4)
        lastSleepText = kit.text(Style.BODY).apply { setTextIsSelectable(true) }
        section.add(lastSleepText, 8)
        section.add(kit.text(Style.CAPTION, getString(R.string.health_background_note)), 12)

        notifySwitch = SwitchCompat(this).apply {
            text = getString(R.string.label_notify_switch)
            textSize = 16f
            minHeight = kit.dp(48)
            setOnCheckedChangeListener { _, checked -> onNotifySwitch(checked) }
        }
        section.add(notifySwitch, 8)
        notifyNote = kit.liveText(Style.CAPTION).apply { setPadding(kit.dp(4), 0, 0, 0) }
        section.add(notifyNote)
    }

    private fun buildScreenSection(section: CollapsibleSection) {
        section.add(kit.statusBox().apply {
            text = getString(R.string.screen_warning)
            kit.setTone(this, Tone.WARNING)
            accessibilityLiveRegion = View.ACCESSIBILITY_LIVE_REGION_NONE
        }, 4)

        screenStatusBox = kit.statusBox()
        section.add(screenStatusBox, 12)
        screenDetails = kit.text(Style.CAPTION).apply {
            setTextIsSelectable(true)
            setPadding(kit.dp(4), kit.dp(6), 0, 0)
        }
        section.add(screenDetails)
        // Records left from an earlier destination: never uploaded, only deleted on request.
        otherDestinationBox = kit.statusBox().apply {
            visibility = View.GONE
            kit.setTone(this, Tone.WARNING)
        }
        section.add(otherDestinationBox, 8)
        deleteOtherDestinationButton = kit.secondaryButton(getString(R.string.action_delete_other_destination)).apply {
            visibility = View.GONE
            setOnClickListener { confirmDeleteOtherDestination() }
        }
        section.add(deleteOtherDestinationButton, 4)
        // Records the server rejected (HTTP 400): quarantined, never sent, only deleted on request.
        rejectedBox = kit.statusBox().apply {
            visibility = View.GONE
            kit.setTone(this, Tone.WARNING)
        }
        section.add(rejectedBox, 8)
        deleteRejectedButton = kit.secondaryButton(getString(R.string.action_delete_rejected)).apply {
            visibility = View.GONE
            setOnClickListener { confirmDeleteRejected() }
        }
        section.add(deleteRejectedButton, 4)

        // Step 1: token and exclusions
        section.add(kit.heading(Style.SUBHEAD, getString(R.string.screen_step_settings)), 20)
        phoneTokenField = kit.field(
            R.id.phone_token_input, getString(R.string.label_phone_token), ViewKit.InputKind.SECRET, getString(R.string.help_phone_token),
        )
        exclusionsField = kit.field(
            R.id.exclusions_input,
            getString(R.string.label_exclusions),
            ViewKit.InputKind.MULTILINE,
            getString(R.string.help_exclusions, Exclusions.DEFAULT_PACKAGES.size),
        ).apply { input.hint = "com.example.bank" }
        phoneTokenField.setValue(model.drafts.valueOr(SecretDrafts.Key.PHONE_TOKEN, savedPhoneToken))
        exclusionsField.setValue(screenSettings.exclusionsText)
        for (field in listOf(phoneTokenField, exclusionsField)) {
            section.add(field.input.parent as View)
            field.onChange {
                screenJustSaved = false
                if (field == phoneTokenField) model.drafts.update(SecretDrafts.Key.PHONE_TOKEN, field.value, savedPhoneToken)
                field.clearErrorIfAny()
                renderScreenSaveState()
                updateBackCallback()
            }
            field.input.setOnFocusChangeListener { _, focused ->
                if (!focused && field.value.isNotBlank()) field.show(validate(field))
            }
        }
        section.add(kit.primaryButton(getString(R.string.action_save_screen)).apply {
            setOnClickListener { saveScreen(showSuccess = true) }
        }, 16)
        screenSaveState = kit.liveText(Style.CAPTION).apply { setPadding(kit.dp(4), kit.dp(8), 0, 0) }
        section.add(screenSaveState)

        // Step 2: accessibility service (the user enables it in system settings; the app never does)
        section.add(kit.heading(Style.SUBHEAD, getString(R.string.screen_step_service)), 20)
        accessibilityStatus = kit.liveText().apply { setPadding(0, kit.dp(4), 0, 0) }
        section.add(accessibilityStatus)
        section.add(kit.text(Style.CAPTION, getString(R.string.screen_restricted_help)), 4)
        section.add(kit.textButton(getString(R.string.action_open_app_info)).apply {
            gravity = Gravity.START or Gravity.CENTER_VERTICAL
            setOnClickListener {
                openSafely(Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.fromParts("package", packageName, null)))
            }
        })
        section.add(kit.secondaryButton(getString(R.string.action_open_accessibility)).apply {
            setOnClickListener { openSafely(Intent(Settings.ACTION_ACCESSIBILITY_SETTINGS)) }
        }, 4)

        // Step 3: recording controls
        section.add(kit.heading(Style.SUBHEAD, getString(R.string.screen_step_recording)), 20)
        recordingSwitch = SwitchCompat(this).apply {
            text = getString(R.string.label_recording_switch)
            textSize = 16f
            minHeight = kit.dp(48)
            isChecked = screenSettings.enabled
            setOnCheckedChangeListener { _, checked -> onRecordingSwitch(checked) }
        }
        section.add(recordingSwitch, 4)
        pauseButton = kit.secondaryButton("").apply {
            setOnClickListener {
                screenSettings.pausedUntil = if (screenSettings.isPaused()) 0L else System.currentTimeMillis() + PAUSE_MS
                renderScreen()
            }
        }
        section.add(pauseButton, 4)

        // Upload
        section.add(kit.heading(Style.SUBHEAD, getString(R.string.screen_upload_heading)), 20)
        section.add(kit.text(Style.CAPTION, getString(R.string.screen_upload_note)), 4)
        uploadButton = kit.secondaryButton(getString(R.string.action_upload_now)).apply {
            setOnClickListener { if (ensureScreenSaved()) model.uploadScreen() }
        }
        section.add(uploadButton, 8)
        testButton = kit.secondaryButton(getString(R.string.action_test_connection)).apply {
            setOnClickListener { if (ensureScreenSaved()) model.testScreenConnection(use24Hour) }
        }
        section.add(testButton, 4)
        uploadHint = kit.liveText(Style.CAPTION).apply { setPadding(kit.dp(4), kit.dp(4), 0, 0) }
        section.add(uploadHint)
        screenProgress = kit.progress(getString(R.string.screen_task_in_progress))
        section.add(screenProgress, 8)
        screenResult = kit.statusBox().apply {
            visibility = View.GONE
            setTextIsSelectable(true)
        }
        section.add(screenResult, 8)
        screenRetryButton = kit.secondaryButton(getString(R.string.action_retry)).apply {
            visibility = View.GONE
            setOnClickListener {
                when (model.screen.value.failed) {
                    ScreenTask.UPLOAD -> uploadButton.performClick()
                    ScreenTask.TEST -> testButton.performClick()
                    null -> Unit
                }
            }
        }
        section.add(screenRetryButton, 4)
    }

    // endregion

    // region Connection settings

    private fun validate(field: Field): FieldResult<*> = when (field) {
        endpointField -> endpointResult()
        tokenField -> InputValidation.token(field.value, "HEALTH_CONNECT_TOKEN", required = true)
        historyDaysField -> InputValidation.historyDays(field.value)
        phoneTokenField -> InputValidation.token(field.value, "DAYFLOW_PHONE_TOKEN", required = false)
        exclusionsField -> InputValidation.exclusions(field.value)
        else -> FieldResult.Valid(field.value)
    }

    private fun connectionDirty(): Boolean =
        endpointField.value.trim().trimEnd('/') != settings.endpoint ||
            tokenField.value.trim() != savedHealthToken ||
            historyDaysField.value.trim() != settings.historyDays.toString()

    private fun savedConnectionReady(): Boolean =
        InputValidation.endpoint(settings.endpoint).isValid &&
            InputValidation.token(savedHealthToken, "token", required = true).isValid

    private enum class SaveResult { SAVED, INVALID, AWAITING_CONFIRMATION, BLOCKED }

    /** Endpoint validation plus a note when the edit points to a new sync destination. */
    private fun endpointResult(): FieldResult<String> {
        val result = InputValidation.endpoint(endpointField.value)
        val note = (result as? FieldResult.Valid)?.let {
            DestinationChange.fieldNote(settings.endpoint, it.value, destinationTies())
        }
        return if (result is FieldResult.Valid && note != null) result.copy(note = note) else result
    }

    /** Shows or hides the new-destination note while typing; errors still wait for the field to lose focus. */
    private fun showEndpointNote() {
        val result = endpointResult()
        if (result is FieldResult.Valid) endpointField.show(result)
    }

    private val historyPermissionGranted: Boolean
        get() = HealthPermission.PERMISSION_READ_HEALTH_DATA_HISTORY in granted.orEmpty()

    /**
     * Validates every connection field and saves them when all are valid. Changing the sync
     * destination after a sync first asks for confirmation (the next sync re-imports history);
     * [afterConfirmedSave] runs once that confirmed save succeeds.
     */
    private fun saveConnection(showSuccess: Boolean, afterConfirmedSave: () -> Unit = {}): SaveResult {
        val endpoint = endpointResult()
        val token = InputValidation.token(tokenField.value, "HEALTH_CONNECT_TOKEN", required = true)
        val days = InputValidation.historyDays(historyDaysField.value)
        endpointField.show(endpoint)
        tokenField.show(token)
        historyDaysField.show(days)
        val firstInvalid = listOf(endpointField to endpoint, tokenField to token, historyDaysField to days)
            .firstOrNull { !it.second.isValid }
        if (firstInvalid != null) {
            connectionSection.setExpanded(true)
            focusField(firstInvalid.first)
            connectionSaveState.text = getString(R.string.save_state_fix_errors)
            kit.setTone(connectionSaveState, Tone.ERROR, tintBackground = false)
            return SaveResult.INVALID
        }
        val endpointValue = requireNotNull(endpoint.valueOrNull())
        val tokenValue = requireNotNull(token.valueOrNull())
        val daysValue = requireNotNull(days.valueOrNull())
        val ties = destinationTies()
        return when (DestinationChange.decide(settings.endpoint, endpointValue, ties)) {
            DestinationChange.Action.KEEP -> commitConnection(endpointValue, tokenValue, daysValue, reset = null, showSuccess)
            DestinationChange.Action.RESET ->
                commitConnection(endpointValue, tokenValue, daysValue, reset = ResetKind.QUIET, showSuccess)
            DestinationChange.Action.CONFIRM_RESET -> {
                if (model.sync.value.busy || ScreenUploader.isUploading) {
                    showDestinationBusy()
                    return SaveResult.BLOCKED
                }
                val reimportDays = DestinationChange.reimportDays(daysValue, historyPermissionGranted)
                val kind = if (ties.hasSyncProgress) ResetKind.REIMPORT else ResetKind.QUIET
                AlertDialog.Builder(this)
                    .setTitle(R.string.destination_change_title)
                    .setMessage(DestinationChange.confirmMessage(hostOf(endpointValue), ties, reimportDays.takeIf { ties.hasSyncProgress }))
                    .setPositiveButton(
                        if (ties.hasSyncProgress) R.string.destination_change_ok else R.string.destination_change_ok_no_reimport,
                    ) { _, _ ->
                        val saved = commitConnection(endpointValue, tokenValue, daysValue, kind, showSuccess)
                        if (saved == SaveResult.SAVED) afterConfirmedSave()
                    }
                    .setNegativeButton(R.string.action_cancel, null)
                    .show()
                SaveResult.AWAITING_CONFIRMATION
            }
        }
    }

    private enum class ResetKind { QUIET, REIMPORT }

    /** Writes validated values; [reset] also clears the sync cursor for a new destination. */
    private fun commitConnection(endpointValue: String, tokenValue: String, daysValue: Int, reset: ResetKind?, showSuccess: Boolean): SaveResult {
        if (reset == null) {
            settings.endpoint = endpointValue
            reimportDaysAfterSave = null
        } else {
            val reimportDays = DestinationChange.reimportDays(daysValue, historyPermissionGranted)
            val status = if (reset == ResetKind.REIMPORT) "${Instant.now()}：${DestinationChange.resetStatus(reimportDays)}" else null
            // Under both the screen-upload and the sync lock, so neither an upload run nor a sync can
            // straddle the change or write the old destination's state afterwards. The phone token
            // belongs to the old destination and is cleared; queued screen records stay filed
            // under the old destination and are never sent to the new one.
            var done = false
            ScreenUploader.tryExclusive {
                done = SyncRunner.coordinator.tryExclusive {
                    settings.changeEndpointAndResetSync(endpointValue, status)
                    screenSettings.clearToken()
                }
            }
            if (!done) {
                showDestinationBusy()
                return SaveResult.BLOCKED
            }
            reimportDaysAfterSave = if (reset == ResetKind.REIMPORT) reimportDays else null
            savedPhoneToken = ""
            model.drafts.clear(SecretDrafts.Key.PHONE_TOKEN)
            if (phoneTokenField.value.isNotEmpty()) phoneTokenField.setValue("")
        }
        settings.token = tokenValue
        savedHealthToken = tokenValue
        model.drafts.clear(SecretDrafts.Key.HEALTH_TOKEN)
        settings.historyDays = daysValue
        // Show the normalised values (e.g. a trailing slash removed) so the form matches what was saved.
        if (endpointField.value != endpointValue) endpointField.setValue(endpointValue)
        if (tokenField.value != tokenValue) tokenField.setValue(tokenValue)
        if (historyDaysField.value != daysValue.toString()) historyDaysField.setValue(daysValue.toString())
        endpointField.show(endpointResult())
        historyDaysField.show(InputValidation.historyDays(daysValue.toString()))
        connectionJustSaved = showSuccess || reimportDaysAfterSave != null
        renderAll()
        return SaveResult.SAVED
    }

    private fun showDestinationBusy() {
        connectionSection.setExpanded(true)
        connectionSaveState.text = getString(R.string.destination_change_busy)
        kit.setTone(connectionSaveState, Tone.ERROR, tintBackground = false)
    }

    /** What is tied to the saved destination: sync progress, queued screen records, a phone token. */
    private fun destinationTies() = DestinationChange.Ties(
        hasSyncProgress = settings.hasSyncProgress,
        screenPending = ObservationQueue.get(this).count(currentDestination()),
        phoneTokenSaved = savedPhoneToken.isNotEmpty(),
    )

    private fun currentDestination(): String = DestinationChange.normalize(settings.endpoint)

    private fun renderConnectionState() {
        val dirty = connectionDirty()
        val reimportDays = reimportDaysAfterSave
        val state = FormState.connection(dirty, connectionJustSaved, reimportDays != null, savedConnectionReady())
        val tone = state.tone
        connectionSaveState.text = when (state) {
            SaveState.UNSAVED -> getString(R.string.save_state_unsaved)
            SaveState.SAVED_NEW_DESTINATION -> getString(R.string.save_state_saved_new_destination, reimportDays ?: 0)
            SaveState.JUST_SAVED -> getString(R.string.save_state_saved)
            SaveState.CLEAN -> getString(R.string.save_state_clean)
            SaveState.INCOMPLETE -> getString(R.string.save_state_incomplete)
        }
        if (tone == Tone.NEUTRAL) connectionSaveState.setTextColor(kit.color(R.color.text_secondary)) else kit.setTone(connectionSaveState, tone, tintBackground = false)
        val summary = when {
            dirty -> getString(R.string.connection_summary_unsaved) to Tone.WARNING
            savedConnectionReady() -> getString(R.string.connection_summary_ready, hostOf(settings.endpoint)) to Tone.OK
            else -> getString(R.string.connection_summary_incomplete) to Tone.WARNING
        }
        connectionSection.setSummary(summary.first, summary.second)
        updateBackCallback()
    }

    private fun hostOf(endpoint: String): String = runCatching { endpoint.toUri().host }.getOrNull() ?: endpoint

    /** Why the sync buttons cannot use the current connection settings, or null when they can. */
    private fun connectionProblem(): String? {
        val valid = InputValidation.endpoint(endpointField.value).isValid &&
            InputValidation.token(tokenField.value, "token", required = true).isValid &&
            InputValidation.historyDays(historyDaysField.value).isValid
        return when {
            valid -> null
            connectionDirty() -> getString(R.string.sync_blocked_invalid_inputs)
            else -> getString(R.string.sync_blocked_no_connection)
        }
    }

    // endregion

    // region Health Connect

    private suspend fun refreshHealth() {
        val status = HealthConnectAvailability.fromSdkStatus(HealthConnectClient.getSdkStatus(this))
        availability = status
        if (status != HealthConnectAvailability.AVAILABLE) {
            granted = null
            permissionError = null
            return
        }
        try {
            val client = HealthConnectClient.getOrCreate(this)
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

    private fun renderHealth() {
        if (!::healthStatusBox.isInitialized) return
        val sync = model.sync.value
        val ui = HealthStatus.map(
            HealthInputs(
                availability = availability,
                granted = granted,
                requiredRead = HealthConnectSync.readPermissions,
                sleepPermission = HealthPermission.getReadPermission(SleepSessionRecord::class),
                backgroundPermission = HealthPermission.PERMISSION_READ_HEALTH_DATA_IN_BACKGROUND,
                historyPermission = HealthPermission.PERMISSION_READ_HEALTH_DATA_HISTORY,
                connectionProblem = connectionProblem(),
                syncing = sync.running != null,
                backgroundSyncRunning = sync.backgroundRunning,
                permissionRequestHadNoEffect = permissionRequestHadNoEffect,
                permissionError = permissionError,
            ),
        )
        healthUi = ui
        healthStatusBox.text = listOfNotNull(ui.headline, ui.detail).joinToString("\n")
        kit.setTone(healthStatusBox, ui.tone)
        healthActionButton.visibility = if (ui.actionLabel == null) View.GONE else View.VISIBLE
        healthActionButton.text = ui.actionLabel
        sleepButton.isEnabled = ui.sleepEnabled
        syncButton.isEnabled = ui.syncEnabled
        syncHint.text = ui.syncHint
        syncHint.visibility = if (ui.syncHint == null) View.GONE else View.VISIBLE

        val running = sync.running != null
        val busy = sync.busy
        syncProgress.visibility = if (busy) View.VISIBLE else View.GONE
        syncProgressText.visibility = if (busy) View.VISIBLE else View.GONE
        syncProgressText.text = sync.progress ?: if (sync.backgroundRunning) getString(R.string.background_sync_in_progress) else null
        syncErrorBox.visibility = if (sync.error != null && !running) View.VISIBLE else View.GONE
        syncErrorBox.text = sync.error?.let {
            getString(
                when (sync.failed) {
                    SyncKind.SLEEP -> R.string.sync_failed_sleep
                    SyncKind.REVERIFY -> R.string.sync_failed_reverify
                    else -> R.string.sync_failed_full
                },
                it,
            )
        }
        kit.setTone(syncErrorBox, Tone.ERROR)
        syncRetryButton.visibility = if (sync.failed != null && !running) View.VISIBLE else View.GONE
        syncRetryButton.isEnabled = if (sync.failed == SyncKind.SLEEP) ui.sleepEnabled else ui.syncEnabled

        val now = Instant.now()
        val zone = ZoneId.systemDefault()
        lastSyncText.text = getString(R.string.last_full_sync, TimeText.humanizeStatus(settings.lastStatus, now, zone, use24Hour))
        if (settings.lastSyncFailed) kit.setTone(lastSyncText, Tone.ERROR, tintBackground = false) else kit.setTone(lastSyncText, Tone.NEUTRAL, tintBackground = false)
        lastSleepText.text = getString(R.string.last_sleep_sync, TimeText.humanizeStatus(settings.lastSleepStatus, now, zone, use24Hour))
        kit.setTone(lastSleepText, if (HealthStatus.sleepStatusFailed(settings.lastSleepStatus)) Tone.ERROR else Tone.NEUTRAL, tintBackground = false)

        val gaps = ReconcileStatus.map(
            ReconcileGaps.decode(settings.reconcileGapsText), now, zone,
            syncReady = ui.syncEnabled, syncHint = ui.syncHint,
        )
        reconcileBox.visibility = if (gaps == null) View.GONE else View.VISIBLE
        reverifyButton.visibility = reconcileBox.visibility
        if (gaps != null) {
            reconcileBox.text = listOf(gaps.headline, gaps.detail).joinToString("\n")
            kit.setTone(reconcileBox, Tone.WARNING)
            reverifyButton.isEnabled = gaps.reverifyEnabled
        }
        reverifyHint.text = gaps?.reverifyHint
        reverifyHint.visibility = if (gaps?.reverifyHint == null) View.GONE else View.VISIBLE

        val lastSync = TimeText.splitStatus(settings.lastStatus).first
        val summary = buildString {
            append(ui.headline)
            if (gaps != null) append(" · ").append(getString(R.string.health_summary_unverified))
            if (lastSync != null) append(" · ").append(getString(R.string.health_summary_last, TimeText.relative(lastSync, now)))
        }
        val summaryTone = if (gaps != null && ui.tone == Tone.OK) Tone.WARNING else ui.tone
        healthSection.setSummary(if (busy) getString(R.string.sync_in_progress) else summary, if (busy) Tone.NEUTRAL else summaryTone)
        renderNotifications()
        renderSetup()
    }

    private fun renderNotifications() {
        if (!::notifySwitch.isInitialized) return
        val permission = SyncFailureNotifier.permissionGranted(this)
        val on = settings.notifyOnSyncFailure
        updatingNotifySwitch = true
        notifySwitch.isChecked = on && permission
        updatingNotifySwitch = false
        notifyNote.text = when {
            on && permission -> getString(R.string.notify_on, SyncFailureAlerts.THRESHOLD, SyncFailureAlerts.THRESHOLD * SyncFailureAlerts.PERIOD_HOURS)
            on -> getString(R.string.notify_permission_revoked)
            notificationPermissionDenied -> getString(R.string.notify_denied)
            else -> getString(R.string.notify_off, SyncFailureAlerts.THRESHOLD)
        }
        val tone = if ((on && !permission) || notificationPermissionDenied) Tone.WARNING else Tone.NEUTRAL
        if (tone == Tone.NEUTRAL) notifyNote.setTextColor(kit.color(R.color.text_secondary)) else kit.setTone(notifyNote, tone, tintBackground = false)
    }

    private fun onNotifySwitch(checked: Boolean) {
        if (updatingNotifySwitch) return
        notificationPermissionDenied = false
        if (!checked) {
            settings.notifyOnSyncFailure = false
            SyncFailureNotifier.cancel(this)
            renderNotifications()
            return
        }
        if (SyncFailureNotifier.permissionGranted(this)) {
            settings.notifyOnSyncFailure = true
            renderNotifications()
        } else {
            // Show the switch as off until the user answers the system dialog.
            updatingNotifySwitch = true
            notifySwitch.isChecked = false
            updatingNotifySwitch = false
            notificationPermissionLauncher.launch(Manifest.permission.POST_NOTIFICATIONS)
        }
    }

    private fun performHealthAction() {
        when (healthUi?.action) {
            HealthAction.INSTALL_OR_UPDATE -> openHealthConnectInstall()
            HealthAction.GRANT -> requestHealthPermissions()
            HealthAction.MANAGE -> openHealthConnectSettings()
            HealthAction.NONE, null -> Unit
        }
    }

    private fun requestHealthPermissions() {
        if (availability != HealthConnectAvailability.AVAILABLE) return
        grantedBeforeRequest = granted.orEmpty()
        permissionRequestHadNoEffect = false
        try {
            permissionLauncher.launch(permissionsToRequest(HealthConnectClient.getOrCreate(this)))
        } catch (_: ActivityNotFoundException) {
            openHealthConnectSettings()
        }
    }

    /** Opens Infovore's page in Health Connect's permission settings, falling back to Health Connect itself. */
    private fun openHealthConnectSettings() {
        val appPermissions = Intent(HealthConnectManager.ACTION_MANAGE_HEALTH_PERMISSIONS)
            .putExtra(Intent.EXTRA_PACKAGE_NAME, packageName)
        if (openSafely(appPermissions, showError = false)) return
        val manage = runCatching { HealthConnectClient.getHealthConnectManageDataIntent(this) }.getOrNull()
        if (manage != null && openSafely(manage, showError = false)) return
        openSafely(Intent(HealthConnectClient.ACTION_HEALTH_CONNECT_SETTINGS))
    }

    private fun openHealthConnectInstall() {
        val market = Intent(Intent.ACTION_VIEW, "market://details?id=$HEALTH_CONNECT_PACKAGE&url=healthconnect%3A%2F%2Fonboarding".toUri())
            .setPackage("com.android.vending")
            .putExtra("overlay", true)
            .putExtra("callerId", packageName)
        if (openSafely(market, showError = false)) return
        openSafely(Intent(Intent.ACTION_VIEW, "https://play.google.com/store/apps/details?id=$HEALTH_CONNECT_PACKAGE".toUri()))
    }

    private fun startSync(kind: SyncKind) {
        if (model.sync.value.busy) return
        if (connectionDirty()) {
            when (saveConnection(showSuccess = false) { startSync(kind) }) {
                SaveResult.SAVED -> Unit
                SaveResult.INVALID -> {
                    syncHint.text = getString(R.string.sync_blocked_invalid_inputs)
                    syncHint.visibility = View.VISIBLE
                    return
                }
                // Continues from the confirmation dialog, or a running sync blocks the change.
                SaveResult.AWAITING_CONFIRMATION, SaveResult.BLOCKED -> return
            }
        }
        val ui = healthUi
        // Re-verification reads the same types as a full sync, so it needs the same permissions.
        val allowed = if (kind == SyncKind.SLEEP) ui?.sleepEnabled else ui?.syncEnabled
        if (allowed != true) {
            renderHealth()
            return
        }
        model.startSync(kind)
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

    // endregion

    // region First-run steps

    private fun renderSetup() {
        if (!::setupSummary.isInitialized) return
        val steps = SetupProgress.compute(
            connectionSaved = savedConnectionReady(),
            permissionsGranted = granted?.containsAll(HealthConnectSync.readPermissions) == true,
            firstSyncDone = settings.initialImportDone,
            background = backgroundSyncState(),
            partialImport = settings.initialImportPartial,
        )
        setupSummary.text = SetupProgress.summary(steps)
        steps.forEachIndexed { index, step ->
            val row = setupRows[index]
            val marker = when (step.state) {
                StepState.DONE -> "✓"
                StepState.CURRENT -> "➜"
                StepState.PENDING -> "○"
            }
            row.text = getString(R.string.setup_step_row, marker, step.number, step.step.title, step.text)
            row.contentDescription = step.accessibilityText
            when (step.state) {
                StepState.DONE -> kit.setTone(row, Tone.OK, tintBackground = false)
                StepState.CURRENT -> kit.setTone(row, Tone.NEUTRAL, tintBackground = false)
                StepState.PENDING -> row.setTextColor(kit.color(R.color.text_secondary))
            }
        }
        val next = SetupProgress.nextStep(steps)
        setupNextButton.visibility = if (next == null) View.GONE else View.VISIBLE
        setupNextButton.text = when (next) {
            SetupStep.CONNECTION -> getString(R.string.setup_next_connection)
            SetupStep.PERMISSIONS -> healthUi?.actionLabel ?: getString(R.string.setup_next_permissions)
            SetupStep.FIRST_SYNC -> getString(R.string.action_sync_all)
            null -> ""
        }
        setupNextButton.isEnabled = when (next) {
            SetupStep.FIRST_SYNC -> healthUi?.syncEnabled == true
            else -> !model.sync.value.busy
        }
    }

    private fun backgroundSyncState(): BackgroundSync = when {
        backgroundSupported == false -> BackgroundSync.UNSUPPORTED
        granted == null || backgroundSupported == null -> BackgroundSync.UNKNOWN
        HealthPermission.PERMISSION_READ_HEALTH_DATA_IN_BACKGROUND in granted.orEmpty() -> BackgroundSync.GRANTED
        else -> BackgroundSync.NOT_GRANTED
    }

    private fun goToNextStep() {
        val steps = SetupProgress.compute(
            savedConnectionReady(),
            granted?.containsAll(HealthConnectSync.readPermissions) == true,
            settings.initialImportDone,
        )
        when (SetupProgress.nextStep(steps)) {
            SetupStep.CONNECTION -> {
                connectionSection.setExpanded(true)
                val target = listOf(endpointField, tokenField, historyDaysField).firstOrNull { !validate(it).isValid } ?: tokenField
                focusField(target)
            }
            SetupStep.PERMISSIONS -> {
                healthSection.setExpanded(true)
                if (healthUi?.action != HealthAction.NONE) performHealthAction() else scrollTo(healthSection.root)
            }
            SetupStep.FIRST_SYNC -> {
                healthSection.setExpanded(true)
                scrollTo(healthSection.root)
                startSync(SyncKind.FULL)
            }
            null -> Unit
        }
    }

    // endregion

    // region Phone screen recording

    private fun screenDirty(): Boolean =
        phoneTokenField.value.trim() != savedPhoneToken ||
            exclusionsField.value.trim() != screenSettings.exclusionsText

    private fun saveScreen(showSuccess: Boolean): Boolean {
        val token = InputValidation.token(phoneTokenField.value, "DAYFLOW_PHONE_TOKEN", required = false)
        val exclusions = InputValidation.exclusions(exclusionsField.value)
        phoneTokenField.show(token)
        exclusionsField.show(exclusions)
        val invalid = listOf(phoneTokenField to token, exclusionsField to exclusions).firstOrNull { !it.second.isValid }
        if (invalid != null) {
            screenSection.setExpanded(true)
            focusField(invalid.first)
            screenSaveState.text = getString(R.string.save_state_fix_errors)
            kit.setTone(screenSaveState, Tone.ERROR, tintBackground = false)
            return false
        }
        savedPhoneToken = requireNotNull(token.valueOrNull())
        // Bound to the destination saved right now; uploads never send it anywhere else.
        screenSettings.saveToken(savedPhoneToken, currentDestination())
        model.drafts.clear(SecretDrafts.Key.PHONE_TOKEN)
        screenSettings.exclusionsText = requireNotNull(exclusions.valueOrNull())
        if (phoneTokenField.value != savedPhoneToken) phoneTokenField.setValue(savedPhoneToken)
        screenJustSaved = showSuccess
        renderScreen()
        return true
    }

    /** Upload and connection test use saved values; pending edits are validated and saved first. */
    private fun ensureScreenSaved(): Boolean = !screenDirty() || saveScreen(showSuccess = false)

    private fun renderScreenSaveState() {
        val state = FormState.screen(screenDirty(), screenJustSaved)
        val tone = state.tone
        screenSaveState.text = when (state) {
            SaveState.UNSAVED -> getString(R.string.save_state_unsaved)
            SaveState.JUST_SAVED, SaveState.SAVED_NEW_DESTINATION -> getString(
                R.string.screen_saved, screenSettings.exclusions.size, Exclusions.DEFAULT_PACKAGES.size,
            )
            SaveState.CLEAN, SaveState.INCOMPLETE -> getString(R.string.save_state_clean)
        }
        if (tone == Tone.NEUTRAL) screenSaveState.setTextColor(kit.color(R.color.text_secondary)) else kit.setTone(screenSaveState, tone, tintBackground = false)
    }

    private fun renderScreen() {
        if (!::screenStatusBox.isInitialized) return
        val serviceEnabled = isScreenServiceEnabled()
        val queue = ObservationQueue.get(this)
        val destination = currentDestination()
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
                use24Hour = use24Hour,
                otherDestinationPending = queue.countOtherDestinations(destination),
                rejected = queue.countRejected(),
            ),
        )
        rejectedBox.text = ui.rejectedNote
        rejectedBox.visibility = if (ui.rejectedNote == null) View.GONE else View.VISIBLE
        deleteRejectedButton.visibility = rejectedBox.visibility
        otherDestinationBox.text = ui.otherDestinationNote
        otherDestinationBox.visibility = if (ui.otherDestinationNote == null) View.GONE else View.VISIBLE
        deleteOtherDestinationButton.visibility = otherDestinationBox.visibility
        screenStatusBox.text = listOfNotNull(ui.headline, ui.nextStep).joinToString("\n")
        kit.setTone(screenStatusBox, ui.tone)
        screenDetails.text = ui.details
        screenSection.setSummary(ui.summary, if (ui.tone == Tone.OK) Tone.OK else Tone.NEUTRAL)

        accessibilityStatus.text = getString(if (serviceEnabled) R.string.accessibility_on else R.string.accessibility_off)
        kit.setTone(accessibilityStatus, if (serviceEnabled) Tone.OK else Tone.NEUTRAL, tintBackground = false)

        updatingSwitch = true
        recordingSwitch.isChecked = screenSettings.enabled
        updatingSwitch = false
        pauseButton.text = ui.pauseLabel
        pauseButton.isEnabled = ui.pauseEnabled

        val task = model.screen.value
        val busy = task.running != null
        uploadButton.isEnabled = ui.uploadEnabled && !busy
        testButton.isEnabled = tokenUsable && !busy
        uploadHint.text = ui.uploadHint
        uploadHint.visibility = if (ui.uploadHint == null) View.GONE else View.VISIBLE
        screenProgress.visibility = if (busy) View.VISIBLE else View.GONE
        screenResult.visibility = if (busy || task.result != null) View.VISIBLE else View.GONE
        screenResult.text = when (task.running) {
            ScreenTask.UPLOAD -> getString(R.string.screen_uploading)
            ScreenTask.TEST -> getString(R.string.screen_testing)
            null -> task.result
        }
        kit.setTone(screenResult, if (busy) Tone.NEUTRAL else task.tone)
        screenRetryButton.visibility = if (task.failed != null && !busy) View.VISIBLE else View.GONE
        renderScreenSaveState()
    }

    private fun onRecordingSwitch(checked: Boolean) {
        if (updatingSwitch) return
        if (!checked) {
            screenSettings.enabled = false
            renderScreen()
            return
        }
        // Turning recording on is always an explicit, confirmed user choice.
        AlertDialog.Builder(this)
            .setTitle(R.string.confirm_recording_title)
            .setMessage(R.string.confirm_recording_message)
            .setPositiveButton(R.string.confirm_recording_ok) { _, _ ->
                screenSettings.enabled = true
                renderScreen()
            }
            .setNegativeButton(R.string.action_cancel, null)
            .setOnDismissListener { renderScreen() }
            .show()
    }

    /** Deletes, after confirmation, the queued records of earlier destinations. Never migrates them. */
    private fun confirmDeleteOtherDestination() {
        val count = ObservationQueue.get(this).countOtherDestinations(currentDestination())
        if (count == 0) {
            renderScreen()
            return
        }
        AlertDialog.Builder(this)
            .setTitle(R.string.delete_other_destination_title)
            .setMessage(getString(R.string.delete_other_destination_message, count))
            .setPositiveButton(R.string.delete_other_destination_ok) { _, _ ->
                val removed = ScreenUploader.deleteOtherDestinations(this)
                Toast.makeText(
                    this,
                    if (removed == null) getString(R.string.delete_other_destination_busy)
                    else getString(R.string.delete_other_destination_done, removed),
                    Toast.LENGTH_LONG,
                ).show()
                renderScreen()
            }
            .setNegativeButton(R.string.action_cancel, null)
            .show()
    }

    /** Deletes, after confirmation, the records the server rejected. Never re-sends them. */
    private fun confirmDeleteRejected() {
        val count = ObservationQueue.get(this).countRejected()
        if (count == 0) {
            renderScreen()
            return
        }
        AlertDialog.Builder(this)
            .setTitle(R.string.delete_rejected_title)
            .setMessage(getString(R.string.delete_rejected_message, count))
            .setPositiveButton(R.string.delete_other_destination_ok) { _, _ ->
                val removed = ScreenUploader.deleteRejected(this)
                Toast.makeText(
                    this,
                    if (removed == null) getString(R.string.delete_other_destination_busy)
                    else getString(R.string.delete_rejected_done, removed),
                    Toast.LENGTH_LONG,
                ).show()
                renderScreen()
            }
            .setNegativeButton(R.string.action_cancel, null)
            .show()
    }

    private fun isScreenServiceEnabled(): Boolean {
        val expected = ComponentName(this, ScreenActivityService::class.java)
        val enabled = Settings.Secure.getString(contentResolver, Settings.Secure.ENABLED_ACCESSIBILITY_SERVICES).orEmpty()
        return enabled.split(':').any { ComponentName.unflattenFromString(it) == expected }
    }

    // endregion

    // region Shared helpers

    private fun observeModel() {
        lifecycleScope.launch {
            repeatOnLifecycle(Lifecycle.State.STARTED) {
                launch {
                    var wasBusy = false
                    model.sync.collect { state ->
                        if (state.running != null) {
                            window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
                        } else {
                            window.clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
                        }
                        if (wasBusy && !state.busy) refreshHealth()
                        wasBusy = state.busy
                        renderHealth()
                    }
                }
                launch { model.screen.collect { renderScreen() } }
            }
        }
    }

    private fun renderAll() {
        renderConnectionState()
        renderHealth()
        renderScreen()
    }

    private fun updateBackCallback() {
        if (!::screenSaveState.isInitialized) return
        backCallback.isEnabled = FormState.confirmBeforeLeaving(connectionDirty(), screenDirty())
    }

    private fun confirmDiscardChanges() {
        AlertDialog.Builder(this)
            .setTitle(R.string.unsaved_title)
            .setMessage(R.string.unsaved_message)
            .setPositiveButton(R.string.unsaved_save) { _, _ -> saveAllAndFinish() }
            .setNegativeButton(R.string.unsaved_discard) { _, _ ->
                model.drafts.clearAll()
                finish()
            }
            .setNeutralButton(R.string.unsaved_keep_editing, null)
            .show()
    }

    /** Saves both forms, then leaves; a destination change finishes from its confirmation dialog. */
    private fun saveAllAndFinish() {
        val screenOk = !screenDirty() || saveScreen(showSuccess = true)
        val finishIfSaved = { if (screenOk && !connectionDirty() && !screenDirty()) finish() }
        if (!connectionDirty()) {
            finishIfSaved()
        } else if (saveConnection(showSuccess = true, afterConfirmedSave = finishIfSaved) == SaveResult.SAVED) {
            finishIfSaved()
        }
    }

    private fun focusField(field: Field) {
        field.input.requestFocus()
        scrollTo(field.input)
    }

    private fun scrollTo(view: View) {
        scroll.post {
            val rect = android.graphics.Rect()
            view.getDrawingRect(rect)
            scroll.offsetDescendantRectToMyCoords(view, rect)
            scroll.smoothScrollTo(0, (rect.top - kit.dp(24)).coerceAtLeast(0))
        }
    }

    private fun openSafely(intent: Intent, showError: Boolean = true): Boolean = try {
        startActivity(intent)
        true
    } catch (_: ActivityNotFoundException) {
        if (showError) Toast.makeText(this, R.string.error_no_activity, Toast.LENGTH_LONG).show()
        false
    }

    /** Caps the content width on tablets and in landscape so lines stay readable. */
    private class MaxWidthColumn(context: android.content.Context, private val maxWidthPx: Int) : LinearLayout(context) {
        init {
            orientation = VERTICAL
        }

        override fun onMeasure(widthMeasureSpec: Int, heightMeasureSpec: Int) {
            val width = MeasureSpec.getSize(widthMeasureSpec)
            val spec = if (width > maxWidthPx) MeasureSpec.makeMeasureSpec(maxWidthPx, MeasureSpec.EXACTLY) else widthMeasureSpec
            super.onMeasure(spec, heightMeasureSpec)
        }
    }

    // endregion

    companion object {
        /** Intent extra: expand and scroll to the health section (from the sync-problem notification). */
        const val EXTRA_OPEN_HEALTH = "tw.skyhong.infovore.health.OPEN_HEALTH"
        private const val PAUSE_MS = 60 * 60_000L
        private const val HEALTH_CONNECT_PACKAGE = "com.google.android.apps.healthdata"
        private const val STATE_CONNECTION_OPEN = "connection_open"
        private const val STATE_HEALTH_OPEN = "health_open"
        private const val STATE_SCREEN_OPEN = "screen_open"
    }
}
