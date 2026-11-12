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

        override fun post(target: ScreenTarget, body: ByteArray): ObservationTransport.Response {
            posts++
            if (unavailable) throw IOException("Infovore HTTP 503: {\"error\":\"Storage is temporarily unavailable\",\"retryable\":true}")
            val observations = OBSERVATION.findAll(String(body)).toList()
            if (observations.any { it.groupValues[2].isNotEmpty() }) {
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
    fun statusTextCountsRejectedRecords() {
        val text = ScreenUploader.describe(ScreenUploadEngine.Outcome(8, 8, 0, 0, null, rejected = 2))
        assertTrue(text, text.contains("已送出 8 筆") && text.contains("2 筆被伺服器拒收"))
    }
}
