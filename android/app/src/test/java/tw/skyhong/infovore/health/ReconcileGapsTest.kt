package tw.skyhong.infovore.health

import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import tw.skyhong.infovore.health.Fixture.DAY
import tw.skyhong.infovore.health.Fixture.NOW
import tw.skyhong.infovore.health.Fixture.item
import tw.skyhong.infovore.health.ui.ReconcileStatus
import java.time.Instant
import java.time.ZoneOffset

/** Unverified reconcile windows are persisted, survive unrelated syncs and restarts, and clear only on success. */
class ReconcileGapsTest {
    private val scanStart = NOW - 7 * DAY
    private val hour = 3_600_000L
    private val ok = InfovoreApi.UploadResult(0, 0, 0, reconciled = true)

    private fun refuse(status: Int, type: String = "steps"): (ReconcileWindow) -> InfovoreApi.UploadResult = { window ->
        if (window.dataType == type) throw InfovoreApi.HttpStatusException(status, "Infovore HTTP $status") else ok
    }

    @Test
    fun aRefused409SurvivesALaterIncrementalSyncAndARestart() = runBlocking {
        val h = Harness()
        h.reader.pages["steps"] = listOf(listOf(item("s1", scanStart + hour)))
        h.uploader.onReconcile = refuse(409)
        val first = h.engine().run()
        assertEquals(listOf("步數（伺服器拒絕：刪除比例異常）"), first.unverified)

        // An unrelated, successful incremental sync does not clear it.
        h.uploader.onReconcile = { ok }
        h.reader.changes += HealthChanges(listOf(item("new", NOW - hour)), emptyList(), "cursor-2", hasMore = false, tokenExpired = false)
        val second = h.engine().run()
        assertTrue(second.unverified.isEmpty())
        assertEquals(listOf("steps"), h.gaps.map { it.dataType })

        // Neither does recreating everything from what was persisted (an app restart).
        val restarted = h.engine(h.store.reloaded())
        val gap = restarted.gaps.single()
        assertEquals("steps", gap.dataType)
        assertEquals(scanStart, gap.startMs)
        assertEquals(NOW, gap.endMs)
        assertEquals(ReconcileText.serverRejected(409), gap.reason)
    }

    @Test
    fun reverifySendsOnlyTheGapWindowsAndClearsOnlyOnSuccess() = runBlocking {
        val h = Harness()
        h.reader.pages["steps"] = listOf(listOf(item("s1", scanStart + hour), item("s2", scanStart + 2 * hour)))
        h.uploader.onReconcile = refuse(409)
        h.engine().run()
        val uploadsBefore = h.uploader.uploadedIds.size
        val windowsBefore = h.uploader.windows.size

        // Still refused: the gap stays, with the new attempt's time; the limits are not relaxed.
        h.nowMs = NOW + hour
        val refused = h.engine().reverify()
        assertEquals(listOf("步數（伺服器拒絕：刪除比例異常）"), refused.unverified)
        assertEquals(NOW + hour, h.gaps.single().checkedAtMs)
        assertEquals(windowsBefore, h.uploader.windows.size)

        // Accepted: exactly the gap's window is re-read and reconciled, and the gap is cleared.
        h.uploader.onReconcile = { InfovoreApi.UploadResult(0, 0, 1, reconciled = true) }
        h.reader.reads.clear()
        val accepted = h.engine().reverify()
        assertTrue(accepted.unverified.isEmpty())
        assertEquals(1, accepted.deleted)
        assertTrue(h.gaps.isEmpty())
        assertEquals(listOf("steps"), h.reader.reads.map { it.dataType }.distinct())
        assertTrue(h.reader.reads.all { it.startMs == scanStart && it.endMs == NOW })
        val window = h.uploader.windows.last()
        assertEquals(listOf("s1", "s2"), window.recordIds)
        assertEquals(scanStart, window.startMs)
        assertEquals(NOW, window.endMs)
        // Re-verifying sends reconcile windows only, never record uploads.
        assertEquals(uploadsBefore, h.uploader.uploadedIds.size)
    }

    @Test
    fun aServerThatRefusesWith400OrDoesNotReportIsRecordedToo() = runBlocking {
        val h = Harness()
        h.uploader.onReconcile = { window ->
            when (window.dataType) {
                "steps" -> throw InfovoreApi.HttpStatusException(400, "Infovore HTTP 400")
                "heart_rate" -> InfovoreApi.UploadResult(0, 0, 0, reconciled = false)
                else -> ok
            }
        }
        h.engine().run()
        assertEquals(listOf("steps", "heart_rate"), h.gaps.map { it.dataType })
        assertEquals(ReconcileText.serverRejected(400), h.gaps[0].reason)
        assertEquals(ReconcileText.NOT_REPORTED, h.gaps[1].reason)
    }

