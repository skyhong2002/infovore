package tw.skyhong.infovore.health.screen

import android.content.Context
import androidx.work.BackoffPolicy
import androidx.work.Constraints
import androidx.work.CoroutineWorker
import androidx.work.ExistingPeriodicWorkPolicy
import androidx.work.NetworkType
import androidx.work.PeriodicWorkRequestBuilder
import androidx.work.WorkManager
import androidx.work.WorkerParameters
import tw.skyhong.infovore.health.BackgroundRetry
import java.util.concurrent.TimeUnit

/**
 * Fallback uploader for queued observations when the accessibility service is not running.
 * Failures are recorded in [ScreenSettings.lastUploadStatus]. One that needs the user (token,
 * destination, quarantine, a refused request) ends the run (`Result.failure()`); a transient one
 * retries within WorkManager's backoff when that is at least the server's `Retry-After`, and
 * otherwise waits: [ScreenUploader.uploadPending] keeps automatic runs from contacting the server
 * before the time it asked for, and the next periodic run after that tries again.
 */
class ScreenUploadWorker(context: Context, parameters: WorkerParameters) : CoroutineWorker(context, parameters) {
    override suspend fun doWork(): Result {
        if (ScreenSettings(applicationContext).token.length < 32) return Result.success()
        val destination = ScreenUploader.currentDestination(applicationContext)
        if (ObservationQueue.get(applicationContext).count(destination) == 0) return Result.success()
        val outcome = ScreenUploader.uploadPending(applicationContext, automatic = true)
        // Nothing sent: the server's Retry-After has not passed yet.
        if (outcome.deferredUntilMs != null || outcome.error == null) return Result.success()
        val plan = BackgroundRetry.plan(
            kind = if (outcome.needsAction) BackgroundRetry.Kind.NEEDS_ACTION else BackgroundRetry.Kind.TRANSIENT,
            retryAfterMs = outcome.retryAfterMs,
            attempt = runAttemptCount,
            runAttemptCount = runAttemptCount,
            // The wait itself is ScreenSettings.retryNotBefore; the 15-minute period resumes after it.
            canScheduleLater = true,
        )
        return if (plan == BackgroundRetry.Plan.Backoff) Result.retry() else Result.failure()
    }

    companion object {
        private const val WORK_NAME = "infovore-dayflow-phone-upload"

        fun schedule(context: Context) {
            val request = PeriodicWorkRequestBuilder<ScreenUploadWorker>(15, TimeUnit.MINUTES)
                .setConstraints(Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build())
                .setBackoffCriteria(BackoffPolicy.EXPONENTIAL, BackgroundRetry.BACKOFF_MS, TimeUnit.MILLISECONDS)
                .build()
            WorkManager.getInstance(context).enqueueUniquePeriodicWork(
                WORK_NAME,
                ExistingPeriodicWorkPolicy.KEEP,
                request,
            )
        }
    }
}
