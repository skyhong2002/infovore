package tw.skyhong.infovore.health.screen

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import tw.skyhong.infovore.health.DestinationChange
import tw.skyhong.infovore.health.InfovoreApi
import java.io.IOException

/**
 * Screen records are deleted only after the server confirms them. A batch the server rejects with
 * HTTP 400 is split until the rejected records are found; only those are quarantined (never sent
 * again, never deleted without the user), and every valid record still uploads.
 */
class ScreenQuarantineTest {
    @get:Rule
    val folder = TemporaryFolder()

    private val endpoint = "https://receiver.example"
    private val destination = DestinationChange.normalize(endpoint)
    private val target = ScreenTarget(endpoint, "t".repeat(40), destination, "device-fixture-1")

    /** Fake ingest endpoint: stores observations by id (idempotent) and rejects any batch holding an invalid one. */
    private class Receiver : ObservationTransport {
        val stored = linkedSetOf<String>()
        var posts = 0
        var unavailable = false
        var loseNextResponse = false
        /** The server-side problem was fixed: records it used to reject are accepted. */
        var acceptAll = false

        override fun post(target: ScreenTarget, body: ByteArray): ObservationTransport.Response {
            posts++
            if (unavailable) throw IOException("Infovore HTTP 503: {\"error\":\"Storage is temporarily unavailable\",\"retryable\":true}")
            val observations = OBSERVATION.findAll(String(body)).toList()
            if (!acceptAll && observations.any { it.groupValues[2].isNotEmpty() }) {
                throw InfovoreApi.HttpStatusException(400, "Infovore HTTP 400: Invalid phone observation batch: observations.0.capturedAt: Invalid datetime")
            }
            var accepted = 0
            for (match in observations) if (stored.add(match.groupValues[1])) accepted++
            if (loseNextResponse) {
                loseNextResponse = false
                throw IOException("connection reset after the server stored the batch")
            }
            return ObservationTransport.Response(accepted, observations.size - accepted)
        }

        companion object {
            val OBSERVATION = Regex("\\{\"id\":\"([^\"]+)\"(,\"bad\":true)?\\}")
        }
    }

    private val queue by lazy { ObservationQueue(folder.root) { it.startsWith("{") } }

    private fun capture(count: Int, invalid: Set<Int> = emptySet()) {
        val now = System.currentTimeMillis()
        repeat(count) { index ->
            val id = "obs-%02d".format(index)
            val json = if (index in invalid) "{\"id\":\"$id\",\"bad\":true}" else "{\"id\":\"$id\"}"
            queue.enqueueJson(destination, now - 1_000 + index, id, json)
        }
    }

    @Test
    fun aRetryable503KeepsEveryRecord() {
        capture(5)
        val receiver = Receiver().apply { unavailable = true }
        val outcome = ScreenUploadEngine(queue, receiver).upload(target)
        assertNotNull(outcome.error)
        assertEquals(0, outcome.sent)
        assertEquals(0, outcome.rejected)
        assertEquals(5, queue.count(destination))
        assertEquals(0, queue.countRejected())
    }

    @Test
    fun aMixedBatchQuarantinesOnlyTheInvalidRecords() {
        capture(10, invalid = setOf(3, 7))
        val receiver = Receiver()
        val outcome = ScreenUploadEngine(queue, receiver).upload(target)

        assertNull(outcome.error)
        assertEquals(8, outcome.sent)
        assertEquals(2, outcome.rejected)
        assertEquals(0, outcome.remaining)
        assertEquals((0 until 10).filter { it != 3 && it != 7 }.map { "obs-%02d".format(it) }, receiver.stored.toList())
        assertEquals(2, queue.countRejected())

        // Quarantined records are never sent again and never pruned automatically.
        val posts = receiver.posts
        val again = ScreenUploadEngine(queue, receiver).upload(target)
        assertEquals(0, again.sent)
        assertEquals(posts, receiver.posts)
        queue.prune(System.currentTimeMillis() + 30L * 24 * 60 * 60 * 1000)
        assertEquals(2, queue.countRejected())

        // Only the user's confirmed delete removes them.
        assertEquals(2, queue.removeRejected())
        assertEquals(0, queue.countRejected())
    }

