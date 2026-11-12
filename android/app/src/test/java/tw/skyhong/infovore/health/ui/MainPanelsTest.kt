package tw.skyhong.infovore.health.ui

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import tw.skyhong.infovore.health.MainViewModel.ScreenTask
import tw.skyhong.infovore.health.MainViewModel.ScreenTaskState
import tw.skyhong.infovore.health.SyncKind
import tw.skyhong.infovore.health.SyncState

/** The section controllers' state → view decisions, extracted from the former 1,330-line activity. */
class MainPanelsTest {
    @Test
    fun connectionSummaryPrefersUnsavedEdits() {
        assertEquals(ConnectionSummary.UNSAVED, ConnectionSummary.of(dirty = true, savedReady = true))
        assertEquals(ConnectionSummary.READY, ConnectionSummary.of(dirty = false, savedReady = true))
        assertEquals(ConnectionSummary.INCOMPLETE, ConnectionSummary.of(dirty = false, savedReady = false))
        assertEquals(Tone.OK, ConnectionSummary.READY.tone)
        assertEquals(Tone.WARNING, ConnectionSummary.UNSAVED.tone)
    }

    @Test
    fun notificationSwitchIsOnlyCheckedWithThePermission() {
        assertEquals(NotifyUi(true, NotifyState.ON, Tone.NEUTRAL), NotifyStatus.map(on = true, permission = true, justDenied = false))
        assertEquals(NotifyUi(false, NotifyState.PERMISSION_REVOKED, Tone.WARNING), NotifyStatus.map(on = true, permission = false, justDenied = false))
        assertEquals(NotifyUi(false, NotifyState.DENIED, Tone.WARNING), NotifyStatus.map(on = false, permission = false, justDenied = true))
        assertEquals(NotifyUi(false, NotifyState.OFF, Tone.NEUTRAL), NotifyStatus.map(on = false, permission = true, justDenied = false))
    }

    @Test
    fun syncPanelShowsProgressErrorsAndRetry() {
        val idle = SyncPanel.map(SyncState(), sleepEnabled = true, syncEnabled = true)
        assertFalse(idle.progressVisible || idle.keepScreenOn || idle.retryVisible || idle.busy)
        assertNull(idle.errorKind)

        val running = SyncPanel.map(SyncState(running = SyncKind.FULL, progress = "步數：已處理 500 筆"), true, true)
        assertTrue(running.keepScreenOn && running.progressVisible && running.busy)
        assertEquals("步數：已處理 500 筆", running.progressText)

        val background = SyncPanel.map(SyncState(backgroundRunning = true), true, true)
        assertTrue(background.progressVisible && background.showBackgroundProgress)
        assertFalse(background.keepScreenOn)

        val sleepFailed = SyncPanel.map(SyncState(failed = SyncKind.SLEEP, error = "x"), sleepEnabled = true, syncEnabled = false)
        assertEquals(SyncKind.SLEEP, sleepFailed.errorKind)
        assertTrue(sleepFailed.retryVisible && sleepFailed.retryEnabled)

        // A confirmed deletion is never retried blindly: it must be confirmed again.
        val confirmFailed = SyncPanel.map(SyncState(failed = SyncKind.CONFIRM_DELETE, error = "x"), true, true)
        assertEquals(SyncKind.CONFIRM_DELETE, confirmFailed.errorKind)
        assertFalse(confirmFailed.retryVisible)

        assertEquals("重新核實完成", SyncPanel.map(SyncState(notice = "重新核實完成"), true, true).notice)
        assertNull(SyncPanel.map(SyncState(notice = "重新核實完成", backgroundRunning = true), true, true).notice)

        assertEquals(Tone.WARNING, SyncPanel.summaryTone(Tone.OK, unverified = true, busy = false))
        assertEquals(Tone.ERROR, SyncPanel.summaryTone(Tone.ERROR, unverified = true, busy = false))
        assertEquals(Tone.NEUTRAL, SyncPanel.summaryTone(Tone.OK, unverified = true, busy = true))
    }

    @Test
    fun screenTaskPanelDisablesButtonsWhileATaskRuns() {
        val running = ScreenTaskPanel.map(ScreenTaskState(running = ScreenTask.UPLOAD), uploadAllowed = true, tokenUsable = true)
        assertFalse(running.uploadEnabled || running.testEnabled || running.retryVisible)
        assertTrue(running.progressVisible && running.resultVisible)
        assertEquals(ScreenTask.UPLOAD, running.running)
        assertEquals(Tone.NEUTRAL, running.tone)

        val failed = ScreenTaskPanel.map(
            ScreenTaskState(result = "上傳失敗", tone = Tone.ERROR, failed = ScreenTask.UPLOAD), uploadAllowed = true, tokenUsable = false,
        )
        assertTrue(failed.uploadEnabled && failed.retryVisible && failed.resultVisible)
        assertFalse(failed.testEnabled)
        assertEquals(Tone.ERROR, failed.tone)

        val idle = ScreenTaskPanel.map(ScreenTaskState(), uploadAllowed = false, tokenUsable = true)
        assertFalse(idle.resultVisible || idle.uploadEnabled)
        assertTrue(idle.testEnabled)
    }

    @Test
    fun setupRowsHaveAMarkerAndTone() {
        assertEquals("✓", SetupRow.marker(StepState.DONE))
        assertEquals("➜", SetupRow.marker(StepState.CURRENT))
        assertEquals("○", SetupRow.marker(StepState.PENDING))
        assertEquals(Tone.OK, SetupRow.tone(StepState.DONE))
        assertNull(SetupRow.tone(StepState.PENDING))
    }
}
