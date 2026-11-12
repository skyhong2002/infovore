package tw.skyhong.infovore.health

import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import tw.skyhong.infovore.health.Fixture.DAY
import tw.skyhong.infovore.health.Fixture.NOW
import tw.skyhong.infovore.health.Fixture.item
import tw.skyhong.infovore.health.HealthSyncEngine.ConfirmOutcome
import tw.skyhong.infovore.health.ui.ReconcileStatus
import java.time.Instant
import java.time.ZoneOffset

/**
 * A deletion the server refused as too large (HTTP 409) is kept with its counts; the user can
 * confirm it (exactly that count, re-read first, server re-checks) or keep the server's rows.
 * Synthetic fixtures only.
 */
class ConfirmedDeleteTest {
    private val scanStart = NOW - 7 * DAY
    private val hour = 3_600_000L
    private val ok = InfovoreApi.UploadResult(0, 0, 0, reconciled = true)

    private fun refused(wouldDelete: Int, checked: Int) =
        InfovoreApi.HttpStatusException(409, "Infovore HTTP 409", ReconcileRefusal(wouldDelete, checked))

    /** A history scan whose steps window the server refuses: 25 of 27 rows would go. */
    private fun refusedScan(): Harness {
        val h = Harness()
        h.reader.pages["steps"] = listOf(listOf(item("s1", scanStart + hour), item("s2", scanStart + 2 * hour)))
        h.uploader.onReconcile = { window -> if (window.dataType == "steps") throw refused(25, 27) else ok }
        runBlocking { h.engine().run() }
        return h
    }

    @Test
    fun aRefusalWithCountsIsSavedWithItsWindowButNoIds() {
        val h = refusedScan()
        val gap = h.gaps.single()
        assertEquals(GapRefusal(scanStart, NOW, wouldDelete = 25, checked = 27, sentIds = 2), gap.refusal)
        assertTrue(gap.confirmable)
        assertFalse(gap.dismissed)
        // Persisted text holds counts and times only.
        assertFalse(h.store.reconcileGapsText.contains("s1"))
        assertEquals(gap, h.engine(h.store.reloaded()).gaps.single())
    }

    @Test
    fun aMatchingConfirmationDeletesThenVerifiesTheRest() = runBlocking {
        val h = refusedScan()
        val sent = mutableListOf<ReconcileWindow>()
        h.uploader.onReconcile = { window ->
            sent += window
            InfovoreApi.UploadResult(0, 0, if (window.confirmDeleteExpected != null) 25 else 0, reconciled = true)
        }
        h.reader.reads.clear()
        val uploadsBefore = h.uploader.uploadedIds.size
        val outcome = h.engine().confirmDelete("steps", 25)

        assertEquals(25, (outcome as ConfirmOutcome.Deleted).deleted)
        assertTrue(outcome.summary.unverified.isEmpty())
        // First the refused window, re-read and marked as confirmed; then the ordinary re-verification.
        assertEquals(25, sent[0].confirmDeleteExpected)
        assertEquals(listOf("s1", "s2"), sent[0].recordIds)
        assertEquals(scanStart, sent[0].startMs)
        assertEquals(NOW, sent[0].endMs)
        assertTrue(sent.drop(1).isNotEmpty() && sent.drop(1).all { it.confirmDeleteExpected == null })
        assertTrue(h.reader.reads.all { it.ascending && it.dataType == "steps" })
        assertTrue(h.gaps.isEmpty())
        // Nothing was uploaded besides reconcile windows.
        assertEquals(uploadsBefore, h.uploader.uploadedIds.size)
    }

    @Test
    fun aDifferentReReadSendsNothingAndAsksAgain() = runBlocking {
        val h = refusedScan()
        h.reader.pages["steps"] = listOf(listOf(item("s1", scanStart + hour)))
        val windows = h.uploader.windows.size
        val outcome = h.engine().confirmDelete("steps", 25)
        assertEquals(ConfirmOutcome.SourceChanged, outcome)
        assertEquals(windows, h.uploader.windows.size)
        val gap = h.gaps.single()
        assertNull(gap.refusal)
        assertEquals(ReconcileText.CHANGED_BEFORE_CONFIRM, gap.reason)
        assertFalse(gap.confirmable)
    }

