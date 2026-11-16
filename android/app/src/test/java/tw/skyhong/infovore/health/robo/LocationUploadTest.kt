package tw.skyhong.infovore.health.robo

import android.net.Uri
import androidx.work.ListenableWorker.Result
import androidx.work.testing.TestListenableWorkerBuilder
import kotlinx.coroutines.runBlocking
import org.json.JSONObject
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import tw.skyhong.infovore.health.EndpointPolicy
import tw.skyhong.infovore.health.FakeIngestServer
import tw.skyhong.infovore.health.InfovoreApi
import tw.skyhong.infovore.health.SyncEnvironment
import tw.skyhong.infovore.health.location.LocationFix
import tw.skyhong.infovore.health.location.LocationQueue
import tw.skyhong.infovore.health.location.LocationSettings
import tw.skyhong.infovore.health.location.LocationUploadWorker
import tw.skyhong.infovore.health.location.LocationUploader
import tw.skyhong.infovore.health.location.TimelineImporter
import tw.skyhong.infovore.health.ui.LocationPanel
import tw.skyhong.infovore.health.ui.LocationState
import java.io.File

/**
 * Queued fixes and Timeline imports reaching a local [FakeIngestServer] through the real
 * [InfovoreApi]: what is sent, and that the queue only shrinks once the server stored a batch.
 */
@RunWith(RobolectricTestRunner::class)
class LocationUploadTest {
    private val server = FakeIngestServer()

    @Before
    fun setUp() {
        EndpointPolicy.testHttpHost = "127.0.0.1"
        SyncEnvironment.testApiTiming = InfovoreApi.Timing(connectTimeoutMs = 2_000, readTimeoutMs = 2_000, retryDelaysMs = listOf(1L), sleep = {})
        val settings = Robo.settings()
        settings.endpoint = server.endpoint
        settings.token = Robo.HEALTH_TOKEN
        LocationQueue(Robo.app).clear()
    }

    @After
    fun tearDown() = server.close()

    private fun fixes(count: Int, from: Long = 1_767_225_600_000) =
        (0 until count).map { LocationFix(from + it * 60_000L, 25.0 + it * 1e-4, 121.5, accuracy = 10.0) }

    @Test
    fun queuedFixesUploadInBatchesAndLeaveTheQueueOnlyOnceStored() {
        val queue = LocationQueue(Robo.app)
        fixes(1_500).forEach(queue::add)
        server.responder = { FakeIngestServer.Response(200, """{"ok":true}""") }

        assertEquals(1_500, LocationUploader.uploadQueued(Robo.app))
        assertEquals(0, queue.size())
        assertEquals(listOf(1_000, 500), server.requests.map { JSONObject(it.body).getJSONArray("points").length() })
        val request = server.requests.first()
        assertEquals("/api/ingest/location/batches", request.path)
        assertEquals("Bearer ${Robo.HEALTH_TOKEN}", request.authorization)
        val body = JSONObject(request.body)
        assertEquals("live", body.getString("source"))
        assertEquals(Robo.settings().deviceId, body.getString("deviceId"))
        assertEquals("2026-01-01T00:00:00Z", body.getJSONArray("points").getJSONObject(0).getString("time"))
    }

    @Test
    fun aFailedUploadKeepsTheFixesAndTheWorkerRetriesOrStops() {
        val queue = LocationQueue(Robo.app)
        fixes(3).forEach(queue::add)

        server.responder = { FakeIngestServer.Response(503, """{"error":"busy"}""") }
        val transient = runBlocking { TestListenableWorkerBuilder<LocationUploadWorker>(Robo.app).build().doWork() }
        assertEquals(Result.retry(), transient)
        assertEquals(3, queue.size())
        assertTrue(LocationSettings(Robo.app).lastUploadFailed)

        server.responder = { FakeIngestServer.Response(401, """{"error":"Unauthorized"}""") }
        val refused = runBlocking { TestListenableWorkerBuilder<LocationUploadWorker>(Robo.app).build().doWork() }
        assertEquals(Result.failure(), refused)
        assertEquals(3, queue.size())

        server.responder = { FakeIngestServer.Response(200, """{"ok":true}""") }
        assertEquals(Result.success(), runBlocking { TestListenableWorkerBuilder<LocationUploadWorker>(Robo.app).build().doWork() })
        assertEquals(0, queue.size())
        assertFalse(LocationSettings(Robo.app).lastUploadFailed)
    }

    @Test
    fun aTimelineFileImportsInBatchesWhileItIsRead() {
        server.responder = { FakeIngestServer.Response(200, """{"ok":true}""") }
        val segments = (0 until 700).joinToString(",") { i ->
            val start = java.time.Instant.ofEpochSecond(1_767_225_600L + i * 3_600L)
            """{"startTime":"$start","endTime":"${start.plusSeconds(1_800)}","visit":{"topCandidate":{"placeId":"p$i","placeLocation":{"latLng":"25.0°, 121.5°"}}}}"""
        }
        val file = File(Robo.app.cacheDir, "Timeline.json").apply { writeText("""{"semanticSegments":[$segments]}""") }

        assertTrue(TimelineImporter.start(Robo.app, Uri.fromFile(file)))
        Robo.waitFor(10_000) { !TimelineImporter.state.value.running }

        val state = TimelineImporter.state.value
        assertFalse(state.message, state.failed)
        assertEquals(700, state.sent)
        assertEquals(listOf(500, 200), server.requests.map { JSONObject(it.body).getJSONArray("visits").length() })
        assertTrue(server.requests.all { JSONObject(it.body).getString("source") == "timeline" })
        assertTrue(LocationSettings(Robo.app).lastImportStatus!!.contains("700 次停留"))
    }

    @Test
    fun aFileThatIsNotATimelineSaysSo() {
        val file = File(Robo.app.cacheDir, "other.json").apply { writeText("""{"photos":[]}""") }
        assertTrue(TimelineImporter.start(Robo.app, Uri.fromFile(file)))
        Robo.waitFor(10_000) { !TimelineImporter.state.value.running }
        val state = TimelineImporter.state.value
        assertTrue(state.failed)
        assertTrue(state.message!!, state.message!!.contains("不是 Google 地圖時間軸"))
        assertTrue(server.requests.isEmpty())
    }

    @Test
    fun thePanelOnlyShowsRecordingWhenItCanRecord() {
        val off = LocationPanel.map(enabled = false, fineGranted = true, backgroundGranted = false, problem = null, queued = 0, connectionReady = true, importing = false)
        assertEquals(LocationState.OFF, off.state)
        assertFalse(off.uploadEnabled)
        val revoked = LocationPanel.map(enabled = true, fineGranted = false, backgroundGranted = false, problem = null, queued = 5, connectionReady = true, importing = false)
        assertEquals(LocationState.NO_PERMISSION, revoked.state)
        assertFalse(revoked.checked)
        val paused = LocationPanel.map(enabled = true, fineGranted = true, backgroundGranted = false, problem = "x", queued = 5, connectionReady = true, importing = true)
        assertEquals(LocationState.PAUSED, paused.state)
        assertTrue(paused.offerBackground && paused.uploadEnabled && !paused.importEnabled)
        val recording = LocationPanel.map(enabled = true, fineGranted = true, backgroundGranted = true, problem = null, queued = 0, connectionReady = false, importing = false)
        assertEquals(LocationState.RECORDING, recording.state)
        assertFalse(recording.offerBackground || recording.importEnabled)
    }
}
