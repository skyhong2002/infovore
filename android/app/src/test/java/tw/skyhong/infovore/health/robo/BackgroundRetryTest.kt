package tw.skyhong.infovore.health.robo

import androidx.health.connect.client.records.StepsRecord
import androidx.health.connect.client.records.metadata.Metadata
import androidx.health.connect.client.testing.FakeHealthConnectClient
import androidx.health.connect.client.testing.FakePermissionController
import androidx.work.ListenableWorker.Result
import androidx.work.WorkInfo
import androidx.work.WorkManager
import androidx.work.testing.TestListenableWorkerBuilder
import androidx.work.workDataOf
import kotlinx.coroutines.runBlocking
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import tw.skyhong.infovore.health.BackgroundRetry
import tw.skyhong.infovore.health.EndpointPolicy
import tw.skyhong.infovore.health.FakeIngestServer
import tw.skyhong.infovore.health.HealthConnectAccess
import tw.skyhong.infovore.health.HealthConnectSync
import tw.skyhong.infovore.health.InfovoreApi
import tw.skyhong.infovore.health.SyncEnvironment
import tw.skyhong.infovore.health.SyncFailureAlerts
import tw.skyhong.infovore.health.SyncScheduler
import tw.skyhong.infovore.health.SyncWorker
import tw.skyhong.infovore.health.screen.ObservationQueue
import tw.skyhong.infovore.health.screen.ScreenSettings
import tw.skyhong.infovore.health.screen.ScreenUploadWorker
import tw.skyhong.infovore.health.screen.ScreenUploader
import tw.skyhong.infovore.health.DestinationChange
import java.time.Instant
import java.time.ZoneOffset
import java.time.ZonedDateTime
import java.time.format.DateTimeFormatter
import java.util.concurrent.CopyOnWriteArrayList

/**
 * The real background workers (SyncWorker, ScreenUploadWorker) under WorkManager's test driver,
 * with the real HealthConnectSync / ScreenUploader and InfovoreApi talking HTTP to a local
 * [FakeIngestServer]: which failures stop at once, which retry within WorkManager's backoff, and
 * how the server's Retry-After sets the next attempt. Client waits are recorded, not slept.
 * Synthetic data only; nothing but 127.0.0.1 is contacted.
 */
@RunWith(RobolectricTestRunner::class)
class BackgroundRetryTest {
    private val server = FakeIngestServer()
    private val sleeps: MutableList<Long> = CopyOnWriteArrayList()

    @Before
    fun setUp() {
        EndpointPolicy.testHttpHost = "127.0.0.1"
        SyncEnvironment.testApiTiming = InfovoreApi.Timing(
            connectTimeoutMs = 2_000,
            readTimeoutMs = 2_000,
            retryDelaysMs = listOf(1L, 2L, 4L),
            sleep = { sleeps += it },
        )
        val settings = Robo.settings()
        settings.endpoint = server.endpoint
        settings.token = Robo.HEALTH_TOKEN
        settings.initialImportDone = true
        // One synthetic steps record, so every sync sends at least one batch.
        val now = Instant.now()
        val fake = FakeHealthConnectClient(
            permissionController = FakePermissionController(grantAll = false).apply { grantPermissions(HealthConnectSync.readPermissions) },
        )
        runBlocking {
            fake.insertRecords(
                listOf(
                    StepsRecord(
                        startTime = now.minusSeconds(7_200), startZoneOffset = ZoneOffset.UTC,
                        endTime = now.minusSeconds(3_600), endZoneOffset = ZoneOffset.UTC,
                        count = 1_234, metadata = Metadata.manualEntry("retry-test-steps-1", 1, null),
                    ),
                ),
            )
        }
        HealthConnectAccess.testClient = fake
    }

    @After
    fun tearDown() {
        server.close()
        EndpointPolicy.testHttpHost = null
        SyncEnvironment.testApiTiming = null
    }

