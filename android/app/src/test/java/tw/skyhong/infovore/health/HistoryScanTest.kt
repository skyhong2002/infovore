package tw.skyhong.infovore.health

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class HistoryScanTest {
    private val order = listOf("exercise_session", "steps", "distance", "heart_rate")
    private val scan = HistoryScan("token-1", 1_000, 2_000, "https://a.example")

    @Test
    fun anInterruptedScanResumesWithTheTypesItHasNotFinished() {
        val progress = scan.withCompleted("exercise_session").withCompleted("steps")
        val resumed = HistoryScan.resumable(progress, "https://a.example")
        assertEquals(progress, resumed)
        assertEquals(listOf("distance", "heart_rate"), resumed?.remaining(order))
        // The window and the cursor taken before the scan are kept.
        assertEquals("token-1", resumed?.changesToken)
        assertEquals(1_000L, resumed?.startMs)
        assertEquals(2_000L, resumed?.endMs)
    }

    @Test
    fun aScanNeverResumesAgainstAnotherDestination() {
        assertNull(HistoryScan.resumable(scan.withCompleted("steps"), "https://b.example"))
        assertNull(HistoryScan.resumable(null, "https://a.example"))
        assertNull(HistoryScan.resumable(scan.copy(endMs = 1_000), "https://a.example"))
    }

    @Test
    fun aFinishedScanHasNothingLeft() {
        val done = order.fold(scan) { progress, type -> progress.withCompleted(type) }
        assertEquals(emptyList<String>(), done.remaining(order))
    }

    @Test
    fun onlyWindowsHealthConnectFullyReturnsAreReconciled() {
        val day = 24L * 60 * 60 * 1000
        val now = 100 * day
        // A fresh scan's window was capped by the permissions it started with.
        assertTrue(HistoryScan.canReconcile(resumed = false, historyPermission = false, startMs = now - 30 * day - 5, nowMs = now))
        // A resumed scan reaching past the last 30 days needs the history permission now.
        assertFalse(HistoryScan.canReconcile(resumed = true, historyPermission = false, startMs = now - 31 * day, nowMs = now))
        assertTrue(HistoryScan.canReconcile(resumed = true, historyPermission = true, startMs = now - 3650 * day, nowMs = now))
        assertTrue(HistoryScan.canReconcile(resumed = true, historyPermission = false, startMs = now - 29 * day, nowMs = now))
    }
}
