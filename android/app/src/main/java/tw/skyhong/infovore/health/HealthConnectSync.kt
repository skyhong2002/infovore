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

    suspend fun run(): SyncSummary {
        require(settings.endpoint.isNotBlank() && settings.token.length >= 32) {
            "請先儲存 Infovore endpoint 與 HEALTH_CONNECT_TOKEN"
        }
        val granted = client.permissionController.getGrantedPermissions()
        val missing = readPermissions - granted
        require(missing.isEmpty()) { "請先授權 Health Connect（尚缺 ${missing.size} 項權限）" }

        var inserted = 0
        var updated = 0
        var deleted = 0
        var token = settings.changesToken
        if (token == null) {
            // Capture the token before the historical scan so changes made while
            // the scan runs are included in the following incremental pass.
            token = client.getChangesToken(ChangesTokenRequest(recordTypes))
            val historyDays = if (HealthPermission.PERMISSION_READ_HEALTH_DATA_HISTORY in granted) 3650L else 30L
            val records = readHistory(Instant.now().minus(historyDays, ChronoUnit.DAYS), Instant.now())
            for (chunk in records.chunked(50)) {
                api.upload(chunk, emptyList()).also {
                    inserted += it.inserted
                    updated += it.updated
                }
            }
            settings.changesToken = token
        }

        var currentToken = requireNotNull(token)
        do {
            val response = client.getChanges(currentToken)
            if (response.changesTokenExpired) {
                settings.changesToken = null
                return run()
            }
            val records = response.changes.filterIsInstance<UpsertionChange>()
                .map { it.record }
                .filter { it.metadata.dataOrigin.packageName != context.packageName }
            val deletedIds = response.changes.filterIsInstance<DeletionChange>().map { it.recordId }
            for (chunk in records.chunked(50)) {
                api.upload(chunk, emptyList()).also {
                    inserted += it.inserted
                    updated += it.updated
                }
            }
            for (chunk in deletedIds.chunked(250)) {
                api.upload(emptyList(), chunk).also { deleted += it.deleted }
            }
            currentToken = response.nextChangesToken
            settings.changesToken = currentToken
        } while (response.hasMore)

        return SyncSummary(inserted, updated, deleted)
    }

    private suspend fun readHistory(start: Instant, end: Instant): List<Record> = buildList {
        addAll(readAll<ExerciseSessionRecord>(start, end))
        addAll(readAll<StepsRecord>(start, end))
        addAll(readAll<DistanceRecord>(start, end))
        addAll(readAll<TotalCaloriesBurnedRecord>(start, end))
        addAll(readAll<HeartRateRecord>(start, end))
        addAll(readAll<SleepSessionRecord>(start, end))
        addAll(readAll<WeightRecord>(start, end))
        addAll(readAll<BodyFatRecord>(start, end))
    }

    private suspend inline fun <reified T : Record> readAll(start: Instant, end: Instant): List<T> {
        val result = mutableListOf<T>()
        var pageToken: String? = null
        do {
            val response = client.readRecords(
                ReadRecordsRequest(
                    recordType = T::class,
                    timeRangeFilter = TimeRangeFilter.between(start, end),
                    pageSize = 1000,
                    pageToken = pageToken,
                )
            )
            result += response.records
            pageToken = response.pageToken?.takeIf(String::isNotEmpty)
        } while (pageToken != null)
        return result
    }

    data class SyncSummary(val inserted: Int, val updated: Int, val deleted: Int)

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