    private fun syncWorker(attempt: Int = 0, followUpOf: Int? = null): SyncWorker =
        TestListenableWorkerBuilder<SyncWorker>(Robo.app)
            .setRunAttemptCount(attempt)
            .apply { if (followUpOf != null) setInputData(workDataOf(SyncWorker.KEY_ATTEMPT to followUpOf, SyncWorker.KEY_FOLLOW_UP to true)) }
            .build()

    private fun followUps(): List<WorkInfo> =
        WorkManager.getInstance(Robo.app).getWorkInfosForUniqueWork(SyncScheduler.RETRY_WORK_NAME).get()

    private fun answer(status: Int, body: String, retryAfter: String? = null) {
        server.responder = { FakeIngestServer.Response(status, body, headers = retryAfter?.let { mapOf("Retry-After" to it) } ?: emptyMap()) }
    }

    private val busy = """{"error":"Storage is temporarily unavailable; keep the batch and retry later","retryable":true}"""

    // ---- Errors only the user can fix: no retry ----

    @Test
    fun a401EndsTheRunAtOnceAndSaysWhatToFix() = runBlocking {
        answer(401, """{"error":"Unauthorized"}""")
        assertEquals(Result.failure(), syncWorker().doWork())
        assertEquals("the client does not retry it either", 1, server.requests.size)
        assertTrue(sleeps.isEmpty())
        val status = Robo.settings().lastStatus
        assertTrue(status, status.contains("背景同步失敗，需要處理：伺服器拒絕了 token（HTTP 401）"))
        assertTrue(status, status.contains("不會重試這個錯誤"))
        assertTrue(Robo.settings().lastSyncFailed)
        // Counted at once: this period will not try again.
        assertEquals(1, Robo.settings().backgroundFailures)
        assertTrue(followUps().isEmpty())
    }

    @Test
    fun badRequestsForbiddenAndUnconfiguredServersAreNotRetried() = runBlocking {
        for ((status, body) in listOf(
            400 to """{"error":"Invalid batch"}""",
            403 to """{"error":"Forbidden"}""",
            503 to """{"error":"Health Connect ingestion is not configured","retryable":false}""",
        )) {
            server.requests.clear()
            // A Retry-After on any of them changes nothing.
            answer(status, body, retryAfter = "5")
            assertEquals("HTTP $status", Result.failure(), syncWorker().doWork())
            // No batch is sent twice. (A 400 on a reconcile window marks that window unverified and
            // the sync goes on to the next batch: HealthSyncEngine's own handling.)
            assertTrue("HTTP $status", server.requests.isNotEmpty())
            assertEquals("HTTP $status", server.requests.size, server.requests.map { it.body }.toSet().size)
            assertTrue("HTTP $status: ${Robo.settings().lastStatus}", Robo.settings().lastStatus.contains("需要處理"))
        }
        assertTrue(sleeps.isEmpty())
        assertTrue(followUps().isEmpty())
    }

    @Test
    fun aRefusedEndpointOrMissingPermissionsNeedTheUserAndSendNothing() = runBlocking {
        // Plain HTTP to a host the endpoint policy does not allow.
        Robo.settings().endpoint = "http://infovore.example"
        assertEquals(Result.failure(), syncWorker().doWork())
        assertTrue(Robo.settings().lastStatus, Robo.settings().lastStatus.contains("需要處理：自訂 endpoint 必須使用 HTTPS"))

        Robo.settings().endpoint = server.endpoint
        HealthConnectAccess.testClient = FakeHealthConnectClient(permissionController = FakePermissionController(grantAll = false))
        assertEquals(Result.failure(), syncWorker().doWork())
        assertTrue(Robo.settings().lastStatus, Robo.settings().lastStatus.contains("需要處理：請先授權 Health Connect"))
        assertTrue(server.requests.isEmpty())
        assertEquals(2, Robo.settings().backgroundFailures)
    }

    // ---- Transient errors: WorkManager's backoff, or the server's Retry-After ----