    @Test
    fun resendingAfterRecoveryIsIdempotent() {
        capture(6)
        val receiver = Receiver().apply { loseNextResponse = true }
        val engine = ScreenUploadEngine(queue, receiver, maxBatchCount = 3)

        // The first batch reached the server but its answer was lost: it stays queued.
        val lost = engine.upload(target)
        assertNotNull(lost.error)
        assertEquals(6, queue.count(destination))

        receiver.unavailable = true
        assertNotNull(engine.upload(target).error)
        assertEquals(6, queue.count(destination))

        receiver.unavailable = false
        val recovered = engine.upload(target)
        assertNull(recovered.error)
        assertEquals(6, recovered.sent)
        assertEquals(3, recovered.duplicates)
        assertEquals(3, recovered.accepted)
        assertEquals(0, queue.count(destination))
        assertEquals((0 until 6).map { "obs-%02d".format(it) }, receiver.stored.toList())
    }

    @Test
    fun aWhollyRejectedBatchIsQuarantinedAndStopsTheRun() {
        capture(6, invalid = (0 until 6).toSet())
        val receiver = Receiver()
        val outcome = ScreenUploadEngine(queue, receiver, maxBatchCount = 3).upload(target)
        assertEquals(ScreenUploadEngine.REJECTED_WHOLE_BATCH, outcome.error)
        assertEquals(3, outcome.rejected)
        assertEquals(3, queue.countRejected())
        // The rest stays queued, untouched, for the next run.
        assertEquals(3, queue.count(destination))
        assertTrue(receiver.stored.isEmpty())
    }

    @Test
    fun theScreenSectionShowsRejectedRecordsSeparately() {
        val base = tw.skyhong.infovore.health.ui.ScreenInputs(
            recordingEnabled = false, pausedUntilMs = 0, serviceEnabled = false, tokenConfigured = true, pending = 0,
            lastCaptureAtMs = 0, lastUploadStatus = "尚未上傳", nowMs = 0, zone = java.time.ZoneOffset.UTC,
        )
        assertNull(tw.skyhong.infovore.health.ui.ScreenStatus.map(base).rejectedNote)
        val ui = tw.skyhong.infovore.health.ui.ScreenStatus.map(base.copy(rejected = 2))
        assertTrue(ui.rejectedNote!!.startsWith("2 筆畫面紀錄被伺服器拒收"))
        assertTrue(ui.details.contains("被拒收：2 筆"))
        // Rejected records are not pending uploads.
        assertEquals(false, ui.uploadEnabled)
    }

    @Test
    fun aFullQuarantineSaysPendingRecordsAreKeptPastSevenDaysButNotPastTheSizeCap() {
        val base = tw.skyhong.infovore.health.ui.ScreenInputs(
            recordingEnabled = true, pausedUntilMs = 0, serviceEnabled = true, tokenConfigured = true, pending = 5,
            lastCaptureAtMs = 0, lastUploadStatus = "尚未上傳", nowMs = 0, zone = java.time.ZoneOffset.UTC,
        )
        val ui = tw.skyhong.infovore.health.ui.ScreenStatus.map(base.copy(rejected = 500, maxRejected = 500))
        assertTrue(ui.quarantineFull)
        for (text in listOf(ui.rejectedNote!!, ui.nextStep!!)) {
            assertTrue(text, text.contains("不會因超過 7 天而刪除") && text.contains("40 MB") && text.contains("仍會刪除最舊的紀錄"))
            assertTrue(text, !text.contains("不會自動刪除任何紀錄"))
        }
    }

    @Test
    fun rejectedRecordsCanBePutBackIntoTheirOwnDestinationOnly() {
        capture(4, invalid = setOf(1, 2))
        val receiver = Receiver()
        ScreenUploadEngine(queue, receiver).upload(target)
        assertEquals(2, queue.countRejected())
        assertEquals(2, queue.countRequeueable(destination))
        // Another destination never gets them.
        val other = DestinationChange.normalize("https://other.example")
        assertEquals(0, queue.countRequeueable(other))
        assertEquals(0, queue.requeueRejected(other))
        assertEquals(2, queue.countRejected())

        // A legacy (pre-0.4.1) quarantined file has no destination: it can only be deleted.
        java.io.File(folder.root, "rejected").resolve("000000000000001-legacy.json").writeText("{\"id\":\"legacy\"}")
        assertEquals(3, queue.countRejected())
        assertEquals(2, queue.countRequeueable(destination))

        // Back in the queue they are sent again; still invalid, they return to quarantine.
        assertEquals(2, queue.requeueRejected(destination))
        assertEquals(1, queue.countRejected())
        assertEquals(2, queue.count(destination))
        val again = ScreenUploadEngine(queue, receiver).upload(target)
        assertEquals(2, again.rejected)
        assertEquals(3, queue.countRejected())

        // Fixed on the server side: requeued records upload.
        receiver.acceptAll = true
        assertEquals(2, queue.requeueRejected(destination))
        val fixed = ScreenUploadEngine(queue, receiver).upload(target)
        assertNull(fixed.error)
        assertEquals(2, fixed.sent)
        assertEquals(listOf("obs-00", "obs-03", "obs-01", "obs-02"), receiver.stored.toList())
        assertEquals(1, queue.countRejected())
        assertEquals(1, queue.removeRejected())
        assertEquals(0, queue.countRejected())
    }

