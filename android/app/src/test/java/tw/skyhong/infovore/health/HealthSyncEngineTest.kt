package tw.skyhong.infovore.health

import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test
import tw.skyhong.infovore.health.Fixture.DAY
import tw.skyhong.infovore.health.Fixture.NOW
import tw.skyhong.infovore.health.Fixture.item
import java.io.IOException

/**
 * The Health Connect sync logic against a fake Health Connect and a fake server. Reconcile is the
 * only path that makes the server delete data on its own, so these pin down exactly when a window
 * is (and is not) sent.
 */
class HealthSyncEngineTest {
    private val scanStart = NOW - 7 * DAY
    private val hour = 3_600_000L

    private fun Harness.stepsPages(vararg pages: List<HealthItem>) {
        reader.pages["steps"] = pages.toList()
    }

    @Test
    fun historyScanSendsReconcileOnlyAfterEveryPageWasRead() = runBlocking {
        val h = Harness()
        h.stepsPages(
            listOf(item("s1", scanStart + hour), item("s2", scanStart + 2 * hour)),
            listOf(item("s3", scanStart + 3 * hour)),
            listOf(item("s4", scanStart + 4 * hour)),
        )
        h.engine().run()

        val steps = h.uploader.windowsFor("steps").single()
        assertEquals(listOf("s1", "s2", "s3", "s4"), steps.recordIds)
        assertEquals(scanStart, steps.startMs)
        assertEquals(NOW, steps.endMs)
        assertTrue(h.events.indexOf("reconcile:steps") > h.events.indexOf("read:steps:2"))
        assertEquals(listOf("s1", "s2", "s3", "s4"), h.uploader.uploadedIds)
        // Every type of the scan was verified; sleep is read newest first, the others oldest first.
        assertEquals(HealthCatalog.all.map { it.key }.toSet(), h.uploader.windows.map { it.dataType }.toSet())
        assertTrue(h.reader.reads.filter { it.dataType == "sleep_session" }.all { !it.ascending })
        assertTrue(h.reader.reads.filter { it.dataType == "steps" }.all { it.ascending && it.startMs == scanStart && it.endMs == NOW })
        assertTrue(h.gaps.isEmpty())
        assertNull(h.store.historyScan)
        assertEquals("fixture-token-1+", h.store.changesToken)
    }

    @Test
    fun aFailedPageSendsNoReconcileForTheTypeAndLeavesItUnverified() = runBlocking {
        val h = Harness()
        h.stepsPages(listOf(item("s1", scanStart + hour)), listOf(item("s2", scanStart + 2 * hour)), listOf(item("s3", scanStart + 3 * hour)))
        h.reader.failAt = "steps" to 1

        assertThrows(IOException::class.java) { runBlocking { h.engine().run() } }
        assertTrue(h.uploader.windowsFor("steps").isEmpty())
        val gap = h.gaps.single()
        assertEquals("steps", gap.dataType)
        assertEquals(ReconcileText.READ_FAILED, gap.reason)
        assertEquals(scanStart, gap.startMs)
        assertEquals(NOW, gap.endMs)
        val saved = requireNotNull(h.store.historyScan)
        assertTrue("exercise_session" in saved.completed)
        assertFalse("steps" in saved.completed)

        // The next run resumes, reads steps completely and only then verifies (and clears) it.
        h.reader.failAt = null
        h.engine().run()
        assertEquals(listOf("s1", "s2", "s3"), h.uploader.windowsFor("steps").single().recordIds)
        assertTrue(h.gaps.isEmpty())
    }

    @Test
    fun anOutOfOrderReadSendsNoReconcile() = runBlocking {
        val h = Harness()
        h.stepsPages(listOf(item("late", scanStart + 5 * hour), item("early", scanStart + hour)))
        val summary = h.engine().run()

        assertTrue(h.uploader.windowsFor("steps").isEmpty())
        assertEquals(listOf("步數（${ReconcilePlanner.OUT_OF_ORDER}）"), summary.unverified)
        assertEquals(ReconcilePlanner.OUT_OF_ORDER, h.gaps.single { it.dataType == "steps" }.reason)
        // The records themselves are still uploaded.
        assertEquals(listOf("late", "early"), h.uploader.uploadedIds)
    }

    @Test
    fun missingPermissionsSendNothing() = runBlocking<Unit> {
        val h = Harness(granted = Fixture.allPermissions - HealthCatalog.historyOrder.first { it.key == "steps" }.readPermission)
        assertThrows(IllegalArgumentException::class.java) { runBlocking { h.engine().run() } }
        assertTrue(h.uploader.windows.isEmpty())
        assertTrue(h.uploader.uploadedIds.isEmpty())
        assertTrue(h.events.none { it.startsWith("read:") })
    }

