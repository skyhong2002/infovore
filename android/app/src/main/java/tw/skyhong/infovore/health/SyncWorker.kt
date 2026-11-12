package tw.skyhong.infovore.health

import android.content.Context
import androidx.work.CoroutineWorker
import androidx.work.WorkerParameters
import kotlinx.coroutines.CancellationException
import tw.skyhong.infovore.health.BackgroundRetry.Plan
import tw.skyhong.infovore.health.ui.ErrorText
import java.time.Instant

/**
 * The background full sync: the six-hourly periodic work, and the one-off follow-up it schedules
 * when the server asks for a longer wait ([SyncScheduler.scheduleRetry]). How a failure ends the
 * run is [BackgroundRetry]'s decision: errors only the user can fix stop at once
 * (`Result.failure()`), transient ones retry within WorkManager's backoff or at the server's
 * `Retry-After`. The reason is saved in [SecureSettings.lastStatus] for the screen.
 */
class SyncWorker(context: Context, parameters: WorkerParameters) : CoroutineWorker(context, parameters) {
    private val followUp: Boolean get() = inputData.getBoolean(KEY_FOLLOW_UP, false)

    /** Failed attempts before this one in this period, the follow-up's predecessors included. */
    private val attempt: Int get() = inputData.getInt(KEY_ATTEMPT, 0) + runAttemptCount

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
        settings.lastSuccessfulSyncMs = System.currentTimeMillis()
        settings.initialImportDone = true
        SyncRunner.coordinator.clearFailure(SyncKind.FULL)
        SyncFailureNotifier.record(applicationContext, settings, SyncFailureAlerts.Outcome.SUCCESS)
        // A follow-up still waiting is not needed any more (one never cancels itself).
        if (!followUp) SyncScheduler.cancelRetry(applicationContext)
        Result.success()
    } catch (cancelled: CancellationException) {
        throw cancelled
    } catch (error: Exception) {
        val plan = BackgroundRetry.plan(
            kind = BackgroundRetry.classify(error),
            retryAfterMs = BackgroundRetry.retryAfterMs(error),
            attempt = attempt,
            runAttemptCount = runAttemptCount,
            canScheduleLater = !followUp,
        )
        settings.lastStatus = "${Instant.now()}：${BackgroundRetry.syncStatus(plan, ErrorText.describe(error))}"
        settings.lastSyncFailed = true
        // Only a run that gives up for this period counts towards the "同步問題" notification.
        SyncFailureNotifier.record(
            applicationContext,
            settings,
            if (BackgroundRetry.countsAsFinal(plan)) SyncFailureAlerts.Outcome.FINAL_FAILURE else SyncFailureAlerts.Outcome.RETRY,
        )
        when (plan) {
            Plan.Backoff -> Result.retry()
            is Plan.Later -> {
                SyncScheduler.scheduleRetry(applicationContext, plan.delayMs, attempt + 1)
                Result.failure()
            }
            Plan.NeedsAction, Plan.GiveUp -> Result.failure()
        }
    }

    companion object {
        const val KEY_ATTEMPT = "attempt"
        const val KEY_FOLLOW_UP = "followUp"
    }
}
