package tw.skyhong.infovore.health

import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import tw.skyhong.infovore.health.ui.ErrorText
import java.net.ConnectException
import java.net.ServerSocket
import java.net.SocketTimeoutException
import java.time.Instant
import java.util.concurrent.atomic.AtomicInteger

/**
 * The real [InfovoreApi] against a local HTTP server ([FakeIngestServer]): what goes on the wire
 * (method, path, Authorization, JSON body), how answers are parsed, which failures are retried,
 * and how timeouts and refused connections are classified for the user. Synthetic data only;
 * nothing but 127.0.0.1 is ever contacted.
 */
class InfovoreApiHttpTest {
    private val server = FakeIngestServer()
    private val sleeps = mutableListOf<Long>()
    private val timing = InfovoreApi.Timing(
        connectTimeoutMs = 2_000,
        readTimeoutMs = 2_000,
        retryDelaysMs = listOf(10L, 20L, 40L),
        sleep = { sleeps += it },
    )
    private val ids = AtomicInteger()

    private fun api(endpoint: String = server.endpoint, timing: InfovoreApi.Timing = this.timing) = InfovoreApi(
        endpoint,
        timing = timing,
        clock = { Instant.parse(OBSERVED_AT) },
        newSyncId = { "http-test-sync-%04d".format(ids.incrementAndGet()) },
    )

    @Before
    fun allowLoopback() {
        EndpointPolicy.testHttpHost = "127.0.0.1"
    }

    @After
    fun tearDown() {
        server.close()
        EndpointPolicy.testHttpHost = null
    }

    @Suppress("UNCHECKED_CAST")
    private fun Any?.obj() = this as Map<String, Any?>

    @Suppress("UNCHECKED_CAST")
    private fun Any?.list() = this as List<Any?>

    private fun json(body: String) = MiniJson.parse(body).obj()

    private val record = """{"id":"http-test-steps-1","dataType":"steps","dataOrigin":"com.example.watch",""" +
        """"startTime":"2026-09-09T00:00:00Z","endTime":"2026-09-09T01:00:00Z","lastModifiedTime":"2026-09-09T01:00:00Z","payload":{"count":1234}}"""

    @Test
    fun anUploadPostsTheBatchWithTheBearerTokenAndParsesA201() {
        server.responder = { FakeIngestServer.Response(201, """{"ok":true,"inserted":1,"updated":0,"deleted":0,"totalStored":1}""") }
        val result = api().upload(TOKEN, DEVICE, listOf(record), listOf("http-test-gone-1"))

        assertEquals(InfovoreApi.UploadResult(inserted = 1, updated = 0, deleted = 0, reconciled = false), result)
        val request = server.requests.single()
        assertEquals("POST", request.method)
        assertEquals("/api/ingest/health-connect", request.path)
        assertEquals("Bearer $TOKEN", request.authorization)
        assertEquals("application/json", request.contentType)
        val body = json(request.body)
        // The server's healthConnectBatchSchema, in this order; no reconcile key when none is sent.
        assertEquals(listOf("syncId", "deviceId", "observedAt", "records", "deletedRecordIds"), body.keys.toList())
        assertEquals("http-test-sync-0001", body["syncId"])
        assertEquals(DEVICE, body["deviceId"])
        assertEquals(OBSERVED_AT, body["observedAt"])
        assertEquals(listOf(json(record)), body["records"])
        assertEquals(listOf("http-test-gone-1"), body["deletedRecordIds"])
        assertTrue(sleeps.isEmpty())
    }