    @Test
    fun aServerCountThatChangedDeletesNothingAndUpdatesTheNumbers() = runBlocking {
        val h = refusedScan()
        h.uploader.onReconcile = { window ->
            assertEquals(25, window.confirmDeleteExpected)
            throw refused(31, 33)
        }
        val outcome = h.engine().confirmDelete("steps", 25)
        assertEquals(ConfirmOutcome.CountChanged(31, 33), outcome)
        val gap = h.gaps.single()
        assertEquals(31, gap.refusal?.wouldDelete)
        assertEquals(33, gap.refusal?.checked)
        assertEquals(ReconcileText.confirmMismatch(31), gap.reason)
        // The user has to confirm the new number; the old one is refused locally without sending.
        val windows = h.uploader.windows.size
        assertEquals(ConfirmOutcome.Outdated, h.engine().confirmDelete("steps", 25))
        assertEquals(windows, h.uploader.windows.size)
    }

    @Test
    fun aConfirmationWhoseDeletionAlreadyHappenedSettlesTheRest() = runBlocking {
        val h = refusedScan()
        h.uploader.onReconcile = { window -> if (window.confirmDeleteExpected != null) throw refused(0, 2) else ok }
        val outcome = h.engine().confirmDelete("steps", 25)
        assertEquals(0, (outcome as ConfirmOutcome.Deleted).deleted)
        assertTrue(h.gaps.isEmpty())
    }

    @Test
    fun anOlderServerThatRejectsTheFieldDeletesNothing() = runBlocking {
        val h = refusedScan()
        h.uploader.onReconcile = { throw InfovoreApi.HttpStatusException(400, "Infovore HTTP 400: Unrecognized key(s) in object: 'confirmDelete'") }
        val outcome = h.engine().confirmDelete("steps", 25)
        assertEquals(ConfirmOutcome.NotAccepted(ReconcileText.CONFIRM_UNSUPPORTED), outcome)
        assertEquals(ReconcileText.CONFIRM_UNSUPPORTED, h.gaps.single().reason)
        assertNull(h.gaps.single().refusal)
    }

    @Test
    fun countsBeyondTheCeilingCannotBeConfirmed() = runBlocking {
        val h = Harness()
        h.reader.pages["steps"] = listOf(listOf(item("s1", scanStart + hour)))
        h.uploader.onReconcile = { window -> if (window.dataType == "steps") throw refused(2001, 2500) else ok }
        h.engine().run()
        val gap = h.gaps.single()
        assertFalse(gap.confirmable)
        val windows = h.uploader.windows.size
        assertEquals(ConfirmOutcome.Outdated, h.engine().confirmDelete("steps", 2001))
        assertEquals(windows, h.uploader.windows.size)
        val ui = ReconcileStatus.map(h.gaps, Instant.ofEpochMilli(NOW), ZoneOffset.UTC, syncReady = true, syncHint = null)!!
        val refusal = ui.refusals.single()
        assertNull(refusal.confirmLabel)
        assertFalse(refusal.confirmEnabled)
        assertTrue(refusal.explanation, refusal.explanation.contains("無法在此刪除"))
        assertNull(ReconcileStatus.confirmDialogs(gap, ZoneOffset.UTC))
    }

    @Test
    fun keepingTheServerRowsIsPersistedAndSkippedByReverify() = runBlocking {
        val h = refusedScan()
        h.store.reconcileGapsText = ReconcileGaps.encode(ReconcileGaps.dismiss(h.gaps, "steps"))
        val restarted = h.store.reloaded()
        assertTrue(ReconcileGaps.decode(restarted.reconcileGapsText).single().dismissed)

        val windows = h.uploader.windows.size
        h.engine(restarted).reverify()
        assertEquals(windows, h.uploader.windows.size)
        assertEquals(ConfirmOutcome.Outdated, h.engine(restarted).confirmDelete("steps", 25))

        // Hidden from the warning box, listed as a quiet note.
        val now = Instant.ofEpochMilli(NOW)
        val gaps = ReconcileGaps.decode(restarted.reconcileGapsText)
        assertNull(ReconcileStatus.map(gaps, now, ZoneOffset.UTC, syncReady = true, syncHint = null))
        assertEquals("已忽略的對帳提醒：步數（保留伺服器資料，未刪除任何資料）", ReconcileStatus.dismissed(gaps)?.text)
        assertNotNull(ReconcileStatus.map(ReconcileGaps.restore(gaps, "steps"), now, ZoneOffset.UTC, syncReady = true, syncHint = null))
    }

