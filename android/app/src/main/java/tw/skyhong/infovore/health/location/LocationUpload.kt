package tw.skyhong.infovore.health.location

import android.content.Context
import androidx.work.BackoffPolicy
import androidx.work.Constraints
import androidx.work.CoroutineWorker
import androidx.work.ExistingPeriodicWorkPolicy
import androidx.work.ExistingWorkPolicy
import androidx.work.NetworkType
import androidx.work.OneTimeWorkRequestBuilder
import androidx.work.PeriodicWorkRequestBuilder
import androidx.work.WorkManager
import androidx.work.WorkerParameters
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import tw.skyhong.infovore.health.BackgroundRetry
import tw.skyhong.infovore.health.InfovoreApi
import tw.skyhong.infovore.health.SecureSettings
import tw.skyhong.infovore.health.SyncEnvironment
import tw.skyhong.infovore.health.ui.ErrorText
import java.nio.charset.StandardCharsets
import java.text.NumberFormat
import java.time.Instant

/** Sends location batches to the saved Infovore endpoint with the saved token. */
object LocationUploader {
    const val PATH = "/api/ingest/location/batches"
    private val LOCK = Any()

    fun api(context: Context): Pair<InfovoreApi, SecureSettings> {
        val settings = SecureSettings(context)
        require(settings.token.length >= 32) { "請先在連線設定輸入 HEALTH_CONNECT_TOKEN。" }
        return InfovoreApi(settings.endpoint, SyncEnvironment.apiTiming()) to settings
    }

    /**
     * Sends every queued fix, oldest first, removing each batch once the server stored it. One
     * upload at a time per process, so two callers never send or remove the same lines. Returns
     * how many fixes were sent; throws the first failure (what was sent before it stays sent).
     */
    fun uploadQueued(context: Context): Int = synchronized(LOCK) {
        val queue = LocationQueue(context)
        if (queue.size() == 0) return@synchronized 0
        val (api, settings) = api(context)
        var sent = 0
        while (true) {
            val (fixes, lines) = queue.peek(LocationJson.MAX_POINTS_PER_BATCH)
            if (lines == 0) break
            if (fixes.isNotEmpty()) {
                send(api, settings.token, LocationJson.batch(settings.deviceId, LocationJson.SOURCE_LIVE, points = fixes))
            }
            queue.remove(lines)
            sent += fixes.size
        }
        sent
    }

    fun send(api: InfovoreApi, token: String, body: String) {
        api.postJson(PATH, token, body.toByteArray(StandardCharsets.UTF_8))
    }

    /** Runs [uploadQueued] and records the outcome for the screen. Never throws. */
    fun uploadAndRecord(context: Context): Result<Int> {
        val settings = LocationSettings(context)
        val result = runCatching { uploadQueued(context) }
        result.onSuccess { sent ->
            if (sent > 0 || settings.lastUploadFailed) {
                settings.lastUploadStatus = "${Instant.now()}：已上傳 ${NumberFormat.getIntegerInstance().format(sent)} 個定位點"
            }
            settings.lastUploadFailed = false
        }.onFailure { error ->
            settings.lastUploadStatus = "${Instant.now()}：上傳失敗：${ErrorText.describe(error)}"
            settings.lastUploadFailed = true
        }
        LocationTracking.notifyChanged()
        return result
    }
}

/** Uploads queued fixes: every 15 minutes while recording, and sooner when the queue grows. */
class LocationUploadWorker(context: Context, parameters: WorkerParameters) : CoroutineWorker(context, parameters) {
    override suspend fun doWork(): Result = withContext(Dispatchers.IO) {
        if (LocationQueue(applicationContext).size() == 0) return@withContext Result.success()
        val outcome = LocationUploader.uploadAndRecord(applicationContext)
        val error = outcome.exceptionOrNull() ?: return@withContext Result.success()
        if (error is CancellationException) throw error
        when {
            BackgroundRetry.classify(error) == BackgroundRetry.Kind.NEEDS_ACTION -> Result.failure()
            runAttemptCount >= MAX_ATTEMPTS -> Result.failure() // the queue keeps the fixes for the next run
            else -> Result.retry()
        }
    }

    companion object {
        const val MAX_ATTEMPTS = 3
    }
}

object LocationUploadScheduler {
    const val PERIODIC_WORK = "infovore-location-upload"
    const val NOW_WORK = "infovore-location-upload-now"

    private fun network() = Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build()

    fun schedule(context: Context) {
        val request = PeriodicWorkRequestBuilder<LocationUploadWorker>(15, java.util.concurrent.TimeUnit.MINUTES)
            .setConstraints(network())
            .setBackoffCriteria(BackoffPolicy.EXPONENTIAL, BackgroundRetry.BACKOFF_MS, java.util.concurrent.TimeUnit.MILLISECONDS)
            .build()
        WorkManager.getInstance(context).enqueueUniquePeriodicWork(PERIODIC_WORK, ExistingPeriodicWorkPolicy.KEEP, request)
    }

    fun uploadSoon(context: Context) {
        val request = OneTimeWorkRequestBuilder<LocationUploadWorker>()
            .setConstraints(network())
            .setBackoffCriteria(BackoffPolicy.EXPONENTIAL, BackgroundRetry.BACKOFF_MS, java.util.concurrent.TimeUnit.MILLISECONDS)
            .build()
        WorkManager.getInstance(context).enqueueUniqueWork(NOW_WORK, ExistingWorkPolicy.KEEP, request)
    }

    fun cancelPeriodic(context: Context) {
        WorkManager.getInstance(context).cancelUniqueWork(PERIODIC_WORK)
    }
}
