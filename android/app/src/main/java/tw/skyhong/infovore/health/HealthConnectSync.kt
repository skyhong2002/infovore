package tw.skyhong.infovore.health

import android.content.Context
import androidx.health.connect.client.HealthConnectClient
import androidx.health.connect.client.PermissionController
import androidx.health.connect.client.changes.DeletionChange
import androidx.health.connect.client.changes.UpsertionChange
import androidx.health.connect.client.permission.HealthPermission
import androidx.health.connect.client.records.BodyFatRecord
import androidx.health.connect.client.records.DistanceRecord
import androidx.health.connect.client.records.ExerciseSessionRecord
import androidx.health.connect.client.records.HeartRateRecord
import androidx.health.connect.client.records.Record
import androidx.health.connect.client.records.SleepSessionRecord
import androidx.health.connect.client.records.StepsRecord
import androidx.health.connect.client.records.TotalCaloriesBurnedRecord
import androidx.health.connect.client.records.WeightRecord
import androidx.health.connect.client.request.ChangesTokenRequest
import androidx.health.connect.client.request.ReadRecordsRequest
import androidx.health.connect.client.time.TimeRangeFilter
import java.time.Instant
import java.time.temporal.ChronoUnit
import kotlin.reflect.KClass

class HealthConnectSync(private val context: Context) {
    private val settings = SecureSettings(context)
    private val client = HealthConnectClient.getOrCreate(context)
    private val api = InfovoreApi(settings)

    suspend fun run(onProgress: (String) -> Unit = {}): SyncSummary {
        onProgress("檢查連線設定與 Health Connect 權限…")
        require(settings.endpoint.isNotBlank() && settings.token.length >= 32) {
            "請先儲存 Infovore endpoint 與 HEALTH_CONNECT_TOKEN"
        }
        val granted = client.permissionController.getGrantedPermissions()
        val missing = readPermissions - granted
        require(missing.isEmpty()) { "請先授權 Health Connect（尚缺 ${missing.size} 項權限）" }

        var summary = SyncSummary()
        var token = settings.changesToken
        if (token == null) {
            // Capture the token before the historical scan so changes made while
            // the scan runs are included in the following incremental pass.
            onProgress("建立增量同步游標…")
            token = client.getChangesToken(ChangesTokenRequest(recordTypes))
            val historyDays = if (HealthPermission.PERMISSION_READ_HEALTH_DATA_HISTORY in granted) 3650L else 30L
            val start = Instant.now().minus(historyDays, ChronoUnit.DAYS)
            val end = Instant.now()
            summary += uploadHistoryType<ExerciseSessionRecord>("運動", start, end, onProgress)
            summary += uploadHistoryType<StepsRecord>("步數", start, end, onProgress)
            summary += uploadHistoryType<DistanceRecord>("距離", start, end, onProgress)
            summary += uploadHistoryType<TotalCaloriesBurnedRecord>("卡路里", start, end, onProgress)
            summary += uploadHistoryType<HeartRateRecord>("心率", start, end, onProgress)
            summary += uploadHistoryType<SleepSessionRecord>("睡眠", start, end, onProgress)
            summary += uploadHistoryType<WeightRecord>("體重", start, end, onProgress)
            summary += uploadHistoryType<BodyFatRecord>("體脂", start, end, onProgress)
            settings.changesToken = token
        }

        var currentToken = requireNotNull(token)
        do {
            onProgress("檢查初始掃描期間的新變更…")
            val response = client.getChanges(currentToken)
            if (response.changesTokenExpired) {
                settings.changesToken = null
                onProgress("增量游標已過期，重新掃描歷史資料…")
                return run(onProgress)
            }
            val records = response.changes.filterIsInstance<UpsertionChange>()
                .map { it.record }
                .filter { it.metadata.dataOrigin.packageName != context.packageName }
            val deletedIds = response.changes.filterIsInstance<DeletionChange>().map { it.recordId }
            for (chunk in records.chunked(50)) {
                upload(chunk, emptyList(), onProgress).also {
                    summary += SyncSummary(inserted = it.inserted, updated = it.updated)
                }
                onProgress("上傳增量資料：${records.size} 筆；刪除 ${deletedIds.size} 筆…")
            }
            for (chunk in deletedIds.chunked(250)) {
                upload(emptyList(), chunk, onProgress).also { summary += SyncSummary(deleted = it.deleted) }
            }
            currentToken = response.nextChangesToken
            settings.changesToken = currentToken
        } while (response.hasMore)

        onProgress("同步完成：新增 ${summary.inserted}、更新 ${summary.updated}、刪除 ${summary.deleted}")
        return summary
    }

    private suspend inline fun <reified T : Record> uploadHistoryType(
        label: String,
        start: Instant,
        end: Instant,
        noinline onProgress: (String) -> Unit,
    ): SyncSummary {
        var summary = SyncSummary()
        var processed = 0
        var pageToken: String? = null
        onProgress("讀取${label}資料…")
        do {
            val response = client.readRecords(
                ReadRecordsRequest(
                    recordType = T::class,
                    timeRangeFilter = TimeRangeFilter.between(start, end),
                    pageSize = 500,
                    pageToken = pageToken,
                )
            )
            for (chunk in response.records.chunked(50)) {
                upload(chunk, emptyList(), onProgress).also {
                    summary += SyncSummary(inserted = it.inserted, updated = it.updated)
                }
            }
            processed += response.records.size
            onProgress("${label}：已處理 $processed 筆")
            pageToken = response.pageToken?.takeIf(String::isNotEmpty)
        } while (pageToken != null)
        return summary
    }

    private fun upload(
        records: List<Record>,
        deletedRecordIds: List<String>,
        onProgress: (String) -> Unit,
    ) = api.upload(records, deletedRecordIds) { attempt, message ->
        onProgress("連線中斷，正在進行第 $attempt 次上傳：$message")
    }

    data class SyncSummary(
        val inserted: Int = 0,
        val updated: Int = 0,
        val deleted: Int = 0,
    ) {
        operator fun plus(other: SyncSummary) = SyncSummary(
            inserted = inserted + other.inserted,
            updated = updated + other.updated,
            deleted = deleted + other.deleted,
        )
    }

    companion object {
        val recordTypes: Set<KClass<out Record>> = setOf(
            ExerciseSessionRecord::class,
            StepsRecord::class,
            DistanceRecord::class,
            TotalCaloriesBurnedRecord::class,
            HeartRateRecord::class,
            SleepSessionRecord::class,
            WeightRecord::class,
            BodyFatRecord::class,
        )
        val readPermissions: Set<String> = recordTypes.map(HealthPermission::getReadPermission).toSet()

        fun permissionContract() = PermissionController.createRequestPermissionResultContract()
    }
}