    @Test
    fun aResumedScanTheReadPermissionMayNotCoverIsNotReconciled() = runBlocking {
        // Without the history permission, a resumed window reaching beyond 30 days is unsafe.
        val h = Harness(granted = Fixture.allPermissions)
        h.store.historyScan = HistoryScan("saved-token", NOW - 40 * DAY, NOW - 39 * DAY, Harness.DESTINATION, setOf("sleep_session"))
        val summary = h.engine().run()

        assertTrue(h.uploader.windows.isEmpty())
        assertEquals(HealthCatalog.historyOrder.map { it.key }, h.gaps.map { it.dataType })
        assertTrue(h.gaps.all { it.reason == ReconcileText.PERMISSION_WINDOW })
        assertEquals(HealthCatalog.historyOrder.size, summary.unverified.size)
    }

    @Test
    fun incrementalSyncNeverReconciles() = runBlocking {
        val h = Harness()
        h.store.changesToken = "cursor-1"
        h.reader.pages["sleep_session"] = listOf(listOf(item("sleep-1", NOW - DAY)))
        h.reader.changes += HealthChanges(
            upserts = listOf(item("changed", NOW - hour), item("own-write", NOW - hour, origin = Fixture.OWN)),
            deletedIds = listOf("gone"),
            nextToken = "cursor-2",
            hasMore = false,
            tokenExpired = false,
        )
        h.engine().run()

        assertTrue(h.uploader.windows.isEmpty())
        assertEquals(listOf("sleep-1", "changed"), h.uploader.uploadedIds)
        assertEquals(listOf("gone"), h.uploader.deletedIds)
        assertEquals("cursor-2", h.store.changesToken)
        assertEquals(0, h.reader.changeTokenRequests)
    }

    @Test
    fun recordsStartingOutsideTheWindowAreNotListed() = runBlocking {
        val h = Harness()
        h.stepsPages(
            listOf(
                item("before", scanStart - 1),
                item("first", scanStart),
                item("last", NOW - 1),
            ),
        )
        h.engine().run()

        assertEquals(listOf("first", "last"), h.uploader.windowsFor("steps").single().recordIds)
        assertEquals(listOf("before", "first", "last"), h.uploader.uploadedIds)
    }

    @Test
    fun aResumedScanDoesNotResendReconcileForCompletedTypes() = runBlocking {
        val h = Harness()
        h.store.historyScan = HistoryScan(
            "saved-token", scanStart, NOW, Harness.DESTINATION, setOf("sleep_session", "exercise_session", "steps"),
        )
        h.engine().run()

        assertEquals(
            listOf("distance", "total_calories_burned", "heart_rate", "weight", "body_fat"),
            h.uploader.windows.map { it.dataType },
        )
        // Sleep is still refreshed, but not reconciled again; completed types are not read at all.
        assertTrue(h.reader.reads.any { it.dataType == "sleep_session" })
        assertTrue(h.reader.reads.none { it.dataType == "exercise_session" || it.dataType == "steps" })
        assertEquals(0, h.reader.changeTokenRequests)
        assertTrue("changes:saved-token" in h.events)
    }

    @Test
    fun windowsCompletedMidReadAreSentAfterTheirPagesAndAStopLaterKeepsTheTypeUnverified() = runBlocking {
        val h = Harness(targetIds = 2)
        h.stepsPages(
            listOf(item("a", scanStart + hour), item("b", scanStart + 2 * hour), item("c", scanStart + 3 * hour)),
            listOf(item("d", scanStart + 4 * hour)),
        )
        h.reader.failAt = "steps" to 1
        assertThrows(IOException::class.java) { runBlocking { h.engine().run() } }
        // The first window [scanStart, c) was complete after page 0; nothing after it was sent.
        assertEquals(listOf(listOf("a", "b")), h.uploader.windowsFor("steps").map { it.recordIds })
        assertEquals("steps", h.gaps.single().dataType)
    }

    @Test
    fun aRetryable503FailsTheRunWithoutOtherSideEffects() = runBlocking {
        val h = Harness()
        h.stepsPages(listOf(item("s1", scanStart + hour)))
        h.uploader.onReconcile = { window ->
            if (window.dataType == "steps") throw IOException("Infovore HTTP 503: {\"retryable\":true}")
            InfovoreApi.UploadResult(0, 0, 0, reconciled = true)
        }
        assertThrows(IOException::class.java) { runBlocking { h.engine().run() } }
        assertTrue(h.gaps.isEmpty())
        assertFalse("steps" in requireNotNull(h.store.historyScan).completed)
        assertNull(h.store.changesToken)

        h.uploader.onReconcile = { InfovoreApi.UploadResult(0, 0, 0, reconciled = true) }
        h.engine().run()
        assertEquals(listOf("s1"), h.uploader.windowsFor("steps").single().recordIds)
        assertTrue(h.gaps.isEmpty())
        assertNull(h.store.historyScan)
    }
}
