package tw.skyhong.infovore.health.screen

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import tw.skyhong.infovore.health.DestinationChange
import tw.skyhong.infovore.health.screen.QuarantineAlerts.Level
import tw.skyhong.infovore.health.ui.ScreenInputs
import tw.skyhong.infovore.health.ui.ScreenStatus
import java.time.ZoneOffset

/**
 * A filling quarantine warns once at 80% and once when full (uploads stop), only with the user's
 * notification opt-in; while it is full the current destination's pending records are not
 * dropped for their age, but the size cap still applies.
 */
class QuarantineAlertsTest {
    @get:Rule
    val folder = TemporaryFolder()

    private val day = 24 * 60 * 60 * 1000L
    private val maxAge = ObservationQueue.MAX_AGE_MS

    @Test
    fun levelsStartAtEightyPercentAndAtTheLimit() {
        assertEquals(400, QuarantineAlerts.nearThreshold(500))
        assertEquals(Level.NONE, QuarantineAlerts.level(0, 500))
        assertEquals(Level.NONE, QuarantineAlerts.level(399, 500))
        assertEquals(Level.NEAR, QuarantineAlerts.level(400, 500))
        assertEquals(Level.NEAR, QuarantineAlerts.level(499, 500))
        assertEquals(Level.FULL, QuarantineAlerts.level(500, 500))
        assertEquals(Level.FULL, QuarantineAlerts.level(501, 500))
        assertEquals(Level.NEAR, QuarantineAlerts.level(4, 5))
    }

    @Test
    fun eachStepUpNotifiesOnceAndOnlyWithTheOptIn() {
        var level = Level.NONE
        val notified = mutableListOf<Level>()
        for (rejected in listOf(10, 399, 400, 420, 480, 500, 500, 500)) {
            val decision = QuarantineAlerts.next(level, rejected, 500, notificationsEnabled = true)
            if (decision.notify) notified += decision.level
            assertFalse(decision.clear)
            level = decision.notified
        }
        assertEquals(listOf(Level.NEAR, Level.FULL), notified)

        // Brought back down: the warning is removed, nothing new is shown.
        val down = QuarantineAlerts.next(Level.FULL, 0, 500, notificationsEnabled = true)
        assertEquals(Level.NONE, down.level)
        assertTrue(down.clear)
        assertFalse(down.notify)
        val partly = QuarantineAlerts.next(Level.FULL, 450, 500, notificationsEnabled = true)
        assertEquals(Level.NEAR, partly.level)
        assertTrue(partly.clear)
        assertFalse(partly.notify)

        // Without the opt-in nothing is posted, and nothing counts as notified.
        val off = QuarantineAlerts.next(Level.NONE, 500, 500, notificationsEnabled = false)
        assertEquals(Level.FULL, off.level)
        assertFalse(off.notify)
        assertEquals(Level.NONE, off.notified)
    }

    /** Runs [steps] of (rejected, notifications enabled) from nothing notified; returns the levels notified. */
    private fun notifications(vararg steps: Pair<Int, Boolean>): List<Level> {
        var notified = Level.NONE
        return steps.mapNotNull { (rejected, enabled) ->
            val decision = QuarantineAlerts.next(notified, rejected, 500, enabled)
            notified = decision.notified
            decision.level.takeIf { decision.notify }
        }
    }

    @Test
    fun aWarningReachedWhileNotificationsWereOffIsDeliveredOnceTheyAreOn() {
        // Round 7 (sol-6.1, astra-6): NONE -> FULL with notifications off, then the user turns them
        // on (the catch-up runs the same decision with them on): the FULL warning is shown once.
        assertEquals(listOf(Level.FULL), notifications(0 to false, 500 to false, 500 to false, 500 to true))
        // Then further checks at FULL do not repeat it.
        assertEquals(listOf(Level.FULL), notifications(500 to false, 500 to true, 500 to true, 500 to true, 500 to true))
        // The system permission revoked and restored (enabled = opt-in and permission): same.
        assertEquals(listOf(Level.NEAR, Level.FULL), notifications(420 to true, 500 to false, 500 to false, 500 to true, 500 to true))
        // Reached NEAR while off, FULL after turning on: NEAR first (catch-up), then FULL.
        assertEquals(listOf(Level.NEAR, Level.FULL), notifications(450 to false, 450 to true, 500 to true))
        // Brought down while off and up again: still one warning per step once on.
        assertEquals(listOf(Level.FULL, Level.FULL), notifications(500 to true, 0 to false, 500 to false, 500 to true))
        // Ordinary polling at FULL with notifications on all along: one warning only.
        assertEquals(listOf(Level.FULL), notifications(500 to true, 500 to true, 500 to true))
    }