    @Test
    fun recordsOlderThanTheQueueKeepsAreNotPutBack() {
        val old = System.currentTimeMillis() - ObservationQueue.MAX_AGE_MS - 60_000
        queue.enqueueJson(destination, System.currentTimeMillis(), "fresh", "{\"id\":\"fresh\",\"bad\":true}")
        val engine = ScreenUploadEngine(queue, Receiver())
        engine.upload(target)
        // Quarantine an old record directly, as if it had been rejected a week ago.
        queue.enqueueJson(destination, System.currentTimeMillis(), "tmp", "{}")
        val entry = queue.read(destination, 1).single()
        val aged = ObservationQueue.Entry(java.io.File(entry.file.parentFile, "${old.toString().padStart(15, '0')}-aged.json").also { entry.file.renameTo(it) }, "{}")
        queue.quarantine(destination, listOf(aged))
        assertEquals(2, queue.countRejected())
        assertEquals(1, queue.countRequeueable(destination))
        assertEquals(1, queue.requeueRejected(destination))
        assertEquals(1, queue.countRejected())
    }

    @Test
    fun aFullQuarantineStopsUploadsAndDeletesNothing() {
        capture(6, invalid = setOf(0, 2, 4))
        val receiver = Receiver()
        // Room for two more rejections: the third rejected record stops the run and stays queued.
        val engine = ScreenUploadEngine(queue, receiver, maxBatchCount = 1, maxRejected = 2)
        val outcome = engine.upload(target)
        assertEquals(ScreenUploadEngine.QUARANTINE_FULL, outcome.error)
        assertEquals(2, outcome.rejected)
        assertEquals(2, queue.countRejected())
        assertEquals(listOf("obs-01", "obs-03"), receiver.stored.toList())
        assertEquals(2, queue.count(destination))

        // While full, nothing is sent at all.
        val posts = receiver.posts
        val blocked = engine.upload(target)
        assertEquals(ScreenUploadEngine.QUARANTINE_FULL, blocked.error)
        assertEquals(posts, receiver.posts)
        assertEquals(2, queue.count(destination))

        // Dealing with the quarantine resumes uploads.
        queue.removeRejected()
        receiver.acceptAll = true
        val resumed = engine.upload(target)
        assertNull(resumed.error)
        assertEquals(0, queue.count(destination))
    }

    @Test
    fun theScreenSectionExplainsRequeueAndAFullQuarantine() {
        val base = tw.skyhong.infovore.health.ui.ScreenInputs(
            recordingEnabled = true, pausedUntilMs = 0, serviceEnabled = true, tokenConfigured = true, pending = 3,
            lastCaptureAtMs = 0, lastUploadStatus = "尚未上傳", nowMs = 0, zone = java.time.ZoneOffset.UTC,
        )
        val some = tw.skyhong.infovore.health.ui.ScreenStatus.map(base.copy(rejected = 3, requeueable = 2))
        assertEquals("放回佇列重送（2 筆）", some.requeueLabel)
        assertTrue(some.rejectedNote!!, some.rejectedNote!!.contains("其中 2 筆可放回"))
        assertEquals(false, some.quarantineFull)
        assertEquals(true, some.uploadEnabled)

        val none = tw.skyhong.infovore.health.ui.ScreenStatus.map(base.copy(rejected = 3, requeueable = 0))
        assertNull(none.requeueLabel)
        assertTrue(none.rejectedNote!!.contains("只能刪除"))

        val full = tw.skyhong.infovore.health.ui.ScreenStatus.map(base.copy(rejected = ObservationQueue.MAX_REJECTED))
        assertTrue(full.quarantineFull)
        assertEquals(false, full.uploadEnabled)
        assertTrue(full.uploadHint!!.contains("已停止上傳"))
        assertTrue(full.nextStep!!.contains("已停止上傳"))
        assertEquals(tw.skyhong.infovore.health.ui.Tone.WARNING, full.tone)
    }

    @Test
    fun statusTextCountsRejectedRecords() {
        val text = ScreenUploader.describe(ScreenUploadEngine.Outcome(8, 8, 0, 0, null, rejected = 2))
        assertTrue(text, text.contains("已送出 8 筆") && text.contains("2 筆被伺服器拒收"))
    }
}
