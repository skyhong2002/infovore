package tw.skyhong.infovore.health.robo

import androidx.work.ListenableWorker.Result
import androidx.work.NetworkType
import androidx.work.WorkInfo
import androidx.work.WorkManager
import androidx.work.testing.TestListenableWorkerBuilder
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import tw.skyhong.infovore.health.SyncFailureAlerts
import tw.skyhong.infovore.health.SyncFailureNotifier
import tw.skyhong.infovore.health.SyncKind
import tw.skyhong.infovore.health.SyncRunner
import tw.skyhong.infovore.health.SyncScheduler
import tw.skyhong.infovore.health.SyncWorker
import tw.skyhong.infovore.health.screen.ScreenUploadWorker
import java.util.concurrent.TimeUnit

/**
 * The background workers under WorkManager's test driver: both periodic works are scheduled at
 * start-up (once, with a network constraint), and SyncWorker's results and failure counting.
 * Health Connect is a fake that grants nothing, so a sync fails before any network request.
 */
@RunWith(RobolectricTestRunner::class)
class BackgroundWorkTest {
    private fun uniqueWork(name: String): List<WorkInfo> = WorkManager.getInstance(Robo.app).getWorkInfosForUniqueWork(name).get()

    private fun syncWorker(attempt: Int = 0): SyncWorker =
        TestListenableWorkerBuilder<SyncWorker>(Robo.app).setRunAttemptCount(attempt).build()

    @Test
    fun startUpSchedulesBothPeriodicWorksOnceWithANetworkConstraint() {
        // TestInfovoreApp ran the app's real start-up (InfovoreHealthApp.start).
        val sync = uniqueWork("infovore-health-periodic-sync").single()
        assertEquals(WorkInfo.State.ENQUEUED, sync.state)
        assertEquals(TimeUnit.HOURS.toMillis(SyncFailureAlerts.PERIOD_HOURS.toLong()), sync.periodicityInfo?.repeatIntervalMillis)
        assertEquals(NetworkType.CONNECTED, sync.constraints.requiredNetworkType)
        val upload = uniqueWork("infovore-dayflow-phone-upload").single()
        assertEquals(TimeUnit.MINUTES.toMillis(15), upload.periodicityInfo?.repeatIntervalMillis)
        assertEquals(NetworkType.CONNECTED, upload.constraints.requiredNetworkType)

        // Scheduling again (every process start) keeps the existing work rather than restarting it.
        SyncScheduler.schedule(Robo.app)
        ScreenUploadWorker.schedule(Robo.app)
        assertEquals(sync.id, uniqueWork("infovore-health-periodic-sync").single().id)
        assertEquals(upload.id, uniqueWork("infovore-dayflow-phone-upload").single().id)
    }

    @Test
    fun withoutATokenTheWorkersDoNothing() = runBlocking {
        assertEquals(Result.success(), syncWorker().doWork())
        assertEquals(0, Robo.settings().backgroundFailures)
        assertEquals("尚未同步", Robo.settings().lastStatus)
        val upload = TestListenableWorkerBuilder<ScreenUploadWorker>(Robo.app).build()
        assertEquals(Result.success(), upload.doWork())
    }

    @Test
    fun whileAManualSyncHoldsTheLockTheBackgroundSyncRetriesLater() = runBlocking {
        Robo.saveConnection()
        val started = CompletableDeferred<Unit>()
        val release = CompletableDeferred<Unit>()
        assertTrue(SyncRunner.coordinator.startManual(SyncKind.SLEEP) { started.complete(Unit); release.await() })
        try {
            withTimeout(5_000) { started.await() }
            assertEquals(Result.retry(), syncWorker().doWork())
            // Skipped, not failed: nothing counted, the status untouched.
            assertEquals(0, Robo.settings().backgroundFailures)
            assertFalse(Robo.settings().lastSyncFailed)
        } finally {
            release.complete(Unit)
            withTimeout(5_000) { while (SyncRunner.state.value.busy) kotlinx.coroutines.delay(10) }
        }
    }

    @Test
    fun onlyRunsWorkManagerGivesUpOnCountTowardTheWarning() = runBlocking {
        Robo.saveConnection()
        Robo.grantNotificationPermission()
        Robo.settings().notifyOnSyncFailure = true

        // An attempt WorkManager will retry: recorded as failed, not counted.
        assertEquals(Result.retry(), syncWorker(attempt = 0).doWork())
        assertTrue(Robo.settings().lastSyncFailed)
        assertTrue(Robo.settings().lastStatus.contains("背景同步失敗"))
        assertEquals(0, Robo.settings().backgroundFailures)

        // The last attempt of a period: counted.
        val last = SyncFailureAlerts.MAX_RETRIES
        assertEquals(Result.failure(), syncWorker(attempt = last).doWork())
        assertEquals(1, Robo.settings().backgroundFailures)
        assertNull(Robo.shadowNotifications.getNotification(SyncFailureNotifier.NOTIFICATION_ID))
        assertEquals(Result.failure(), syncWorker(attempt = last).doWork())
        assertNull(Robo.shadowNotifications.getNotification(SyncFailureNotifier.NOTIFICATION_ID))
        // The third period in a row posts the warning, with counts only.
        assertEquals(Result.failure(), syncWorker(attempt = last).doWork())
        assertEquals(SyncFailureAlerts.THRESHOLD, Robo.settings().backgroundFailures)
        val notification = requireNotNull(Robo.shadowNotifications.getNotification(SyncFailureNotifier.NOTIFICATION_ID))
        val text = notification.extras.getCharSequence(android.app.Notification.EXTRA_TEXT).toString()
        assertTrue(text.contains("連續失敗 3 次"))
        // The failure's reason (missing Health Connect permissions) stays in the app.
        assertFalse(text.contains("授權"))
        assertTrue(Robo.settings().syncFailureNotified)
    }
}