    @Test
    fun reverifyNeverSendsAWindowTheReadPermissionMayNotCover() = runBlocking {
        val h = Harness(granted = Fixture.allPermissions)
        h.store.reconcileGapsText = ReconcileGaps.encode(
            listOf(ReconcileGap("steps", NOW - 40 * DAY, NOW - 33 * DAY, ReconcileText.serverRejected(409), NOW - 33 * DAY)),
        )
        val summary = h.engine().reverify()
        assertTrue(h.uploader.windows.isEmpty())
        assertTrue(h.reader.reads.isEmpty())
        assertEquals(ReconcileText.PERMISSION_WINDOW, h.gaps.single().reason)
        assertEquals(1, summary.unverified.size)

        // With the history permission the same window is read and verified.
        h.reader.granted = Fixture.allPermissions + HealthCatalog.HISTORY_PERMISSION
        h.engine().reverify()
        assertEquals("steps", h.uploader.windows.single().dataType)
        assertTrue(h.gaps.isEmpty())
    }

    @Test
    fun sleepOnlySyncDoesNotClearGaps() = runBlocking {
        val h = Harness()
        h.store.reconcileGapsText = ReconcileGaps.encode(listOf(ReconcileGap("sleep_session", scanStart, NOW, "x", NOW)))
        h.engine().runSleep()
        assertTrue(h.uploader.windows.isEmpty())
        assertEquals("sleep_session", h.gaps.single().dataType)
    }

    @Test
    fun codecRoundTripsAndDropsDamagedLines() {
        val gaps = listOf(
            ReconcileGap("steps", 1_000, 2_000, "reason\twith\ntabs", 1_500),
            ReconcileGap("heart_rate", 3_000, 4_000, "伺服器拒絕：刪除比例異常", 3_500),
        )
        val decoded = ReconcileGaps.decode(ReconcileGaps.encode(gaps))
        assertEquals(listOf("reason with tabs", "伺服器拒絕：刪除比例異常"), decoded.map { it.reason })
        assertEquals(gaps.map { it.copy(reason = "") }, decoded.map { it.copy(reason = "") })
        assertEquals(1, ReconcileGaps.decode("steps\t1\t2\t3\tok\ngarbage\nsteps\t5\t4\t3\treversed").size)
        assertTrue(ReconcileGaps.decode("").isEmpty())
    }

    @Test
    fun recordingMergesPerTypeAndOnlyACoveringWindowClears() {
        var gaps = ReconcileGaps.record(emptyList(), ReconcileGap("steps", 100, 200, "a", 1))
        gaps = ReconcileGaps.record(gaps, ReconcileGap("steps", 150, 300, "b", 2))
        assertEquals(listOf(ReconcileGap("steps", 100, 300, "b", 2)), gaps)
        assertEquals(gaps, ReconcileGaps.verified(gaps, "steps", 120, 300))
        assertEquals(gaps, ReconcileGaps.verified(gaps, "heart_rate", 0, 1_000))
        assertTrue(ReconcileGaps.verified(gaps, "steps", 100, 300).isEmpty())
    }

    @Test
    fun statusIsShownSeparatelyWithTypesReasonsAndAnAction() {
        val now = Instant.parse("2026-09-10T03:00:00Z")
        val ui = ReconcileStatus.map(
            listOf(
                ReconcileGap("steps", Instant.parse("2026-09-03T00:00:00Z").toEpochMilli(), Instant.parse("2026-09-10T00:00:00Z").toEpochMilli(), "伺服器拒絕：刪除比例異常", now.minusSeconds(7_200).toEpochMilli()),
                ReconcileGap("heart_rate", 0, 86_400_000, ReconcileText.NOT_REPORTED, now.toEpochMilli()),
            ),
            now, ZoneOffset.UTC, syncReady = true, syncHint = null,
        )
        assertNotNull(ui)
        ui!!
        assertEquals("歷史尚未完整核實：步數、心率", ui.headline)
        assertTrue(ui.detail.contains("步數（9/3–9/9）：伺服器拒絕：刪除比例異常；最後嘗試 2 小時前"))
        assertTrue(ui.detail.contains("心率（1/1）"))
        assertTrue(ui.reverifyEnabled)
        assertNull(ui.reverifyHint)
        val blocked = ReconcileStatus.map(listOf(ReconcileGap("steps", 0, 1, "x", 0)), now, ZoneOffset.UTC, syncReady = false, syncHint = "同步進行中")
        assertEquals("同步進行中", blocked?.reverifyHint)
        assertNull(ReconcileStatus.map(emptyList(), now, ZoneOffset.UTC, syncReady = true, syncHint = null))
    }
}
