package tw.skyhong.infovore.health

import com.google.android.material.dialog.MaterialAlertDialogBuilder
import android.content.Context
import android.content.Intent
import android.os.Bundle
import android.view.Gravity
import android.view.View
import android.widget.FrameLayout
import android.widget.ImageView
import android.widget.LinearLayout
import android.widget.ScrollView
import androidx.activity.OnBackPressedCallback
import androidx.appcompat.app.AppCompatActivity
import androidx.core.view.ViewCompat
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.ViewModelProvider
import androidx.lifecycle.lifecycleScope
import androidx.lifecycle.repeatOnLifecycle
import kotlinx.coroutines.launch
import tw.skyhong.infovore.health.main.ConnectionController
import tw.skyhong.infovore.health.main.HealthController
import tw.skyhong.infovore.health.main.LocationController
import tw.skyhong.infovore.health.update.UpdatePrompt
import tw.skyhong.infovore.health.main.SetupController
import tw.skyhong.infovore.health.main.UiHost
import tw.skyhong.infovore.health.ui.FormState
import tw.skyhong.infovore.health.ui.ViewKit
import tw.skyhong.infovore.health.ui.ViewKit.Style

/**
 * Settings and status screen, organised as: first-run steps, connection settings and Health
 * Connect sync. The activity only assembles
 * the section controllers in `main/` and handles the lifecycle; each controller builds its views
 * with [ViewKit], and every decision about what to show lives in the pure, unit-tested classes in
 * `ui/`.
 */
class MainActivity : AppCompatActivity() {
    private lateinit var host: UiHost
    private lateinit var connection: ConnectionController
    private lateinit var health: HealthController
    private lateinit var setup: SetupController
    private lateinit var location: LocationController
    private lateinit var updates: UpdatePrompt
    private var built = false

    /** Whether the health section may still open itself after the first status check (not after a restore). */
    private var autoExpandHealth = false