    @Test
    fun aWarningTheSystemHidesIsNotCountedAndIsDeliveredWhenShownAgain() {
        // Opted in, but the channel (or Infovore's notifications) is off in system settings.
        val hidden = QuarantineAlerts.next(Level.NONE, 500, 500, notificationsEnabled = true, hidden = true)
        assertFalse(hidden.notify)
        assertEquals(Level.NONE, hidden.notified)
        // Shown earlier, then hidden: forgotten, so it comes back once allowed.
        assertEquals(Level.NONE, QuarantineAlerts.next(Level.FULL, 500, 500, notificationsEnabled = true, hidden = true).notified)
        val back = QuarantineAlerts.next(Level.NONE, 500, 500, notificationsEnabled = true, hidden = false)
        assertTrue(back.notify)
        assertEquals(Level.FULL, back.notified)
    }

    @Test
    fun theNotifiedLevelOnlyRisesWithANotificationAndFallsWithTheCounts() {
        val held = QuarantineAlerts.next(Level.FULL, 450, 500, notificationsEnabled = false)
        assertTrue(held.clear)
        assertEquals(Level.NEAR, held.notified)
        val unchanged = QuarantineAlerts.next(Level.NEAR, 500, 500, notificationsEnabled = false)
        assertFalse(unchanged.notify)
        assertEquals(Level.NEAR, unchanged.notified)
    }

    @Test
    fun notificationTextsHoldCountsOnly() {
        val full = QuarantineAlerts.text(Level.FULL, 500, 500, 1234)
        assertTrue(full, full.contains("500 筆") && full.contains("1234 筆待傳") && full.contains("40 MB"))
        val near = QuarantineAlerts.text(Level.NEAR, 412, 500, 7)
        assertTrue(near, near.contains("412 筆") && near.contains("上限 500 筆"))
        for (text in listOf(full, near, QuarantineAlerts.title(Level.FULL), QuarantineAlerts.title(Level.NEAR))) {
            // No screen text, app names or URLs could be in there: only fixed words and numbers.
            assertFalse(text, Regex("[A-Za-z]{2,}\\.[A-Za-z]{2,}").containsMatchIn(text))
        }
    }

    @Test
    fun timeInsideAHoldDoesNotCountTowardTheSevenDays() {
        val now = 100 * day
        val hold = AgeHold("d-x", sinceMs = now - 5 * day)
        // Captured 10 days ago, uploads stopped for the last 5: only 5 days count.
        assertEquals(5 * day, QueueRetention.countedAge(now - 10 * day, now, hold))
        assertFalse(QueueRetention.isStale(now - 10 * day, now, hold))
        // Captured during the hold: nothing counts yet.
        assertEquals(0, QueueRetention.countedAge(now - 2 * day, now, hold))
        // Without a hold the usual rule applies.
        assertTrue(QueueRetention.isStale(now - 10 * day, now, null))
        // After the hold ended, time counts again from its end.
        val ended = hold.copy(untilMs = now - 1 * day)
        assertEquals(6 * day, QueueRetention.countedAge(now - 10 * day, now, ended))
        assertTrue(QueueRetention.isStale(now - 12 * day, now, ended))
    }

    @Test
    fun holdsStartWhileFullEndWhenResolvedAndExpire() {
        val start = 50 * day
        val opened = QueueRetention.nextHold(null, "d-a", full = true, nowMs = start)
        assertEquals(AgeHold("d-a", start), opened)
        assertEquals(opened, QueueRetention.nextHold(opened, "d-a", full = true, nowMs = start + day))
        // Unknown destination (null): unchanged.
        assertEquals(opened, QueueRetention.nextHold(opened, null, full = false, nowMs = start + day))
        val closed = QueueRetention.nextHold(opened, "d-a", full = false, nowMs = start + 2 * day)
        assertEquals(AgeHold("d-a", start, start + 2 * day), closed)
        // Full again within seven days: the earlier hold continues.
        assertEquals(AgeHold("d-a", start), QueueRetention.nextHold(closed, "d-a", full = true, nowMs = start + 3 * day))
        // Full for another destination: a new hold for that one only.
        assertEquals(AgeHold("d-b", start + 3 * day), QueueRetention.nextHold(closed, "d-b", full = true, nowMs = start + 3 * day))
        // Seven days after it ended, no record benefits from it any more.
        assertEquals(closed, QueueRetention.nextHold(closed, "d-a", full = false, nowMs = start + 2 * day + maxAge))
        assertNull(QueueRetention.nextHold(closed, "d-a", full = false, nowMs = start + 2 * day + maxAge + 1))
        // Round trip, and damaged values are ignored.
        assertEquals(closed, AgeHold.decode(closed!!.encode()))
        assertEquals(opened, AgeHold.decode(opened!!.encode()))
        for (bad in listOf(null, "", "d-a", "d-a x -", "d-a 10 5", " 1 2")) assertNull(bad, AgeHold.decode(bad))
    }

    private val endpoint = "https://receiver.example"
    private val destination = DestinationChange.normalize(endpoint)
    private val other = DestinationChange.normalize("https://other.example")

    private fun name(ms: Long, id: String) = "${ms.toString().padStart(15, '0')}-$id.json"

