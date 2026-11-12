package tw.skyhong.infovore.health

import android.content.Context
import androidx.work.CoroutineWorker
import androidx.work.WorkerParameters
import tw.skyhong.infovore.health.ui.ErrorText
import java.time.Instant

class SyncWorker(context: Context, parameters: WorkerParameters) : CoroutineWorker(context, parameters) {
    override suspend fun doWork(): Result {
        val settings = SecureSettings(applicationContext)
        if (settings.token.length < 32) return Result.success()
        return try {
            val result = HealthConnectSync(applicationContext).run { settings.lastStatus = it }
            settings.lastStatus = "${Instant.now()}：背景同步完成，新增 ${result.inserted}、更新 ${result.updated}、刪除 ${result.deleted}"
            settings.lastSyncFailed = false
            Result.success()
        } catch (error: Exception) {
            settings.lastStatus = "${Instant.now()}：背景同步失敗：${ErrorText.describe(error)}"
            settings.lastSyncFailed = true
            if (runAttemptCount < 4) Result.retry() else Result.failure()
        }
    }
}
