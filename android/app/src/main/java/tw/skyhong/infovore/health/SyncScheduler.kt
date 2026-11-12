package tw.skyhong.infovore.health

import android.content.Context
import androidx.work.BackoffPolicy
import androidx.work.Constraints
import androidx.work.ExistingPeriodicWorkPolicy
import androidx.work.ExistingWorkPolicy
import androidx.work.NetworkType
import androidx.work.OneTimeWorkRequestBuilder
import androidx.work.PeriodicWorkRequestBuilder
import androidx.work.WorkManager
import androidx.work.workDataOf
import java.util.concurrent.TimeUnit

object SyncScheduler {
    private const val WORK_NAME = "infovore-health-periodic-sync"

    /** The one-off run a background sync schedules for when the server's `Retry-After` asks. */
    const val RETRY_WORK_NAME = "infovore-health-retry-after"

    private fun network() = Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build()

    fun schedule(context: Context) {
        val request = PeriodicWorkRequestBuilder<SyncWorker>(SyncFailureAlerts.PERIOD_HOURS.toLong(), TimeUnit.HOURS)
            .setConstraints(network())
            // WorkManager's default, stated because BackgroundRetry.plan relies on it.
            .setBackoffCriteria(BackoffPolicy.EXPONENTIAL, BackgroundRetry.BACKOFF_MS, TimeUnit.MILLISECONDS)
            .build()
        WorkManager.getInstance(context).enqueueUniquePeriodicWork(
            WORK_NAME,
            ExistingPeriodicWorkPolicy.KEEP,
            request,
        )
    }

    /**
     * Runs one more background sync after [delayMs], as attempt [attempt] of this period. It
     * replaces a follow-up still waiting from before; it is never scheduled by a follow-up itself
     * (that one retries within WorkManager's backoff or waits for the next period), so it cannot
     * replace the work that is running.
     */
    fun scheduleRetry(context: Context, delayMs: Long, attempt: Int) {
        val request = OneTimeWorkRequestBuilder<SyncWorker>()
            .setInitialDelay(delayMs, TimeUnit.MILLISECONDS)
            .setConstraints(network())
            .setBackoffCriteria(BackoffPolicy.EXPONENTIAL, BackgroundRetry.BACKOFF_MS, TimeUnit.MILLISECONDS)
            .setInputData(workDataOf(SyncWorker.KEY_ATTEMPT to attempt, SyncWorker.KEY_FOLLOW_UP to true))
            .build()
        WorkManager.getInstance(context).enqueueUniqueWork(RETRY_WORK_NAME, ExistingWorkPolicy.REPLACE, request)
    }

    /** After a successful full sync: a scheduled follow-up has nothing left to do. */
    fun cancelRetry(context: Context) {
        WorkManager.getInstance(context).cancelUniqueWork(RETRY_WORK_NAME)
    }
}