    @Test
    fun aRetryable503WithoutAHintRetriesWithBackoffAndCountsOnlyTheLastAttempt() = runBlocking {
        answer(503, busy)
        assertEquals(Result.retry(), syncWorker(attempt = 0).doWork())
        assertEquals("the client tried four times", 4, server.requests.size)
        assertEquals(listOf(1L, 2L, 4L), sleeps)
        assertTrue(Robo.settings().lastStatus, Robo.settings().lastStatus.contains("稍後自動重試"))
        assertEquals(0, Robo.settings().backgroundFailures)

        assertEquals(Result.failure(), syncWorker(attempt = SyncFailureAlerts.MAX_RETRIES).doWork())
        assertEquals(1, Robo.settings().backgroundFailures)
        assertTrue(followUps().isEmpty())
    }

    @Test
    fun aShortRetryAfterIsWaitedOutInsideTheRun() = runBlocking {
        var first = true
        server.responder = {
            if (first) {
                first = false
                FakeIngestServer.Response(429, """{"error":"slow down"}""", headers = mapOf("Retry-After" to "10"))
            } else {
                FakeIngestServer.Response(201, """{"ok":true,"inserted":1,"updated":0,"deleted":0}""")
            }
        }
        assertEquals(Result.success(), syncWorker().doWork())
        assertEquals("waited the server's 10 s, not the 1 ms backoff", 10_000L, sleeps.first())
        assertFalse(Robo.settings().lastSyncFailed)
    }

    @Test
    fun aRetryAfterWithinWorkManagersBackoffIsLeftToIt() = runBlocking {
        // 20 s per attempt inside the client (under its 30 s cap); WorkManager's next backoff is 30 s.
        answer(503, busy, retryAfter = "20")
        assertEquals(Result.retry(), syncWorker().doWork())
        assertEquals(listOf(20_000L, 20_000L, 20_000L), sleeps)
        assertTrue(followUps().isEmpty())
    }

    @Test
    fun aLongRetryAfterSchedulesTheNextAttemptForWhenTheServerAsked() = runBlocking {
        answer(503, busy, retryAfter = "900")
        assertEquals(Result.failure(), syncWorker().doWork())
        assertEquals("no attempt inside the run after the hint", 1, server.requests.size)
        assertTrue(sleeps.isEmpty())
        val next = followUps().single()
        assertEquals(WorkInfo.State.ENQUEUED, next.state)
        assertEquals(900_000L, next.initialDelayMillis)
        assertEquals(androidx.work.NetworkType.CONNECTED, next.constraints.requiredNetworkType)
        val status = Robo.settings().lastStatus
        assertTrue(status, status.contains("背景同步延後：伺服器暫時無法處理（HTTP 503），要求約 15 分鐘後再試。"))
        assertTrue(status, status.contains("約 15 分鐘後自動重試"))
        // Not given up: nothing counted yet.
        assertEquals(0, Robo.settings().backgroundFailures)
    }

    @Test
    fun anHttpDateRetryAfterIsHonouredAndCappedAtOnePeriod() = runBlocking {
        val inTwoHours = DateTimeFormatter.RFC_1123_DATE_TIME.format(ZonedDateTime.now(ZoneOffset.UTC).plusHours(2))
        answer(503, busy, retryAfter = inTwoHours)
        assertEquals(Result.failure(), syncWorker().doWork())
        val delay = followUps().single().initialDelayMillis
        assertTrue("$delay", delay in 7_190_000L..7_200_000L)

        answer(503, busy, retryAfter = "86400")
        assertEquals(Result.failure(), syncWorker().doWork())
        assertEquals("a newer follow-up replaces the waiting one", BackgroundRetry.MAX_WAIT_MS, followUps().single { it.state == WorkInfo.State.ENQUEUED }.initialDelayMillis)
    }

