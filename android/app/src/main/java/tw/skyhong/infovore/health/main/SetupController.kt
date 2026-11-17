package tw.skyhong.infovore.health.main

import android.graphics.drawable.GradientDrawable
import android.view.Gravity
import android.view.View
import android.widget.Button
import android.widget.LinearLayout
import android.widget.TextView
import tw.skyhong.infovore.health.R
import tw.skyhong.infovore.health.SyncKind
import tw.skyhong.infovore.health.ui.HealthAction
import tw.skyhong.infovore.health.ui.SetupProgress
import tw.skyhong.infovore.health.ui.SetupStep
import tw.skyhong.infovore.health.ui.StepState
import tw.skyhong.infovore.health.ui.ViewKit
import tw.skyhong.infovore.health.ui.ViewKit.Style

/**
 * The "開始使用" checklist shown until setup is done: connection → Health Connect permission →
 * first sync, each step a row with a marker, title and caption, and a next-step button. Once all
 * three are done the card hides; each section's header then carries its own status.
 */
class SetupController(
    private val host: UiHost,
    private val connection: ConnectionController,
    private val health: HealthController,
) {
    private val kit = host.kit
    private lateinit var card: View
    private lateinit var summary: TextView
    private lateinit var rows: List<StepRow>
    private lateinit var nextButton: Button

    /** True once all three steps are done and the card is hidden. */
    var complete = false
        private set

    private class StepRow(val root: View, val marker: TextView, val title: TextView, val caption: TextView)

    fun build(): View {
        val card = kit.card().apply { setPadding(kit.dp(20), kit.dp(16), kit.dp(20), kit.dp(16)) }
        card.addView(kit.heading(Style.SECTION, host.string(R.string.setup_title)))
        summary = kit.liveText(Style.CAPTION)
        card.addView(summary, ViewKit.matchWrap(kit.dp(2)))
        rows = SetupStep.entries.map { _ -> stepRow().also { card.addView(it.root, ViewKit.matchWrap(kit.dp(14))) } }
        nextButton = kit.primaryButton("").apply { setOnClickListener { goToNextStep() } }
        card.addView(nextButton, ViewKit.matchWrap(kit.dp(16)))
        this.card = card
        return card
    }

    private fun stepRow(): StepRow {
        val marker = kit.text(Style.CAPTION).apply {
            gravity = Gravity.CENTER
            typeface = kit.medium
            importantForAccessibility = View.IMPORTANT_FOR_ACCESSIBILITY_NO
        }
        val title = kit.text(Style.BODY).apply { typeface = kit.medium }
        val caption = kit.text(Style.CAPTION)
        // The row speaks its full description once; its texts are not separate stops.
        val texts = kit.column().apply {
            addView(title)
            addView(caption, ViewKit.matchWrap(kit.dp(2)))
            importantForAccessibility = View.IMPORTANT_FOR_ACCESSIBILITY_NO_HIDE_DESCENDANTS
        }
        val root = LinearLayout(host.activity).apply {
            orientation = LinearLayout.HORIZONTAL
            addView(marker, LinearLayout.LayoutParams(kit.dp(24), kit.dp(24)).apply { marginEnd = kit.dp(14) })
            addView(texts, LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f))
            // One TalkBack stop per step (its full description), not a keyboard-focusable control.
            androidx.core.view.ViewCompat.setScreenReaderFocusable(this, true)
        }
        return StepRow(root, marker, title, caption)
    }

    fun render() {
        if (!::summary.isInitialized) return
        val steps = SetupProgress.compute(
            connectionSaved = connection.savedReady(),
            permissionsGranted = health.readPermissionsGranted,
            firstSyncDone = host.settings.initialImportDone,
            background = health.backgroundState(),
            partialImport = host.settings.initialImportPartial,
        )
        val next = SetupProgress.nextStep(steps)
        complete = next == null
        card.visibility = if (complete) View.GONE else View.VISIBLE
        // The section that holds the step to do now gets the accent dot.
        connection.section.currentStep = next == SetupStep.CONNECTION
        health.section.currentStep = next == SetupStep.PERMISSIONS || next == SetupStep.FIRST_SYNC
        if (complete) return
        summary.text = SetupProgress.summary(steps)
        steps.forEachIndexed { index, step ->
            val row = rows[index]
            row.title.text = step.step.title
            row.caption.text = step.text
            row.root.contentDescription = step.accessibilityText
            styleMarker(row.marker, step.state, step.number)
            row.title.setTextColor(kit.color(if (step.state == StepState.PENDING) R.color.text_secondary else R.color.text_primary))
        }
        // The connection form is the card right below: no button needed to reach it.
        nextButton.visibility = if (next == SetupStep.CONNECTION) View.GONE else View.VISIBLE
        nextButton.text = when (next) {
            SetupStep.CONNECTION -> host.string(R.string.setup_next_connection)
            SetupStep.PERMISSIONS -> health.ui?.actionLabel ?: host.string(R.string.setup_next_permissions)
            SetupStep.FIRST_SYNC -> host.string(R.string.action_sync_all)
            null -> ""
        }
        nextButton.isEnabled = when (next) {
            SetupStep.FIRST_SYNC -> health.ui?.syncEnabled == true
            else -> !host.model.sync.value.busy
        }
    }

    /** A filled circle with ✓ (done) or the number (next), an outlined one (later). */
    private fun styleMarker(marker: TextView, state: StepState, number: Int) {
        val circle = GradientDrawable().apply { shape = GradientDrawable.OVAL }
        when (state) {
            StepState.DONE -> {
                marker.text = "✓"
                circle.setColor(kit.color(R.color.tone_ok))
                marker.setTextColor(kit.color(R.color.card_background))
            }
            StepState.CURRENT -> {
                marker.text = String.format(java.util.Locale.getDefault(), "%d", number)
                circle.setColor(kit.color(R.color.brand_primary))
                marker.setTextColor(kit.color(R.color.on_primary))
            }
            StepState.PENDING -> {
                marker.text = String.format(java.util.Locale.getDefault(), "%d", number)
                circle.setColor(0)
                circle.setStroke(kit.dp(1), kit.color(R.color.outline))
                marker.setTextColor(kit.color(R.color.text_secondary))
            }
        }
        marker.background = circle
    }

    private fun goToNextStep() {
        val steps = SetupProgress.compute(connection.savedReady(), health.readPermissionsGranted, host.settings.initialImportDone)
        when (SetupProgress.nextStep(steps)) {
            SetupStep.CONNECTION -> connection.focusFirstInvalid()
            SetupStep.PERMISSIONS -> {
                health.section.setExpanded(true)
                if (health.ui?.action != HealthAction.NONE) health.performAction() else host.scrollTo(health.section.root)
            }
            SetupStep.FIRST_SYNC -> {
                health.section.setExpanded(true)
                host.scrollTo(health.section.root)
                health.startSync(SyncKind.FULL)
            }
            null -> Unit
        }
    }
}
