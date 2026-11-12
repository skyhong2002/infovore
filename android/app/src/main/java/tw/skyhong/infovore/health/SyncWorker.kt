package tw.skyhong.infovore.health

import android.content.Context
import androidx.work.CoroutineWorker
import androidx.work.WorkerParameters
import kotlinx.coroutines.CancellationException
import tw.skyhong.infovore.health.ui.ErrorText
import java.time.Instant

class SyncWorker(context: Context, parameters: WorkerParameters) : CoroutineWorker(context, parameters) {
    override suspend fun doWork(): Result {
        val settings = SecureSettings(applicationContext)
        if (settings.token.length < 32) return Result.success()
        // Never run alongside a manual sync: if one holds the lock, let WorkManager retry later.
        return SyncRunner.coordinator.runBackground { syncOnce(settings) } ?: Result.retry()
    }

    private suspend fun syncOnce(settings: SecureSettings): Result = try {
        val result = HealthConnectSync(applicationContext).run { settings.lastStatus = it }
        settings.lastStatus = "${Instant.now()}：背景同步完成，新增 ${result.inserted}、更新 ${result.updated}、刪除 ${result.deleted}${ReconcileText.note(result.unverified)}"
        settings.lastSyncFailed = false
        settings.initialImportDone = true
        SyncRunner.coordinator.clearFailure(SyncKind.FULL)
        SyncFailureNotifier.record(applicationContext, settings, SyncFailureAlerts.Outcome.SUCCESS)
        Result.success()
    } catch (cancelled: CancellationException) {
        throw cancelled
    } catch (error: Exception) {
        settings.lastStatus = "${Instant.now()}：背景同步失敗：${ErrorText.describe(error)}"
        settings.lastSyncFailed = true
        // Network and HTTP 5xx/503 failures are retried here and again next period; only a run
        // WorkManager gives up on counts towards the "同步問題" notification.
        val final = SyncFailureAlerts.isFinalAttempt(runAttemptCount)
        SyncFailureNotifier.record(
            applicationContext,
            settings,
            if (final) SyncFailureAlerts.Outcome.FINAL_FAILURE else SyncFailureAlerts.Outcome.RETRY,
        )
        if (final) Result.failure() else Result.retry()
    }
}
