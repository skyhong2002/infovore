package tw.skyhong.infovore.health.robo

import android.content.Context
import androidx.core.content.edit
import kotlinx.coroutines.runBlocking
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import tw.skyhong.infovore.health.DestinationChange
import tw.skyhong.infovore.health.EndpointPolicy
import tw.skyhong.infovore.health.FakeIngestServer
import tw.skyhong.infovore.health.MiniJson
import tw.skyhong.infovore.health.screen.ObservationQueue
import tw.skyhong.infovore.health.screen.ScreenSettings
import tw.skyhong.infovore.health.screen.ScreenUploader

/**
 * The phone screen-record upload (sensitive, opt-in) through the real [ScreenUploader],
 * [tw.skyhong.infovore.health.screen.ScreenUploadEngine] and [tw.skyhong.infovore.health.InfovoreApi]
 * against a local [FakeIngestServer]: endpoint, method, token, body, how answers are counted, and
 * that only what the server confirmed leaves the queue. Synthetic observations only.
 */
@RunWith(RobolectricTestRunner::class)
class ScreenUploadHttpTest {
    private val server = FakeIngestServer()
    private lateinit var destination: String

    @Before
    fun setUp() {
        EndpointPolicy.testHttpHost = "127.0.0.1"
        Robo.settings().endpoint = server.endpoint
        Robo.app.getSharedPreferences("infovore_health", Context.MODE_PRIVATE).edit { putString("device_id", DEVICE_ID) }
        destination = DestinationChange.normalize(server.endpoint)
        ScreenSettings(Robo.app).saveToken(Robo.PHONE_TOKEN, destination)
    }

    @After
    fun tearDown() {
        server.close()
        EndpointPolicy.testHttpHost = null
    }

    private fun enqueue(vararg ids: String) {
        val queue = ObservationQueue.get(Robo.app)
        val now = System.currentTimeMillis()
        ids.forEachIndexed { index, id ->
            queue.enqueueJson(destination, now - (ids.size - index) * 1_000L, id, """{"id":"$id","capturedAt":"2026-09-10T04:00:0${index}Z","blocked":true}""")
        }
    }

    @Suppress("UNCHECKED_CAST")
    private fun json(text: String) = MiniJson.parse(text) as Map<String, Any?>

    private fun idsIn(request: FakeIngestServer.Request) = (json(request.body)["observations"] as List<*>).map { (it as Map<*, *>)["id"] }

    @Test
    fun queuedObservationsArePostedWithThePhoneTokenAndRemovedOnceConfirmed() {
        enqueue("screen-obs-1", "screen-obs-2", "screen-obs-3")
        server.responder = { FakeIngestServer.Response(200, """{"ok":true,"accepted":2,"duplicates":1}""") }

        val outcome = runBlocking { ScreenUploader.uploadPending(Robo.app) }

        assertNull(outcome.error)
        assertEquals(3, outcome.sent)
        assertEquals(2, outcome.accepted)
        assertEquals(1, outcome.duplicates)
        assertEquals(0, outcome.remaining)
        val request = server.requests.single()
        assertEquals("POST", request.method)
        assertEquals(ScreenUploader.OBSERVATIONS_PATH, request.path)
        assertEquals("/api/ingest/dayflow-phone/observations", request.path)
        // The phone token, never the Health Connect token.
        assertEquals("Bearer ${Robo.PHONE_TOKEN}", request.authorization)
        assertEquals("application/json", request.contentType)
        val body = json(request.body)
        assertEquals(listOf("schemaVersion", "deviceId", "observations"), body.keys.toList())
        assertEquals(1.0, body["schemaVersion"])
        assertEquals(DEVICE_ID, body["deviceId"])
        assertEquals(listOf("screen-obs-1", "screen-obs-2", "screen-obs-3"), idsIn(request))
        assertEquals(0, ObservationQueue.get(Robo.app).count(destination))
    }

    @Test
    fun anObservationTheServerRejectsIsQuarantinedAndTheRestStillUploads() {
        enqueue("screen-obs-1", "screen-obs-bad", "screen-obs-3")
        server.responder = { request ->
            val ids = idsIn(request)
            if ("screen-obs-bad" in ids) {
                FakeIngestServer.Response(400, """{"error":"Invalid phone observation batch"}""")
            } else {
                FakeIngestServer.Response(200, """{"ok":true,"accepted":${ids.size},"duplicates":0}""")
            }
        }

        val outcome = runBlocking { ScreenUploader.uploadPending(Robo.app) }

        assertNull(outcome.error)
        assertEquals(2, outcome.sent)
        assertEquals(1, outcome.rejected)
        val queue = ObservationQueue.get(Robo.app)
        assertEquals(0, queue.count(destination))
        assertEquals(1, queue.countRejected())
        // The 400 is answered by splitting the batch, never by retrying the same request.
        assertEquals(listOf("screen-obs-1", "screen-obs-bad", "screen-obs-3"), idsIn(server.requests.first()))
        assertTrue(server.requests.drop(1).all { idsIn(it).size < 3 })
    }

    @Test
    fun aRefusedTokenKeepsEverythingQueued() {
        enqueue("screen-obs-1", "screen-obs-2")
        server.responder = { FakeIngestServer.Response(401, """{"error":"Unauthorized"}""") }

        val outcome = runBlocking { ScreenUploader.uploadPending(Robo.app) }

        assertTrue(outcome.error!!.contains("HTTP 401"))
        assertEquals(0, outcome.sent)
        assertEquals(2, outcome.remaining)
        assertEquals("not retried", 1, server.requests.size)
    }

    @Test
    fun theStatusCheckIsAnAuthenticatedGet() {
        server.responder = { FakeIngestServer.Response(200, """{"status":"ready","observations":12}""") }
        val status = runBlocking { ScreenUploader.checkStatus(Robo.app) }
        assertEquals("ready", status.getString("status"))
        val request = server.requests.single()
        assertEquals("GET", request.method)
        assertEquals(ScreenUploader.STATUS_PATH, request.path)
        assertEquals("Bearer ${Robo.PHONE_TOKEN}", request.authorization)
        assertEquals("", request.body)
    }

    private companion object {
        const val DEVICE_ID = "screen-test-device-01"
    }
}
