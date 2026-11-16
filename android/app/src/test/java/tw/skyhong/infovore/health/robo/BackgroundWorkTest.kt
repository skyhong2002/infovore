package tw.skyhong.infovore.health.robo

import androidx.work.ListenableWorker.Result
import androidx.work.ExistingPeriodicWorkPolicy
import androidx.work.NetworkType
import androidx.work.PeriodicWorkRequestBuilder
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
import tw.skyhong.infovore.health.RetiredScreenRecorder
import tw.skyhong.infovore.health.SyncFailureAlerts
import tw.skyhong.infovore.health.SyncFailureNotifier
import tw.skyhong.infovore.health.SyncKind
import tw.skyhong.infovore.health.SyncRunner
import tw.skyhong.infovore.health.SyncScheduler
import tw.skyhong.infovore.health.SyncWorker
import java.util.concurrent.TimeUnit

/**
 * The background workers under WorkManager's test driver: both periodic works are scheduled at
 * start-up (once, with a network constraint), and SyncWorker's results and failure counting.
 * Health Connect is a fake that grants nothing, so a sync fails before any network request;
 * failures over HTTP and the server's Retry-After are in BackgroundRetryTest.
 */
@RunWith(RobolectricTestRunner::class)
class BackgroundWorkTest {
    private fun uniqueWork(name: String): List<WorkInfo> = WorkManager.getInstance(Robo.app).getWorkInfosForUniqueWork(name).get()

    private fun syncWorker(attempt: Int = 0): SyncWorker =
        TestListenableWorkerBuilder<SyncWorker>(Robo.app).setRunAttemptCount(attempt).build()

    @Test
    fun startUpSchedulesThePeriodicSyncOnceWithANetworkConstraint() {
        // TestInfovoreApp ran the app's real start-up (InfovoreHealthApp.start).
        val sync = uniqueWork("infovore-health-periodic-sync").single()
        assertEquals(WorkInfo.State.ENQUEUED, sync.state)
        assertEquals(TimeUnit.HOURS.toMillis(SyncFailureAlerts.PERIOD_HOURS.toLong()), sync.periodicityInfo?.repeatIntervalMillis)
        assertEquals(NetworkType.CONNECTED, sync.constraints.requiredNetworkType)

        // Scheduling again (every process start) keeps the existing work rather than restarting it.
        SyncScheduler.schedule(Robo.app)
        assertEquals(sync.id, uniqueWork("infovore-health-periodic-sync").single().id)
    }

    @Test
    fun anUpgradeRemovesTheRetiredScreenRecordersWorkFilesAndSettingsOnce() {
        // What 0.5.1 left behind: the periodic upload, queued captures and the recorder's settings.
        Robo.app.getSharedPreferences("infovore_migrations", 0).edit().clear().commit()
        WorkManager.getInstance(Robo.app).enqueueUniquePeriodicWork(
            RetiredScreenRecorder.WORK_NAME,
            ExistingPeriodicWorkPolicy.KEEP,
            PeriodicWorkRequestBuilder<SyncWorker>(15, TimeUnit.MINUTES).build(),
        ).result.get()
        val queued = java.io.File(Robo.app.noBackupFilesDir, "${RetiredScreenRecorder.QUEUE_DIR}/d-abc/1.json").apply { parentFile!!.mkdirs(); writeText("{}") }
        Robo.app.getSharedPreferences(RetiredScreenRecorder.PREFERENCES, 0).edit().putBoolean("enabled", true).commit()

        RetiredScreenRecorder.cleanUp(Robo.app)

        assertTrue(uniqueWork(RetiredScreenRecorder.WORK_NAME).all { it.state == WorkInfo.State.CANCELLED })
        assertFalse(queued.exists())
        assertFalse(java.io.File(Robo.app.noBackupFilesDir, RetiredScreenRecorder.QUEUE_DIR).exists())
        assertFalse(Robo.app.getSharedPreferences(RetiredScreenRecorder.PREFERENCES, 0).contains("enabled"))
        // The periodic health sync is untouched.
        assertEquals(WorkInfo.State.ENQUEUED, uniqueWork("infovore-health-periodic-sync").single().state)
    }

    @Test
    fun withoutATokenTheWorkerDoesNothing() = runBlocking {
        assertEquals(Result.success(), syncWorker().doWork())
        assertEquals(0, Robo.settings().backgroundFailures)
        assertEquals("尚未同步", Robo.settings().lastStatus)
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
    fun aFailureOnlyTheUserCanFixIsNotRetriedAndCountsTowardTheWarning() = runBlocking {
        Robo.saveConnection()
        Robo.grantNotificationPermission()
        Robo.settings().notifyOnSyncFailure = true

        // Missing Health Connect permissions: retrying cannot help, so the run ends at once and
        // counts (transient failures and their retries: BackgroundRetryTest).
        assertEquals(Result.failure(), syncWorker(attempt = 0).doWork())
        assertTrue(Robo.settings().lastSyncFailed)
        assertTrue(Robo.settings().lastStatus.contains("背景同步失敗，需要處理：請先授權 Health Connect"))
        assertEquals(1, Robo.settings().backgroundFailures)
        assertNull(Robo.shadowNotifications.getNotification(SyncFailureNotifier.NOTIFICATION_ID))
        assertEquals(Result.failure(), syncWorker(attempt = 0).doWork())
        assertNull(Robo.shadowNotifications.getNotification(SyncFailureNotifier.NOTIFICATION_ID))
        // The third period in a row posts the warning, with counts only.
        assertEquals(Result.failure(), syncWorker(attempt = 0).doWork())
        assertEquals(SyncFailureAlerts.THRESHOLD, Robo.settings().backgroundFailures)
        val notification = requireNotNull(Robo.shadowNotifications.getNotification(SyncFailureNotifier.NOTIFICATION_ID))
        val text = notification.extras.getCharSequence(android.app.Notification.EXTRA_TEXT).toString()
        assertTrue(text.contains("連續失敗 3 次"))
        // The failure's reason (missing Health Connect permissions) stays in the app.
        assertFalse(text.contains("授權"))
        assertTrue(Robo.settings().syncFailureNotified)
    }
}
