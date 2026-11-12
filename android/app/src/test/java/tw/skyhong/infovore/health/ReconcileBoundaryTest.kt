package tw.skyhong.infovore.health

import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import tw.skyhong.infovore.health.Fixture.DAY
import tw.skyhong.infovore.health.Fixture.NOW
import tw.skyhong.infovore.health.Fixture.item

/**
 * A long history split into several reconcile windows, against a stand-in for the server's
 * reconcile rule (delete this device's rows of the type that start in the window, end before its
 * end, and are not listed; see Repository.reconcileHealthWindow). Synthetic fixtures only.
 */
class ReconcileBoundaryTest {
    private val scanStart = NOW - 7 * DAY
    private val quarter = 15 * 60_000L

    private data class Row(val id: String, val startMs: Long, val endMs: Long)

    /** The server's stored steps rows and its reconcile rule. */
    private class FakeServer(rows: List<Row>) {
        val stored = rows.associateBy { it.id }.toMutableMap()

        fun reconcile(window: ReconcileWindow): InfovoreApi.UploadResult {
            val listed = window.recordIds.toSet()
            val stale = stored.values.filter {
                it.startMs >= window.startMs && it.startMs < window.endMs && it.endMs < window.endMs && it.id !in listed
            }
            stale.forEach { stored.remove(it.id) }
            return InfovoreApi.UploadResult(0, 0, stale.size, reconciled = true)
        }
    }

    @Test
    fun aRecordDeletedAtTheSourceWhereTwoWindowsMeetIsDeleted() = runBlocking {
        // Ten contiguous 15-minute step records; the server has all of them, the phone no longer
        // has s4. With four ids per window, the previous planner cut right at s5's start, which is
        // where s4 ends: s4 then started in the first window but did not end before its end, and
        // did not start in the second, so no window could delete it.
        val rows = (0 until 10).map { Row("s$it", scanStart + DAY + it * quarter, scanStart + DAY + (it + 1) * quarter) }
        val server = FakeServer(rows)
        val h = Harness(targetIds = 4)
        h.reader.pages["steps"] = listOf(rows.filter { it.id != "s4" }.map { item(it.id, it.startMs, endMs = it.endMs) })
        h.uploader.onReconcile = { window -> if (window.dataType == "steps") server.reconcile(window) else InfovoreApi.UploadResult(0, 0, 0, reconciled = true) }

        val summary = h.engine().run()

        val windows = h.uploader.windowsFor("steps")
        assertEquals(3, windows.size)
        // The cut is where the earlier side ends (s3's end = s4's start), so s4 lies in the second window.
        assertEquals(rows[4].startMs, windows[0].endMs)
        assertEquals(listOf("s0", "s1", "s2", "s3"), windows[0].recordIds)
        assertEquals(listOf("s5", "s6", "s7", "s8"), windows[1].recordIds)
        assertEquals(rows.map { it.id } - "s4", server.stored.keys.sorted())
        assertEquals(1, summary.deleted)
        assertTrue(summary.unverified.isEmpty())
        assertEquals("", h.store.reconcileGapsText)
    }

    @Test
    fun recordsStillOnThePhoneAreNeverDeletedWhateverTheCuts() = runBlocking {
        // Overlapping records of two apps (15-minute and 49-minute ones within each hour), nothing
        // deleted at the source. Only the hour boundaries are free of records lying across them.
        val short = (0 until 40).map { Row("q$it", scanStart + DAY + it * quarter, scanStart + DAY + (it + 1) * quarter) }
        val long = (0 until 10).map { Row("h$it", scanStart + DAY + it * 4 * quarter + 60_000, scanStart + DAY + it * 4 * quarter + 50 * 60_000) }
        val rows = (short + long).sortedBy { it.startMs }
        val server = FakeServer(rows)
        val h = Harness(targetIds = 3)
        h.reader.pages["steps"] = rows.map { item(it.id, it.startMs, endMs = it.endMs) }.chunked(7)
        h.uploader.onReconcile = { window -> if (window.dataType == "steps") server.reconcile(window) else InfovoreApi.UploadResult(0, 0, 0, reconciled = true) }

        h.engine().run()

        val windows = h.uploader.windowsFor("steps")
        assertTrue(windows.size > 1)
        windows.zipWithNext().forEach { (a, b) -> assertEquals(a.endMs, b.startMs) }
        // No record lies across an internal cut, and none was deleted.
        for (cut in windows.dropLast(1).map { it.endMs }) {
            assertTrue("record across $cut", rows.none { it.startMs < cut && it.endMs > cut })
            assertEquals("cut on an hour boundary", 0L, (cut - scanStart - DAY) % (4 * quarter))
        }
        assertEquals(rows.size, server.stored.size)
    }
}