    @Test
    fun aDismissedGapStaysHiddenOnlyForTheSameRefusal() {
        val refusal = GapRefusal(100, 200, 25, 27, 2)
        val dismissed = listOf(ReconcileGap("steps", 100, 300, "x", 1, refusal, dismissed = true))
        val same = ReconcileGaps.record(dismissed, ReconcileGap("steps", 100, 300, "x", 2, refusal))
        assertTrue(same.single().dismissed)
        val larger = ReconcileGaps.record(dismissed, ReconcileGap("steps", 100, 300, "x", 2, refusal.copy(wouldDelete = 40)))
        assertFalse(larger.single().dismissed)
        val otherReason = ReconcileGaps.record(dismissed, ReconcileGap("steps", 100, 300, ReconcileText.READ_FAILED, 2))
        assertFalse(otherReason.single().dismissed)
        val wider = ReconcileGaps.record(dismissed, ReconcileGap("steps", 50, 300, "x", 2, refusal))
        assertFalse(wider.single().dismissed)
        // A completed pass still clears it.
        assertTrue(ReconcileGaps.verified(dismissed, "steps", 0, 400).isEmpty())
    }

    @Test
    fun theCodecKeepsRefusalsAndReadsTheOldFormat() {
        val gaps = listOf(
            ReconcileGap("steps", 1_000, 2_000, "r", 1_500, GapRefusal(1_000, 1_800, 25, 27, 2), dismissed = true),
            ReconcileGap("heart_rate", 3_000, 4_000, "r2", 3_500),
        )
        assertEquals(gaps, ReconcileGaps.decode(ReconcileGaps.encode(gaps)))
        // 0.4.0 lines (five fields) still decode, without a refusal.
        assertEquals(listOf(ReconcileGap("steps", 1, 2, "ok", 3)), ReconcileGaps.decode("steps\t1\t2\t3\tok"))
        // A damaged refusal is dropped, the gap kept.
        assertNull(ReconcileGaps.decode("steps\t1\t2\t3\tok\t9\t5\t1\t1\t1\t0").single().refusal)
    }

    @Test
    fun theBoxExplainsTheRefusalAndBothDialogsSpellItOut() {
        val start = Instant.parse("2026-09-01T00:00:00Z").toEpochMilli()
        val end = Instant.parse("2026-09-08T00:00:00Z").toEpochMilli()
        val gap = ReconcileGap("steps", start, end, ReconcileText.serverRejected(409), NOW, GapRefusal(start, end, 25, 27, 2))
        val ui = ReconcileStatus.map(listOf(gap), Instant.ofEpochMilli(NOW), ZoneOffset.UTC, syncReady = true, syncHint = null)!!
        val refusal = ui.refusals.single()
        assertTrue(refusal.explanation, refusal.explanation.contains("伺服器偵測到要刪除 25 筆（窗內共 27 筆），因超過自動上限而保留資料"))
        assertEquals("我確認來源端已刪除，刪除這 25 筆", refusal.confirmLabel)
        assertEquals(25, refusal.expected)
        assertTrue(refusal.confirmEnabled)
        assertEquals("保留伺服器資料並忽略此提醒", refusal.ignoreLabel)
        val blocked = ReconcileStatus.map(listOf(gap), Instant.ofEpochMilli(NOW), ZoneOffset.UTC, syncReady = false, syncHint = "同步進行中")!!
        assertFalse(blocked.refusals.single().confirmEnabled)

        val (first, second) = ReconcileStatus.confirmDialogs(gap, ZoneOffset.UTC)!!
        for (text in listOf(first.message, second.message)) {
            assertTrue(text, text.contains("步數"))
            assertTrue(text, text.contains("2026/9/1 00:00 至 2026/9/8 00:00"))
            assertTrue(text, text.contains("25 筆"))
        }
        assertTrue(second.title.contains("無法復原"))
        assertTrue(second.message.contains("無法復原"))
        assertEquals("刪除 25 筆", second.ok)
        assertTrue(ReconcileStatus.ignoreDialog(gap, ZoneOffset.UTC).message.contains("不會刪除任何資料"))
    }