    /** Quarantines [count] records captured just before [beforeMs] (so they are read first). */
    private fun quarantineFill(queue: ObservationQueue, count: Int, beforeMs: Long) {
        repeat(count) { queue.enqueueJson(destination, beforeMs - 10_000 + it, "bad-$it", "{\"id\":\"bad-$it\"}") }
        val entries = queue.read(destination, count)
        queue.quarantine(destination, entries)
    }

    @Test
    fun aFullQuarantineKeepsTheCurrentDestinationsPendingRecordsPastSevenDays() {
        val queue = ObservationQueue(folder.root, maxRejected = 3) { it.startsWith("{") }
        // enqueueJson prunes at the real clock, so the scenario starts now.
        val t0 = System.currentTimeMillis()
        queue.enqueueJson(destination, t0, "waiting", "{\"id\":\"waiting\"}")
        queue.enqueueJson(other, t0, "old-destination", "{\"id\":\"old-destination\"}")
        quarantineFill(queue, 3, t0)
        // The quarantine just filled up: the next prune starts the hold for the current destination.
        queue.prune(t0 + 2_000, destination)
        assertEquals(AgeHold(ObservationQueue.bucketName(destination), t0 + 2_000), queue.ageHold())

        // Ten days later: the waiting record is kept; the other destination's is not held.
        queue.prune(t0 + 10 * day, destination)
        assertEquals(1, queue.count(destination))
        assertEquals(0, queue.countOtherDestinations(destination))

        // The user deletes the rejected records: the hold ends, and the record still has the rest
        // of its seven days to upload (here it waited only a moment before the hold started).
        queue.removeRejected()
        queue.prune(t0 + 10 * day + 1, destination)
        assertEquals(t0 + 10 * day + 1, queue.ageHold()?.untilMs)
        queue.prune(t0 + 16 * day, destination)
        assertEquals(1, queue.count(destination))
        queue.prune(t0 + 18 * day, destination)
        assertEquals(0, queue.count(destination))
    }

    @Test
    fun withoutAFullQuarantineTheSevenDayRuleIsUnchanged() {
        val queue = ObservationQueue(folder.root, maxRejected = 3) { it.startsWith("{") }
        // enqueueJson prunes at the real clock, so the scenario starts now.
        val t0 = System.currentTimeMillis()
        queue.enqueueJson(destination, t0, "waiting", "{\"id\":\"waiting\"}")
        quarantineFill(queue, 2, t0)
        queue.prune(t0 + 8 * day, destination)
        assertNull(queue.ageHold())
        assertEquals(0, queue.count(destination))
    }

    @Test
    fun theSizeCapStillDropsTheOldestHeldRecords() {
        val queue = ObservationQueue(folder.root, maxRejected = 1, maxTotalBytes = 100) { it.startsWith("{") }
        val t0 = System.currentTimeMillis() - day
        quarantineFill(queue, 1, t0)
        val body = "{\"pad\":\"" + "x".repeat(30) + "\"}" // 40 bytes
        for (index in 0 until 4) queue.enqueueJson(destination, t0 + 10_000 + index, "big-$index", body)
        queue.prune(t0 + 20_000, destination)
        assertTrue(queue.ageHold() != null)
        // 4 × 40 bytes over a 100-byte cap: the two oldest go, held or not.
        assertEquals(
            listOf(name(t0 + 10_002, "big-2"), name(t0 + 10_003, "big-3")),
            queue.read(destination, 10).map { it.file.name },
        )
        assertEquals(1, queue.countRejected())
    }

    @Test
    fun theScreenSectionShowsAFillingQuarantineAndSuggestsNotifications() {
        val base = ScreenInputs(
            recordingEnabled = true, pausedUntilMs = 0, serviceEnabled = true, tokenConfigured = true, pending = 5,
            lastCaptureAtMs = 0, lastUploadStatus = "尚未上傳", nowMs = 0, zone = ZoneOffset.UTC,
        )
        val calm = ScreenStatus.map(base.copy(rejected = 10, notificationsOn = false))
        assertNull(calm.notificationHint)
        assertEquals("記錄中 · 佇列 5 筆", calm.summary)

        val near = ScreenStatus.map(base.copy(rejected = 420, notificationsOn = false))
        assertEquals("記錄中 · 被拒收 420 筆 · 佇列 5 筆", near.summary)
        assertTrue(near.rejectedNote!!, near.rejectedNote!!.contains("已接近上限"))
        assertTrue(near.notificationHint!!.contains("同步失敗時通知我"))
        assertTrue(near.uploadEnabled)

        val full = ScreenStatus.map(base.copy(rejected = 500, notificationsOn = false))
        assertEquals("記錄中 · 上傳已停止 · 佇列 5 筆", full.summary)
        assertTrue(full.notificationHint != null)
        assertNull(ScreenStatus.map(base.copy(rejected = 500, notificationsOn = true)).notificationHint)
        // Opted in, but blocked in system settings: the hint points there instead.
        val blocked = ScreenStatus.map(base.copy(rejected = 500, notificationsOn = false, notificationsBlocked = true)).notificationHint!!
        assertTrue(blocked, blocked.contains("系統設定中關閉") && blocked.contains("開啟通知設定"))
    }
}
