package tw.skyhong.infovore.health

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
import androidx.appcompat.app.AlertDialog
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
import tw.skyhong.infovore.health.main.ScreenController
import tw.skyhong.infovore.health.main.SetupController
import tw.skyhong.infovore.health.main.UiHost
import tw.skyhong.infovore.health.screen.ScreenSettings
import tw.skyhong.infovore.health.ui.FormState
import tw.skyhong.infovore.health.ui.ViewKit
import tw.skyhong.infovore.health.ui.ViewKit.Style

/**
 * Settings and status screen, organised as: first-run steps, connection settings, Health Connect
 * sync, and the opt-in phone screen recorder (collapsed, advanced). The activity only assembles
 * the section controllers in `main/` and handles the lifecycle; each controller builds its views
 * with [ViewKit], and every decision about what to show lives in the pure, unit-tested classes in
 * `ui/`.
 */
class MainActivity : AppCompatActivity() {
    private lateinit var host: UiHost
    private lateinit var screen: ScreenController
    private lateinit var connection: ConnectionController
    private lateinit var health: HealthController
    private lateinit var setup: SetupController
    private var built = false

    private val backCallback = object : OnBackPressedCallback(false) {
        override fun handleOnBackPressed() = confirmDiscardChanges()
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        WindowCompat.setDecorFitsSystemWindows(window, false)
        val model = ViewModelProvider(this)[MainViewModel::class.java]
        host = UiHost(this, ViewKit(this), SecureSettings(this), ScreenSettings(this), model)
        screen = ScreenController(host, onDirtyChanged = ::updateBackCallback)
        connection = ConnectionController(
            host,
            screen,
            historyPermissionGranted = { health.historyPermissionGranted },
            onEdited = { health.render() },
            onSaved = ::renderAll,
            onDirtyChanged = ::updateBackCallback,
        )
        health = HealthController(host, connection = { connection }, onRendered = { setup.render() })
        setup = SetupController(host, connection, health)
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

    /** The "同步問題" notification opens the health section. */
    private fun handleOpenIntent(intent: Intent?) {
        if (intent?.getBooleanExtra(EXTRA_OPEN_HEALTH, false) != true) return
        intent.removeExtra(EXTRA_OPEN_HEALTH)
        health.section.setExpanded(true)
        host.scrollTo(health.section.root)
    }

    override fun onResume() {
        super.onResume()
        // Permissions and the accessibility service can change in system settings while we are away.
        lifecycleScope.launch {
            health.refresh()
            health.render()
        }
        screen.render()
    }

    override fun onSaveInstanceState(outState: Bundle) {
        super.onSaveInstanceState(outState)
        outState.putBoolean(STATE_CONNECTION_OPEN, connection.section.expanded)
        outState.putBoolean(STATE_HEALTH_OPEN, health.section.expanded)
        outState.putBoolean(STATE_SCREEN_OPEN, screen.section.expanded)
    }

    private fun buildContent(saved: Bundle?): View {
        val kit = host.kit
        val content = MaxWidthColumn(this, kit.dp(640)).apply {
            setPadding(kit.dp(16), kit.dp(16), kit.dp(16), kit.dp(24))
        }
        content.addView(buildHeader())
        content.addView(setup.build(), ViewKit.matchWrap(kit.dp(16)))
        content.addView(connection.build(saved?.getBoolean(STATE_CONNECTION_OPEN)).root, ViewKit.matchWrap(kit.dp(16)))
        content.addView(health.build(saved?.getBoolean(STATE_HEALTH_OPEN) ?: true).root, ViewKit.matchWrap(kit.dp(16)))
        // Sensitive and opt-in: always starts collapsed unless the user had it open before a rotation.
        content.addView(screen.build(saved?.getBoolean(STATE_SCREEN_OPEN) ?: false).root, ViewKit.matchWrap(kit.dp(16)))
        content.addView(kit.text(Style.CAPTION, getString(R.string.footer_privacy)).apply {
            setPadding(kit.dp(4), kit.dp(16), kit.dp(4), 0)
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
        return scroll
    }

    private fun buildHeader(): View {
        val kit = host.kit
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

    private fun observeModel() {
        lifecycleScope.launch {
            repeatOnLifecycle(Lifecycle.State.STARTED) {
                launch {
                    var wasBusy = false
                    host.model.sync.collect { state ->
                        health.applyKeepScreenOn()
                        if (wasBusy && !state.busy) health.refresh()
                        wasBusy = state.busy
                        health.render()
                    }
                }
                launch { host.model.screen.collect { screen.render() } }
            }
        }
    }

    private fun renderAll() {
        connection.render()
        health.render()
        screen.render()
    }

    private fun updateBackCallback() {
        if (!built) return
        backCallback.isEnabled = FormState.confirmBeforeLeaving(connection.dirty(), screen.dirty())
    }

    private fun confirmDiscardChanges() {
        AlertDialog.Builder(this)
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

    /** Saves both forms, then leaves; a destination change finishes from its confirmation dialog. */
    private fun saveAllAndFinish() {
        val screenOk = !screen.dirty() || screen.save(showSuccess = true)
        val finishIfSaved = { if (screenOk && !connection.dirty() && !screen.dirty()) finish() }
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
        private const val STATE_CONNECTION_OPEN = "connection_open"
        private const val STATE_HEALTH_OPEN = "health_open"
        private const val STATE_SCREEN_OPEN = "screen_open"
    }
}