    @Test
    fun aReconcileWindowIsSentAndTheServersConfirmationIsReported() {
        server.responder = {
            FakeIngestServer.Response(
                200,
                """{"ok":true,"inserted":0,"updated":0,"deleted":2,"totalStored":5,""" +
                    """"reconciled":{"dataType":"steps","start":"2026-09-01T00:00:00Z","end":"2026-09-08T00:00:00Z","checked":7,"deleted":2}}""",
            )
        }
        val window = ReconcileWindow(
            "steps", Instant.parse("2026-09-01T00:00:00Z").toEpochMilli(), Instant.parse("2026-09-08T00:00:00Z").toEpochMilli(),
            listOf("kept-1", "kept-2"),
        )
        val result = api().upload(TOKEN, DEVICE, emptyList(), emptyList(), window)

        assertEquals(InfovoreApi.UploadResult(inserted = 0, updated = 0, deleted = 2, reconciled = true), result)
        val reconcile = json(server.requests.single().body)["reconcile"].obj()
        assertEquals(listOf("dataType", "start", "end", "recordIds"), reconcile.keys.toList())
        assertEquals("2026-09-01T00:00:00Z", reconcile["start"])
        assertEquals(listOf("kept-1", "kept-2"), reconcile["recordIds"])
    }

    @Test
    fun aConfirmedDeletionCarriesTheExpectedCountAndToken() {
        server.responder = { FakeIngestServer.Response(200, """{"ok":true,"inserted":0,"updated":0,"deleted":27,"reconciled":{"confirmed":true}}""") }
        val window = ReconcileWindow("steps", 0L, 86_400_000L, listOf("kept-1"), confirmDeleteExpected = 27, confirmDeleteToken = "a".repeat(64))
        api().upload(TOKEN, DEVICE, emptyList(), emptyList(), window)
        val confirm = json(server.requests.single().body)["reconcile"].obj()["confirmDelete"].obj()
        assertEquals(mapOf("expected" to 27.0, "token" to "a".repeat(64)), confirm)
    }

    @Test
    fun a400IsNotRetried() {
        server.responder = { FakeIngestServer.Response(400, """{"error":"Invalid batch"}""") }
        val error = assertThrows(InfovoreApi.HttpStatusException::class.java) {
            api().upload(TOKEN, DEVICE, listOf(record), emptyList())
        }
        assertEquals(400, error.status)
        assertNull(error.refusal)
        assertEquals(1, server.requests.size)
        assertTrue("no retry wait", sleeps.isEmpty())
        assertTrue(ErrorText.describe(error).startsWith("伺服器回應錯誤（HTTP 400）"))
    }

    @Test
    fun a401IsNotRetriedAndAsksForTheToken() {
        server.responder = { FakeIngestServer.Response(401, """{"error":"Unauthorized"}""") }
        val error = assertThrows(InfovoreApi.HttpStatusException::class.java) { api().getJson("/api/ingest/health-connect/status", TOKEN) }
        assertEquals(1, server.requests.size)
        assertTrue(ErrorText.describe(error).contains("token"))
    }

    /** The server's real 409 refusal from the shared contract fixture, parsed by the app. */
    @Test
    fun theServersReconcileRefusalIsParsedWithTokenAndOrigins() {
        @Suppress("UNCHECKED_CAST")
        val fixture = MiniJson.parse(repoFile("tests/fixtures/health-reconcile-contract.json").readText()) as Map<String, Any?>
        val refusal = fixture["confirmedDeleteCase"].obj()["expectedRefusalWithoutConfirmation"].obj()
        val body = CanonicalJson.write(mapOf("error" to "Reconcile would delete too many rows", "reconcile" to refusal))
        server.responder = { FakeIngestServer.Response(409, body) }

        val error = assertThrows(InfovoreApi.HttpStatusException::class.java) {
            api().upload(TOKEN, DEVICE, emptyList(), emptyList(), ReconcileWindow("steps", 0L, 86_400_000L, emptyList()))
        }
        assertEquals(409, error.status)
        assertEquals(1, server.requests.size)
        val parsed = requireNotNull(error.refusal)
        assertEquals((refusal["wouldDelete"] as Double).toInt(), parsed.wouldDelete)
        assertEquals((refusal["checked"] as Double).toInt(), parsed.checked)
        assertEquals(refusal["confirmToken"], parsed.confirmToken)
        val origins = refusal["byOrigin"].list().map { it.obj() }
        assertEquals(origins.map { OriginCount(it["origin"] as String, (it["count"] as Double).toInt()) }, parsed.byOrigin)
        assertTrue(parsed.byOrigin.isNotEmpty())
    }