    @Test
    fun theFollowUpRetriesWithinBackoffButNeverChainsAnotherWait() = runBlocking {
        // The follow-up is this period's second attempt; a short hint goes to WorkManager's backoff.
        answer(503, busy, retryAfter = "20")
        assertEquals(Result.retry(), syncWorker(followUpOf = 1).doWork())
        assertEquals(0, Robo.settings().backgroundFailures)

        // A long hint again: it gives up until the next period, counted, and schedules nothing.
        answer(503, busy, retryAfter = "900")
        assertEquals(Result.failure(), syncWorker(followUpOf = 1).doWork())
        assertTrue(followUps().isEmpty())
        assertEquals(1, Robo.settings().backgroundFailures)

        // Its attempts count on from the periodic run's: the last one gives up.
        answer(503, busy)
        assertEquals(Result.failure(), syncWorker(attempt = SyncFailureAlerts.MAX_RETRIES - 1, followUpOf = 1).doWork())
        assertEquals(2, Robo.settings().backgroundFailures)
    }

    @Test
    fun aSuccessfulPeriodicSyncCancelsAWaitingFollowUp() = runBlocking {
        answer(503, busy, retryAfter = "900")
        syncWorker().doWork()
        assertEquals(WorkInfo.State.ENQUEUED, followUps().single().state)
        answer(201, """{"ok":true,"inserted":1,"updated":0,"deleted":0}""")
        assertEquals(Result.success(), syncWorker().doWork())
        assertEquals(WorkInfo.State.CANCELLED, followUps().single().state)
    }

    // ---- The screen-record upload worker ----

    private fun enqueueObservation() {
        val destination = DestinationChange.normalize(server.endpoint)
        ScreenSettings(Robo.app).saveToken(Robo.PHONE_TOKEN, destination)
        ObservationQueue.get(Robo.app).enqueueJson(destination, System.currentTimeMillis(), "obs-1", """{"id":"obs-1","capturedAt":"2026-11-13T04:00:00Z","blocked":true}""")
    }

    private fun uploadWorker(attempt: Int = 0) = TestListenableWorkerBuilder<ScreenUploadWorker>(Robo.app).setRunAttemptCount(attempt).build()

    @Test
    fun screenUploadsStopOnA401AndRetryATransientFailure() = runBlocking {
        enqueueObservation()
        answer(401, """{"error":"Unauthorized"}""")
        assertEquals(Result.failure(), uploadWorker().doWork())
        assertEquals(1, server.requests.size)
        assertEquals(1, ObservationQueue.get(Robo.app).count(DestinationChange.normalize(server.endpoint)))

        answer(503, busy)
        assertEquals(Result.retry(), uploadWorker().doWork())
        assertEquals(Result.failure(), uploadWorker(attempt = SyncFailureAlerts.MAX_RETRIES).doWork())
        assertEquals(0L, ScreenSettings(Robo.app).retryNotBefore)
    }

    @Test
    fun screenUploadsWaitForALongRetryAfterExceptWhenTheUserAsks() = runBlocking {
        enqueueObservation()
        answer(503, busy, retryAfter = "600")
        val before = System.currentTimeMillis()
        assertEquals(Result.failure(), uploadWorker().doWork())
        assertEquals(1, server.requests.size)
        val notBefore = ScreenSettings(Robo.app).retryNotBefore
        assertTrue("$notBefore", notBefore in (before + 600_000L)..(System.currentTimeMillis() + 600_000L))
        assertTrue(ScreenSettings(Robo.app).lastUploadStatus, ScreenSettings(Robo.app).lastUploadStatus.contains("伺服器要求約 10 分鐘後再試"))

        // The next periodic run (and the recording service) sends nothing before then.
        assertEquals(Result.success(), uploadWorker().doWork())
        assertEquals(notBefore, ScreenUploader.uploadPending(Robo.app, automatic = true).deferredUntilMs)
        assertEquals(1, server.requests.size)
        // A manual upload is the user's choice: it tries, and success clears the wait.
        answer(200, """{"accepted":1,"duplicates":0}""")
        assertEquals(1, ScreenUploader.uploadPending(Robo.app).sent)
        assertEquals(2, server.requests.size)
        assertEquals(0L, ScreenSettings(Robo.app).retryNotBefore)
    }
}
