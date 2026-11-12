package tw.skyhong.infovore.health.ui

import tw.skyhong.infovore.health.MainViewModel.ScreenTask
import tw.skyhong.infovore.health.MainViewModel.ScreenTaskState
import tw.skyhong.infovore.health.SyncKind
import tw.skyhong.infovore.health.SyncState

/**
 * Pure state → view decisions of the main screen's sections that used to live inline in the
 * activity. The section controllers in `main/` only turn these into view properties and strings.
 */

/** The connection section's header summary. */
enum class ConnectionSummary(val tone: Tone) {
    UNSAVED(Tone.WARNING),
    READY(Tone.OK),
    INCOMPLETE(Tone.WARNING),
    ;

    companion object {
        fun of(dirty: Boolean, savedReady: Boolean): ConnectionSummary = when {
            dirty -> UNSAVED
            savedReady -> READY
            else -> INCOMPLETE
        }
    }
}

/** "同步失敗時通知我": what the switch shows and which note explains it. */
enum class NotifyState { ON, PERMISSION_REVOKED, DENIED, OFF }

data class NotifyUi(val checked: Boolean, val state: NotifyState, val tone: Tone)

object NotifyStatus {
    /** [on]: the setting; [permission]: POST_NOTIFICATIONS granted; [justDenied]: the user just refused it. */
    fun map(on: Boolean, permission: Boolean, justDenied: Boolean): NotifyUi {
        val state = when {
            on && permission -> NotifyState.ON
            on -> NotifyState.PERMISSION_REVOKED
            justDenied -> NotifyState.DENIED
            else -> NotifyState.OFF
        }
        val tone = if ((on && !permission) || justDenied) Tone.WARNING else Tone.NEUTRAL
        return NotifyUi(checked = on && permission, state = state, tone = tone)
    }
}

/** The health section's progress, error and retry views for the current [SyncState]. */
data class SyncPanelUi(
    val keepScreenOn: Boolean,
    val progressVisible: Boolean,
    /** null: use the "background sync in progress" text when [SyncState.backgroundRunning], else nothing. */
    val progressText: String?,
    val showBackgroundProgress: Boolean,
    /** The kind whose failure message to show, or null when no error box is shown. */
    val errorKind: SyncKind?,
    val retryVisible: Boolean,
    val retryEnabled: Boolean,
    /** The last re-verification or confirmed deletion's result line, shown while idle. */
    val notice: String?,
    /** The section header shows "同步中" instead of its summary. */
    val busy: Boolean,
)

object SyncPanel {
    fun map(state: SyncState, sleepEnabled: Boolean, syncEnabled: Boolean): SyncPanelUi {
        val running = state.running != null
        val failed = state.failed
        return SyncPanelUi(
            keepScreenOn = running,
            progressVisible = state.busy,
            progressText = state.progress,
            showBackgroundProgress = state.progress == null && state.backgroundRunning,
            errorKind = if (state.error != null && !running) failed ?: SyncKind.FULL else null,
            retryVisible = failed != null && !running && failed.retryable,
            retryEnabled = if (failed == SyncKind.SLEEP) sleepEnabled else syncEnabled,
            notice = state.notice.takeIf { !state.busy },
            busy = state.busy,
        )
    }

    /** The header tone: a fully synced section still warns while some history is unverified. */
    fun summaryTone(healthTone: Tone, unverified: Boolean, busy: Boolean): Tone = when {
        busy -> Tone.NEUTRAL
        unverified && healthTone == Tone.OK -> Tone.WARNING
        else -> healthTone
    }
}

/** The phone-screen section's upload / test buttons and result box for a [ScreenTaskState]. */
data class ScreenTaskUi(
    val uploadEnabled: Boolean,
    val testEnabled: Boolean,
    val progressVisible: Boolean,
    val resultVisible: Boolean,
    /** Which task is running (its "in progress" text is shown), or null to show [ScreenTaskState.result]. */
    val running: ScreenTask?,
    val tone: Tone,
    val retryVisible: Boolean,
)

object ScreenTaskPanel {
    fun map(task: ScreenTaskState, uploadAllowed: Boolean, tokenUsable: Boolean): ScreenTaskUi {
        val busy = task.running != null
        return ScreenTaskUi(
            uploadEnabled = uploadAllowed && !busy,
            testEnabled = tokenUsable && !busy,
            progressVisible = busy,
            resultVisible = busy || task.result != null,
            running = task.running,
            tone = if (busy) Tone.NEUTRAL else task.tone,
            retryVisible = task.failed != null && !busy,
        )
    }
}

/** The marker and tone of one first-run step row. */
object SetupRow {
    fun marker(state: StepState): String = when (state) {
        StepState.DONE -> "✓"
        StepState.CURRENT -> "➜"
        StepState.PENDING -> "○"
    }

    /** null: the secondary text color (a pending step). */
    fun tone(state: StepState): Tone? = when (state) {
        StepState.DONE -> Tone.OK
        StepState.CURRENT -> Tone.NEUTRAL
        StepState.PENDING -> null
    }
}