    @Test
    fun a409WithoutReconcileCountsOrWithABadTokenIsReadSafely() {
        server.responder = { FakeIngestServer.Response(409, """{"error":"conflict"}""") }
        val plain = assertThrows(InfovoreApi.HttpStatusException::class.java) { api().upload(TOKEN, DEVICE, listOf(record), emptyList()) }
        assertNull(plain.refusal)

        server.responder = {
            FakeIngestServer.Response(
                409,
                """{"reconcile":{"status":"rejected","wouldDelete":40,"checked":50,"confirmToken":"not-a-digest",""" +
                    """"byOrigin":[{"origin":"com.example.watch","count":30},{"origin":"bad origin/../x","count":10},{"origin":"zero","count":0}]}}""",
            )
        }
        val refusal = requireNotNull(
            assertThrows(InfovoreApi.HttpStatusException::class.java) { api().upload(TOKEN, DEVICE, listOf(record), emptyList()) }.refusal,
        )
        assertEquals(40, refusal.wouldDelete)
        assertEquals(50, refusal.checked)
        assertNull("a malformed token is dropped", refusal.confirmToken)
        // Only package-name characters are kept; an entry without rows is skipped.
        assertEquals(listOf(OriginCount("com.example.watch", 30), OriginCount("bad_origin_.._x", 10)), refusal.byOrigin)
    }

    @Test
    fun aRetryable503IsRetriedWithBackoffUntilItSucceeds() {
        val calls = AtomicInteger()
        server.responder = {
            if (calls.incrementAndGet() <= 2) {
                FakeIngestServer.Response(503, """{"error":"Storage is temporarily unavailable; keep the batch and retry later","retryable":true}""")
            } else {
                FakeIngestServer.Response(201, """{"ok":true,"inserted":1,"updated":0,"deleted":0}""")
            }
        }
        val retries = mutableListOf<Int>()
        val result = api().upload(TOKEN, DEVICE, listOf(record), emptyList()) { attempt, _ -> retries += attempt }

        assertEquals(1, result.inserted)
        assertEquals(3, server.requests.size)
        assertEquals(listOf(2, 3), retries)
        assertEquals(listOf(10L, 20L), sleeps)
        // Every attempt is the same batch: the server deduplicates a committed retry by syncId.
        assertEquals(1, server.requests.map { it.body }.toSet().size)
    }

    @Test
    fun aRetryable503ThatPersistsFailsAsTransientAfterEveryAttempt() {
        server.responder = { FakeIngestServer.Response(503, """{"error":"Storage is temporarily unavailable","retryable":true}""") }
        val error = assertThrows(InfovoreApi.RetryableHttpException::class.java) { api().upload(TOKEN, DEVICE, listOf(record), emptyList()) }
        assertEquals(503, error.status)
        assertEquals(4, server.requests.size)
        assertEquals(listOf(10L, 20L, 40L), sleeps)
        assertEquals("伺服器暫時無法處理（HTTP 503），已自動重試數次；請稍後再試。", ErrorText.describe(error))
    }

    @Test
    fun a503ThatSaysItIsNotRetryableStopsAtOnce() {
        server.responder = { FakeIngestServer.Response(503, """{"error":"Health Connect ingestion is not configured","retryable":false}""") }
        val error = assertThrows(InfovoreApi.HttpStatusException::class.java) { api().upload(TOKEN, DEVICE, listOf(record), emptyList()) }
        assertEquals(503, error.status)
        assertEquals(1, server.requests.size)
        assertTrue(sleeps.isEmpty())
        assertTrue(ErrorText.describe(error).startsWith("伺服器尚未啟用此功能（HTTP 503）"))
    }