    @Test
    fun theSourceAppsOfARefusalAreSavedAndShownInBothPlaces() {
        val origins = listOf(OriginCount("com.garmin.fixture", 20), OriginCount("com.fitbit.fixture", 4), OriginCount(OriginCount.OTHER, 1))
        val h = Harness()
        h.reader.pages["steps"] = listOf(listOf(item("s1", scanStart + hour)))
        h.uploader.onReconcile = { window ->
            if (window.dataType == "steps") {
                throw InfovoreApi.HttpStatusException(409, "Infovore HTTP 409", ReconcileRefusal(25, 26, origins))
            } else {
                ok
            }
        }
        runBlocking { h.engine().run() }
        val gap = h.gaps.single()
        assertEquals(origins, gap.refusal!!.byOrigin)
        // Persisted (package names and counts only) and read back unchanged.
        assertEquals(gap, h.engine(h.store.reloaded()).gaps.single())
        assertFalse(h.store.reconcileGapsText.contains("s1"))

        val ui = ReconcileStatus.map(listOf(gap), Instant.ofEpochMilli(NOW), ZoneOffset.UTC, syncReady = true, syncHint = null)!!
        val line = "來自：20 筆 com.garmin.fixture、4 筆 com.fitbit.fixture、1 筆其他 App"
        assertTrue(ui.refusals.single().explanation, ui.refusals.single().explanation.contains(line))
        val (first, _) = ReconcileStatus.confirmDialogs(gap, ZoneOffset.UTC)!!
        assertTrue(first.message, first.message.contains(line))

        // An older server reports no origins: the texts keep the counts-only wording.
        val plain = gap.copy(refusal = gap.refusal!!.copy(byOrigin = emptyList()))
        assertFalse(ReconcileStatus.confirmDialogs(plain, ZoneOffset.UTC)!!.first.message.contains("來自"))
        assertNull(ReconcileStatus.origins(plain.refusal!!))
    }

    @Test
    fun originsFromTheServerAreSanitisedAndBounded() {
        val entries = (0 until 15).joinToString(",") { "{\"origin\":\"com.example.app$it\\tx|y=z\",\"count\":${15 - it}}" }
        val body = "{\"reconcile\":{\"status\":\"rejected\",\"wouldDelete\":120,\"checked\":130,\"byOrigin\":[" +
            "{\"origin\":\"\",\"count\":3},{\"origin\":\"bad.count\",\"count\":0},$entries]}}"
        val refusal = ReconcileRefusal.fromResponse(409, body)!!
        assertEquals(OriginCount.MAX_ENTRIES, refusal.byOrigin.size)
        assertEquals(OriginCount("com.example.app0_x_y_z", 15), refusal.byOrigin.first())
        val gap = ReconcileGap("steps", 1, 2, "r", 3, GapRefusal(1, 2, 120, 130, 4, refusal.byOrigin))
        assertEquals(gap, ReconcileGaps.decode(ReconcileGaps.encode(listOf(gap))).single())
    }

    @Test
    fun theConfirmationIsSerializedOnlyWhenSet() {
        val window = ReconcileWindow("steps", 0, 1_000, listOf("a"))
        val plain = MiniJson.parse(window.toJson()) as Map<*, *>
        assertFalse("confirmDelete" in plain)
        val confirmed = MiniJson.parse(window.copy(confirmDeleteExpected = 7).toJson()) as Map<*, *>
        assertEquals(mapOf("expected" to 7.0), confirmed["confirmDelete"])
        assertEquals(listOf("dataType", "start", "end", "recordIds", "confirmDelete"), confirmed.keys.toList())
    }
}
