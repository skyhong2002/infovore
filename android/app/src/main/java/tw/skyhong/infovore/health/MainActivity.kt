package tw.skyhong.infovore.health

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
import tw.skyhong.infovore.health.MainViewModel.SyncKind
import tw.skyhong.infovore.health.screen.Exclusions
import tw.skyhong.infovore.health.screen.ObservationQueue
import tw.skyhong.infovore.health.screen.ScreenActivityService
import tw.skyhong.infovore.health.screen.ScreenSettings
import tw.skyhong.infovore.health.ui.CollapsibleSection
import tw.skyhong.infovore.health.ui.Field
import tw.skyhong.infovore.health.ui.FieldResult
import tw.skyhong.infovore.health.ui.HealthAction
import tw.skyhong.infovore.health.ui.HealthConnectAvailability
import tw.skyhong.infovore.health.ui.HealthInputs
import tw.skyhong.infovore.health.ui.HealthStatus
import tw.skyhong.infovore.health.ui.HealthUi
import tw.skyhong.infovore.health.ui.InputValidation
import tw.skyhong.infovore.health.ui.ScreenInputs
import tw.skyhong.infovore.health.ui.ScreenStatus
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

    private var availability: HealthConnectAvailability? = null
    private var granted: Set<String>? = null
    private var permissionError: String? = null
    private var permissionRequestHadNoEffect = false
    private var grantedBeforeRequest: Set<String> = emptySet()
    private var connectionJustSaved = false
    private var screenJustSaved = false
    private var updatingSwitch = false
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
        tokenField.setValue(savedHealthToken)
        historyDaysField.setValue(settings.historyDays.toString())
        for (field in listOf(endpointField, tokenField, historyDaysField)) {
            section.add(field.input.parent as View)
            field.onChange {
                connectionJustSaved = false
                field.clearErrorIfAny()
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
        phoneTokenField.setValue(savedPhoneToken)
        exclusionsField.setValue(screenSettings.exclusionsText)
        for (field in listOf(phoneTokenField, exclusionsField)) {
            section.add(field.input.parent as View)
            field.onChange {
                screenJustSaved = false
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
        endpointField -> InputValidation.endpoint(field.value)
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

    /** Validates every connection field; saves and returns true only when all are valid. */
    private fun saveConnection(showSuccess: Boolean): Boolean {
        val endpoint = InputValidation.endpoint(endpointField.value)
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
            return false
        }
        val endpointValue = requireNotNull(endpoint.valueOrNull())
        val tokenValue = requireNotNull(token.valueOrNull())
        val daysValue = requireNotNull(days.valueOrNull())
        settings.endpoint = endpointValue
        settings.token = tokenValue
        savedHealthToken = tokenValue
        settings.historyDays = daysValue
        // Show the normalised values (e.g. a trailing slash removed) so the form matches what was saved.
        if (endpointField.value != endpointValue) endpointField.setValue(endpointValue)
        if (tokenField.value != tokenValue) tokenField.setValue(tokenValue)
        if (historyDaysField.value != daysValue.toString()) historyDaysField.setValue(daysValue.toString())
        endpointField.show(endpoint)
        historyDaysField.show(days)
        connectionJustSaved = showSuccess
        renderAll()
        return true
    }

    private fun renderConnectionState() {
        val dirty = connectionDirty()
        val (text, tone) = when {
            dirty -> getString(R.string.save_state_unsaved) to Tone.WARNING
            connectionJustSaved -> getString(R.string.save_state_saved) to Tone.OK
            savedConnectionReady() -> getString(R.string.save_state_clean) to Tone.NEUTRAL
            else -> getString(R.string.save_state_incomplete) to Tone.WARNING
        }
        connectionSaveState.text = text
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
            granted = HealthConnectClient.getOrCreate(this).permissionController.getGrantedPermissions()
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
        syncProgress.visibility = if (running) View.VISIBLE else View.GONE
        syncProgressText.visibility = if (running) View.VISIBLE else View.GONE
        syncProgressText.text = sync.progress
        syncErrorBox.visibility = if (sync.error != null && !running) View.VISIBLE else View.GONE
        syncErrorBox.text = sync.error?.let {
            getString(if (sync.failed == SyncKind.SLEEP) R.string.sync_failed_sleep else R.string.sync_failed_full, it)
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

        val lastSync = TimeText.splitStatus(settings.lastStatus).first
        val summary = buildString {
            append(ui.headline)
            if (lastSync != null) append(" · ").append(getString(R.string.health_summary_last, TimeText.relative(lastSync, now)))
        }
        healthSection.setSummary(if (running) getString(R.string.sync_in_progress) else summary, if (running) Tone.NEUTRAL else ui.tone)
        renderSetup()
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
        if (model.sync.value.running != null) return
        if (connectionDirty() && !saveConnection(showSuccess = false)) {
            syncHint.text = getString(R.string.sync_blocked_invalid_inputs)
            syncHint.visibility = View.VISIBLE
            return
        }
        val ui = healthUi
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
            else -> model.sync.value.running == null
        }
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
        screenSettings.token = savedPhoneToken
        screenSettings.exclusionsText = requireNotNull(exclusions.valueOrNull())
        if (phoneTokenField.value != savedPhoneToken) phoneTokenField.setValue(savedPhoneToken)
        screenJustSaved = showSuccess
        renderScreen()
        return true
    }

    /** Upload and connection test use saved values; pending edits are validated and saved first. */
    private fun ensureScreenSaved(): Boolean = !screenDirty() || saveScreen(showSuccess = false)

    private fun renderScreenSaveState() {
        val (text, tone) = when {
            screenDirty() -> getString(R.string.save_state_unsaved) to Tone.WARNING
            screenJustSaved -> getString(
                R.string.screen_saved, screenSettings.exclusions.size, Exclusions.DEFAULT_PACKAGES.size,
            ) to Tone.OK
            else -> getString(R.string.save_state_clean) to Tone.NEUTRAL
        }
        screenSaveState.text = text
        if (tone == Tone.NEUTRAL) screenSaveState.setTextColor(kit.color(R.color.text_secondary)) else kit.setTone(screenSaveState, tone, tintBackground = false)
    }

    private fun renderScreen() {
        if (!::screenStatusBox.isInitialized) return
        val serviceEnabled = isScreenServiceEnabled()
        val ui = ScreenStatus.map(
            ScreenInputs(
                recordingEnabled = screenSettings.enabled,
                pausedUntilMs = screenSettings.pausedUntil,
                serviceEnabled = serviceEnabled,
                tokenConfigured = savedPhoneToken.length >= InputValidation.MIN_TOKEN_LENGTH,
                pending = ObservationQueue.get(this).count(),
                lastCaptureAtMs = screenSettings.lastCaptureAt,
                lastUploadStatus = screenSettings.lastUploadStatus,
                nowMs = System.currentTimeMillis(),
                zone = ZoneId.systemDefault(),
                use24Hour = use24Hour,
            ),
        )
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
        testButton.isEnabled = savedPhoneToken.length >= InputValidation.MIN_TOKEN_LENGTH && !busy
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
                    var wasRunning = false
                    model.sync.collect { state ->
                        val running = state.running != null
                        if (running) {
                            window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
                        } else {
                            window.clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
                        }
                        if (wasRunning && !running) refreshHealth()
                        wasRunning = running
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
        backCallback.isEnabled = connectionDirty() || screenDirty()
    }

    private fun confirmDiscardChanges() {
        AlertDialog.Builder(this)
            .setTitle(R.string.unsaved_title)
            .setMessage(R.string.unsaved_message)
            .setPositiveButton(R.string.unsaved_save) { _, _ ->
                val connectionOk = !connectionDirty() || saveConnection(showSuccess = true)
                val screenOk = !screenDirty() || saveScreen(showSuccess = true)
                if (connectionOk && screenOk) finish()
            }
            .setNegativeButton(R.string.unsaved_discard) { _, _ -> finish() }
            .setNeutralButton(R.string.unsaved_keep_editing, null)
            .show()
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

    private companion object {
        const val PAUSE_MS = 60 * 60_000L
        const val HEALTH_CONNECT_PACKAGE = "com.google.android.apps.healthdata"
        const val STATE_CONNECTION_OPEN = "connection_open"
        const val STATE_HEALTH_OPEN = "health_open"
        const val STATE_SCREEN_OPEN = "screen_open"
    }
}