    @Test
    fun throttlingAndGatewayErrorsAreRetried() {
        val statuses = ArrayDeque(listOf(429, 408, 502))
        server.responder = {
            statuses.removeFirstOrNull()?.let { FakeIngestServer.Response(it, """{"error":"busy"}""") }
                ?: FakeIngestServer.Response(200, """{"status":"ready"}""")
        }
        assertEquals("ready", api().getJson("/api/ingest/health-connect/status", TOKEN).getString("status"))
        assertEquals(4, server.requests.size)
        assertTrue(server.requests.all { it.method == "GET" && it.authorization == "Bearer $TOKEN" && it.body.isEmpty() })
    }

    @Test
    fun aShortRetryAfterIsWaitedOutBeforeTheNextAttempt() {
        val calls = AtomicInteger()
        server.responder = {
            if (calls.incrementAndGet() == 1) {
                FakeIngestServer.Response(503, """{"error":"busy","retryable":true}""", headers = mapOf("Retry-After" to "15"))
            } else {
                FakeIngestServer.Response(201, """{"ok":true,"inserted":1,"updated":0,"deleted":0}""")
            }
        }
        val retries = mutableListOf<String>()
        assertEquals(1, api().upload(TOKEN, DEVICE, listOf(record), emptyList()) { _, message -> retries += message }.inserted)
        // The server's 15 s, not the client's 10 ms backoff.
        assertEquals(listOf(15_000L), sleeps)
        assertTrue(retries.single(), retries.single().endsWith("（伺服器要求 15 秒後再試）"))
    }

    @Test
    fun anHttpDateRetryAfterIsMeasuredFromTheClientsClock() {
        val calls = AtomicInteger()
        server.responder = {
            if (calls.incrementAndGet() == 1) {
                // OBSERVED_AT (the client's clock) is 04:00:00.
                FakeIngestServer.Response(429, """{"error":"slow down"}""", headers = mapOf("Retry-After" to "Thu, 10 Sep 2026 04:00:20 GMT"))
            } else {
                FakeIngestServer.Response(200, """{"status":"ready"}""")
            }
        }
        assertEquals("ready", api().getJson("/api/ingest/health-connect/status", TOKEN).getString("status"))
        assertEquals(listOf(20_000L), sleeps)
    }

    @Test
    fun aRetryAfterShorterThanTheBackoffKeepsTheBackoffAndAnInvalidOneIsIgnored() {
        val answers = ArrayDeque(listOf("0", "soon"))
        server.responder = {
            answers.removeFirstOrNull()?.let { FakeIngestServer.Response(503, """{"error":"busy"}""", headers = mapOf("Retry-After" to it)) }
                ?: FakeIngestServer.Response(200, """{"status":"ready"}""")
        }
        api().getJson("/x", TOKEN)
        assertEquals(listOf(10L, 20L), sleeps)
    }

    @Test
    fun aRetryAfterLongerThanTheCapEndsTheAttemptsAndIsHandedToTheCaller() {
        server.responder = { FakeIngestServer.Response(503, """{"error":"busy","retryable":true}""", headers = mapOf("Retry-After" to "900")) }
        val error = assertThrows(InfovoreApi.RetryableHttpException::class.java) { api().upload(TOKEN, DEVICE, listOf(record), emptyList()) }
        assertEquals(1, server.requests.size)
        assertTrue("no wait inside the run", sleeps.isEmpty())
        assertEquals(900_000L, error.retryAfterMs)
        assertEquals("伺服器暫時無法處理（HTTP 503），要求約 15 分鐘後再試。", ErrorText.describe(error))
        // Within the cap (here raised to 15 minutes) the same answer is waited out three times.
        val patient = timing.copy(maxRetryAfterMs = 900_000L)
        assertThrows(InfovoreApi.RetryableHttpException::class.java) { api(timing = patient).getJson("/x", TOKEN) }
        assertEquals(listOf(900_000L, 900_000L, 900_000L), sleeps)
    }

