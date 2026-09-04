package tw.skyhong.infovore.health

import android.content.Context
import androidx.work.CoroutineWorker
import androidx.work.WorkerParameters
import java.time.Instant

class SyncWorker(context: Context, parameters: WorkerParameters) : CoroutineWorker(context, parameters) {
    override suspend fun doWork(): Result {
        val settings = SecureSettings(applicationContext)
        if (settings.token.length < 32) return Result.success()
        return try {
            val result = HealthConnectSync(applicationContext).run { settings.lastStatus = it }
            settings.lastStatus = "${Instant.now()}：新增 ${result.inserted}、更新 ${result.updated}、刪除 ${result.deleted}"
            Result.success()
        } catch (error: Exception) {
            settings.lastStatus = "${Instant.now()}：${error.message ?: error.javaClass.simpleName}"
            if (runAttemptCount < 4) Result.retry() else Result.failure()
        }
    }
}
