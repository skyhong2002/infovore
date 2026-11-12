package tw.skyhong.infovore.health.screen

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import tw.skyhong.infovore.health.DestinationChange
import tw.skyhong.infovore.health.ui.ScreenInputs
import tw.skyhong.infovore.health.ui.ScreenStatus
import java.time.Instant
import java.time.ZoneOffset

/**
 * The queue keeps a lasting count of the records it dropped before upload, by reason (seven
 * days, 40 MB) with the last time, until the user resets it; never their content.
 */
class DropLogTest {
    @get:Rule
    val folder = TemporaryFolder()

    private val day = 24 * 60 * 60 * 1000L
    private val destination = DestinationChange.normalize("https://infovore.example")

    @Test
    fun countsAddUpByReasonWithTheLastTimeOfEach() {
        val log = DropLog().add(expired = 2, overCapacity = 0, nowMs = 1_000).add(expired = 0, overCapacity = 3, nowMs = 2_000)
        assertEquals(DropLog(expired = 2, overCapacity = 3, lastExpiredMs = 1_000, lastCapacityMs = 2_000), log)
        assertEquals(5, log.total)
        assertEquals(2_000L, log.lastMs)
        assertEquals(log, log.add(0, 0, 9_000))
        assertTrue(DropLog().isEmpty)
        assertNull(DropLog().lastMs)
    }

    @Test
    fun encodesAndReadsBackAndIgnoresAnythingElse() {
        val log = DropLog(expired = 7, overCapacity = 0, lastExpiredMs = 123, lastCapacityMs = null)
        assertEquals("v1 7 0 123 -", log.encode())
        assertEquals(log, DropLog.decode(log.encode()))
        for (bad in listOf(null, "", "v2 1 1 1 1", "v1 x 0 - -", "v1 -1 0 - -", "v1 1 1 1", "garbage")) {
            assertEquals("\"$bad\"", DropLog(), DropLog.decode(bad))
        }
        // A time without a count is dropped.
        assertEquals(DropLog(expired = 1, lastExpiredMs = 5), DropLog.decode("v1 1 0 5 9"))
    }

    @Test
    fun pruningRecordsWhatItDroppedAndWhyAndKeepsItAcrossRestarts() {
        val queue = ObservationQueue(folder.root, maxTotalBytes = 100) { it.startsWith("{") }
        val t0 = System.currentTimeMillis()
        val body = "{\"pad\":\"" + "x".repeat(30) + "\"}" // 40 bytes
        // Two records past seven days, and four fresh ones over a 100-byte cap (two must go).
        queue.enqueueJson(destination, t0 - 9 * day, "old-1", "{}")
        queue.enqueueJson(destination, t0 - 8 * day, "old-2", "{}")
        for (index in 0 until 4) queue.enqueueJson(destination, t0 + index, "big-$index", body)
        val log = queue.dropLog()
        assertEquals(2, log.expired)
        assertEquals(2, log.overCapacity)
        assertEquals(2, queue.count(destination))
        // The log is not a record: counts and listings do not see it.
        assertEquals(0, queue.countOtherDestinations(destination))

        // A new instance (an app restart) reads the same totals; an upload does not clear them.
        val restarted = ObservationQueue(folder.root, maxTotalBytes = 100) { it.startsWith("{") }
        assertEquals(log, restarted.dropLog())
        restarted.remove(restarted.read(destination, 10))
        restarted.prune(t0 + 1_000, destination)
        assertEquals(log, restarted.dropLog())

        // The user's own deletions are not counted as dropped.
        restarted.enqueueJson("https://elsewhere.example", t0, "elsewhere", "{}")
        restarted.removeOtherDestinations(destination)
        assertEquals(log, restarted.dropLog())
    }

    @Test
    fun resetClearsOnlyWhatTheUserSaw() {
        val queue = ObservationQueue(folder.root) { it.startsWith("{") }
        val t0 = System.currentTimeMillis()
        queue.enqueueJson(destination, t0 - 9 * day, "old-1", "{}")
        val seen = queue.dropLog()
        assertEquals(1, seen.expired)
        // Another record expires before the user confirms: nothing is cleared.
        queue.enqueueJson(destination, t0 - 10 * day, "old-2", "{}")
        assertFalse(queue.resetDropLog(seen))
        assertEquals(2, queue.dropLog().expired)
        assertTrue(queue.resetDropLog(queue.dropLog()))
        assertTrue(queue.dropLog().isEmpty)
    }

    @Test
    fun theScreenSectionShowsTheCountsUntilReset() {
        val now = Instant.parse("2026-11-12T12:00:00Z")
        val base = ScreenInputs(
            recordingEnabled = true, pausedUntilMs = 0, serviceEnabled = true, tokenConfigured = true, pending = 0,
            lastCaptureAtMs = 0, lastUploadStatus = "尚未上傳", nowMs = now.toEpochMilli(), zone = ZoneOffset.UTC,
        )
        val none = ScreenStatus.map(base)
        assertNull(none.droppedNote)
        assertEquals("記錄中", none.summary)

        val dropped = DropLog(expired = 3, overCapacity = 12, lastExpiredMs = now.toEpochMilli() - 2 * day, lastCapacityMs = now.toEpochMilli() - 3_600_000)
        val ui = ScreenStatus.map(base.copy(dropped = dropped))
        val note = ui.droppedNote!!
        assertTrue(note, note.startsWith("已因過期淘汰 3 筆、因容量淘汰 12 筆（最近："))
        assertTrue(note, note.contains("重設淘汰計數"))
        assertEquals("記錄中 · 已淘汰 15 筆", ui.summary)
        // No time known: still shown.
        assertTrue(ScreenStatus.map(base.copy(dropped = DropLog(expired = 1))).droppedNote!!.contains("最近：時間不明"))
    }
}
