package tw.skyhong.infovore.health.main

import android.view.View
import android.widget.Button
import android.widget.TextView
import tw.skyhong.infovore.health.R
import tw.skyhong.infovore.health.SyncKind
import tw.skyhong.infovore.health.ui.HealthAction
import tw.skyhong.infovore.health.ui.SetupProgress
import tw.skyhong.infovore.health.ui.SetupRow
import tw.skyhong.infovore.health.ui.SetupStep
import tw.skyhong.infovore.health.ui.ViewKit
import tw.skyhong.infovore.health.ui.ViewKit.Style

/** The "開始使用" checklist: connection → Health Connect permission → first sync, with a next-step button. */
class SetupController(
    private val host: UiHost,
    private val connection: ConnectionController,
    private val health: HealthController,
) {
    private val kit = host.kit
    private lateinit var summary: TextView
    private lateinit var rows: List<TextView>
    private lateinit var nextButton: Button

    fun build(): View {
        val card = kit.card().apply { setPadding(kit.dp(16), kit.dp(12), kit.dp(16), kit.dp(12)) }
        card.addView(kit.heading(Style.SECTION, host.string(R.string.setup_title)))
        summary = kit.liveText(Style.CAPTION)
        card.addView(summary)
        rows = SetupStep.entries.map { _ ->
            kit.text(Style.BODY).apply { setPadding(0, kit.dp(8), 0, 0) }.also { card.addView(it, ViewKit.matchWrap()) }
        }
        nextButton = kit.primaryButton("").apply { setOnClickListener { goToNextStep() } }
        card.addView(nextButton, ViewKit.matchWrap(kit.dp(12)))
        return card
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
        summary.text = SetupProgress.summary(steps)
        steps.forEachIndexed { index, step ->
            val row = rows[index]
            row.text = host.string(R.string.setup_step_row, SetupRow.marker(step.state), step.number, step.step.title, step.text)
            row.contentDescription = step.accessibilityText
            val tone = SetupRow.tone(step.state)
            if (tone == null) row.setTextColor(kit.color(R.color.text_secondary)) else kit.setTone(row, tone, tintBackground = false)
        }
        val next = SetupProgress.nextStep(steps)
        nextButton.visibility = if (next == null) View.GONE else View.VISIBLE
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