    private val backCallback = object : OnBackPressedCallback(false) {
        override fun handleOnBackPressed() = confirmDiscardChanges()
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        WindowCompat.setDecorFitsSystemWindows(window, false)
        val model = ViewModelProvider(this)[MainViewModel::class.java]
        host = UiHost(this, ViewKit(this), SecureSettings(this), model)
        connection = ConnectionController(
            host,
            historyPermissionGranted = { health.historyPermissionGranted },
            onEdited = { health.render() },
            onSaved = ::renderAll,
            onDirtyChanged = ::updateBackCallback,
        )
        health = HealthController(
            host,
            connection = { connection },
            onRendered = { setup.render() },
            fixOfferedElsewhere = { ::location.isInitialized && location.fixOffered },
            onFixChanged = { if (::location.isInitialized) location.render() },
        )
        setup = SetupController(host, connection, health)
        location = LocationController(host, connectionReady = { connection.savedReady() }, onFixChanged = { health.render() }, fixOfferedElsewhere = { health.fixOffered })
        updates = UpdatePrompt(this)
        autoExpandHealth = savedInstanceState == null
        setContentView(buildContent(savedInstanceState))
        built = true
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

    /** The "同步問題" notification opens the health section, the recording notification the location one. */
    private fun handleOpenIntent(intent: Intent?) {
        if (intent == null) return
        val section = when {
            intent.getBooleanExtra(EXTRA_OPEN_HEALTH, false) -> health.section
            intent.getBooleanExtra(EXTRA_OPEN_LOCATION, false) -> location.section
            else -> return
        }
        intent.removeExtra(EXTRA_OPEN_HEALTH)
        intent.removeExtra(EXTRA_OPEN_LOCATION)
        section.setExpanded(true)
        host.scrollTo(section.root)
    }

    override fun onResume() {
        super.onResume()
        // Permissions can change in system settings while we are away.
        lifecycleScope.launch {
            health.refresh()
            health.render()
            // Something needs attention (a failure, a missing permission): show the details at once.
            if (autoExpandHealth) {
                autoExpandHealth = false
                if (connection.savedReady() && !health.healthy && !health.section.expanded) health.section.setExpanded(true)
            }
        }
        // Notifications may have been turned back on in system settings: deliver what was missed.
        health.catchUpNotifications()
        // Location permission can change in system settings too; recording that was on resumes.
        location.resume()
        // The launch screen: also looks for a newer GitHub release (rate-limited).
        updates.checkAutomatically()
    }

    override fun onSaveInstanceState(outState: Bundle) {
        super.onSaveInstanceState(outState)
        outState.putBoolean(STATE_CONNECTION_OPEN, connection.section.expanded)
        outState.putBoolean(STATE_HEALTH_OPEN, health.section.expanded)
        outState.putBoolean(STATE_LOCATION_OPEN, location.section.expanded)
    }

    private fun buildContent(saved: Bundle?): View {
        val kit = host.kit
        val content = MaxWidthColumn(this, kit.dp(640)).apply {
            // Takes the initial focus, so no field gets a cursor or the keyboard on its own.
            isFocusableInTouchMode = true
            setPadding(kit.dp(16), kit.dp(12), kit.dp(16), kit.dp(24))
        }
        content.addView(buildHeader())
        val configured = connection.savedReady() && host.settings.initialImportDone
        content.addView(setup.build(), ViewKit.matchWrap(kit.dp(12)))
        val connectionCard = connection.build(saved?.getBoolean(STATE_CONNECTION_OPEN)).root
        // Until set up, the connection comes first; afterwards it is the rarely used last section.
        if (!configured) content.addView(connectionCard, ViewKit.matchWrap(kit.dp(12)))
        // Starts collapsed: its header carries the status. Once the connection is saved it opens
        // itself after the first status check when something needs doing (see onResume).
        content.addView(health.build(saved?.getBoolean(STATE_HEALTH_OPEN) ?: false).root, ViewKit.matchWrap(kit.dp(12)))
        content.addView(location.build(saved?.getBoolean(STATE_LOCATION_OPEN) ?: false).root, ViewKit.matchWrap(kit.dp(12)))
        if (configured) content.addView(connectionCard, ViewKit.matchWrap(kit.dp(12)))
        content.addView(kit.text(Style.CAPTION, getString(R.string.footer_privacy)).apply {
            // On the cards' text edge, like everything else that is read.
            setPadding(kit.dp(20), kit.dp(16), kit.dp(20), 0)
        })

        val scroll = ScrollView(this).apply {
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
        host.scroll = scroll
        content.requestFocus()
        return scroll
    }

    private fun buildHeader(): View {
        val kit = host.kit
        // The logo on the cards' edge; 檢查更新 ends on it too.
        val row = kit.row().apply { setPadding(0, kit.dp(4), 0, kit.dp(4)) }
        row.addView(ImageView(this).apply {
            setImageResource(R.drawable.infovore_logo)
            importantForAccessibility = View.IMPORTANT_FOR_ACCESSIBILITY_NO
        }, LinearLayout.LayoutParams(kit.dp(44), kit.dp(44)))
        val titles = kit.column().apply { setPadding(kit.dp(12), 0, kit.dp(8), 0) }
        titles.addView(kit.heading(Style.TITLE, getString(R.string.app_name)))
        titles.addView(kit.text(Style.CAPTION, getString(R.string.header_version, BuildConfig.VERSION_NAME)))
        row.addView(titles, LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f))
        row.addView(kit.textButton(getString(R.string.update_check_action), trailing = true).apply {
            // A rarely used action: label size, so it does not compete with the app name.
            setTextSize(android.util.TypedValue.COMPLEX_UNIT_SP, 14f)
            setOnClickListener { updates.checkNow() }
        })
        return row
    }

    private fun observeModel() {
        lifecycleScope.launch {
            repeatOnLifecycle(Lifecycle.State.STARTED) {
                location.observe(this)
                launch {
                    var wasBusy = false
                    host.model.sync.collect { state ->
                        health.applyKeepScreenOn()
                        if (wasBusy && !state.busy) health.refresh()
                        wasBusy = state.busy
                        health.render()
                    }
                }
            }
        }
    }

    private fun renderAll() {
        connection.render()
        health.render()
        location.render()
    }

    private fun updateBackCallback() {
        if (!built) return
        backCallback.isEnabled = FormState.confirmBeforeLeaving(connection.dirty())
    }

    private fun confirmDiscardChanges() {
        MaterialAlertDialogBuilder(this)
            .setTitle(R.string.unsaved_title)
            .setMessage(R.string.unsaved_message)
            .setPositiveButton(R.string.unsaved_save) { _, _ -> saveAllAndFinish() }
            .setNegativeButton(R.string.unsaved_discard) { _, _ ->
                host.model.drafts.clearAll()
                finish()
            }
            .setNeutralButton(R.string.unsaved_keep_editing, null)
            .show()
    }

    /** Saves the form, then leaves; a destination change finishes from its confirmation dialog. */
    private fun saveAllAndFinish() {
        val finishIfSaved = { if (!connection.dirty()) finish() }
        if (!connection.dirty()) {
            finishIfSaved()
        } else if (connection.save(showSuccess = true, afterConfirmedSave = finishIfSaved) == ConnectionController.SaveResult.SAVED) {
            finishIfSaved()
        }
    }

    /** Caps the content width on tablets and in landscape so lines stay readable. */
    private class MaxWidthColumn(context: Context, private val maxWidthPx: Int) : LinearLayout(context) {
        init {
            orientation = VERTICAL
        }

        override fun onMeasure(widthMeasureSpec: Int, heightMeasureSpec: Int) {
            val width = MeasureSpec.getSize(widthMeasureSpec)
            val spec = if (width > maxWidthPx) MeasureSpec.makeMeasureSpec(maxWidthPx, MeasureSpec.EXACTLY) else widthMeasureSpec
            super.onMeasure(spec, heightMeasureSpec)
        }
    }

    companion object {
        /** Intent extra: expand and scroll to the health section (from the sync-problem notification). */
        const val EXTRA_OPEN_HEALTH = "tw.skyhong.infovore.health.OPEN_HEALTH"

        /** Intent extra: expand and scroll to the location section (from the recording notification). */
        const val EXTRA_OPEN_LOCATION = "tw.skyhong.infovore.health.OPEN_LOCATION"

        private const val STATE_CONNECTION_OPEN = "connection_open"
        private const val STATE_HEALTH_OPEN = "health_open"
        private const val STATE_LOCATION_OPEN = "location_open"
    }
}