    @Test
    fun aNotRetryable503IgnoresRetryAfter() {
        server.responder = {
            FakeIngestServer.Response(503, """{"error":"Health Connect ingestion is not configured","retryable":false}""", headers = mapOf("Retry-After" to "5"))
        }
        assertThrows(InfovoreApi.HttpStatusException::class.java) { api().upload(TOKEN, DEVICE, listOf(record), emptyList()) }
        assertEquals(1, server.requests.size)
        assertTrue(sleeps.isEmpty())
    }

    @Test
    fun aServerThatNeverAnswersTimesOutAndIsClassifiedAsATimeout() {
        server.responder = { FakeIngestServer.Response(200, "{}", delayMs = 3_000) }
        val quick = timing.copy(readTimeoutMs = 200, retryDelaysMs = listOf(0L))
        val error = assertThrows(SocketTimeoutException::class.java) { api(timing = quick).upload(TOKEN, DEVICE, listOf(record), emptyList()) }
        assertEquals("tried twice", 2, server.requests.size)
        assertEquals("連線逾時，伺服器沒有回應；請確認網路後重試。", ErrorText.describe(error))
    }

    @Test
    fun aRefusedConnectionIsRetriedAndClassifiedAsUnreachable() {
        val closedPort = ServerSocket(0, 1, java.net.InetAddress.getLoopbackAddress()).use { it.localPort }
        val error = assertThrows(ConnectException::class.java) {
            api(endpoint = "http://127.0.0.1:$closedPort").upload(TOKEN, DEVICE, listOf(record), emptyList())
        }
        assertEquals(listOf(10L, 20L, 40L), sleeps)
        assertEquals("無法連線到伺服器，請確認網址、網路與 Tailscale 連線。", ErrorText.describe(error))
    }

    @Test
    fun theEndpointPolicyIsCheckedBeforeAnythingIsSent() {
        // Plain HTTP only to the allowed private host: nothing reaches the server otherwise.
        EndpointPolicy.testHttpHost = null
        val http = assertThrows(IllegalArgumentException::class.java) { api().upload(TOKEN, DEVICE, listOf(record), emptyList()) }
        assertTrue(http.message!!.contains("HTTPS"))
        assertThrows(IllegalArgumentException::class.java) { api(endpoint = "http://infovore.example").getJson("/x", TOKEN) }
        assertThrows(IllegalArgumentException::class.java) { api(endpoint = "ftp://infovore.example").getJson("/x", TOKEN) }
        assertTrue(server.requests.isEmpty())

        // HTTPS is accepted by the policy: the request is attempted (and fails only for want of a server).
        val closedPort = ServerSocket(0, 1, java.net.InetAddress.getLoopbackAddress()).use { it.localPort }
        assertThrows(ConnectException::class.java) {
            api(endpoint = "https://127.0.0.1:$closedPort", timing = timing.copy(retryDelaysMs = emptyList())).getJson("/x", TOKEN)
        }
        // The private host the network security config allows is the only other one.
        assertTrue(EndpointPolicy.isAllowed("http", EndpointPolicy.TAILSCALE_HTTP_HOST))
        assertFalse(EndpointPolicy.isAllowed("http", "127.0.0.1"))
    }

    @Test
    fun aShortTokenIsRefusedWithoutARequest() {
        assertThrows(IllegalArgumentException::class.java) { api().upload("short", DEVICE, listOf(record), emptyList()) }
        assertTrue(server.requests.isEmpty())
    }

    private companion object {
        const val TOKEN = "http-test-token-0123456789abcdef0123456789"
        const val DEVICE = "http-test-device-01"
        const val OBSERVED_AT = "2026-09-10T04:00:00Z"
    }
}
