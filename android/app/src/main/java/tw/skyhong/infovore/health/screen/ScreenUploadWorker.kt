package tw.skyhong.infovore.health.screen

import android.content.Context
import androidx.work.Constraints
import androidx.work.CoroutineWorker
import androidx.work.ExistingPeriodicWorkPolicy
import androidx.work.NetworkType
import androidx.work.PeriodicWorkRequestBuilder
import androidx.work.WorkManager
import androidx.work.WorkerParameters
import java.util.concurrent.TimeUnit

/** Fallback uploader for queued observations when the accessibility service is not running. */
class ScreenUploadWorker(context: Context, parameters: WorkerParameters) : CoroutineWorker(context, parameters) {
    override suspend fun doWork(): Result {
        if (ScreenSettings(applicationContext).token.length < 32) return Result.success()
        val destination = ScreenUploader.currentDestination(applicationContext)
        if (ObservationQueue.get(applicationContext).count(destination) == 0) return Result.success()
        // Failures are recorded in lastUploadStatus; the next periodic run retries.
        ScreenUploader.uploadPending(applicationContext)
        return Result.success()
    }

    companion object {
        private const val WORK_NAME = "infovore-dayflow-phone-upload"

        fun schedule(context: Context) {
            val request = PeriodicWorkRequestBuilder<ScreenUploadWorker>(15, TimeUnit.MINUTES)
                .setConstraints(Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build())
                .build()
            WorkManager.getInstance(context).enqueueUniquePeriodicWork(
                WORK_NAME,
                ExistingPeriodicWorkPolicy.KEEP,
                request,
            )
        }
    }
}
