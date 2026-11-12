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
import kotlin.reflect.KClass

/**
 * Wires [HealthSyncEngine] to Health Connect ([HealthConnectReader]), the ingest endpoint
 * ([InfovoreApi]) and [SecureSettings]. Destination and credentials are read once per instance:
 * every request of this run goes to the same server with the same token, even if the settings
 * change while it runs.
 */
class HealthConnectSync(context: Context) {
    private val settings = SecureSettings(context)
    private val endpoint = settings.endpoint
    private val authToken = settings.token
    private val deviceId = settings.deviceId
    private val api = InfovoreApi(
        endpoint,
        timing = SyncEnvironment.apiTiming(),
        clock = { Instant.ofEpochMilli(SyncEnvironment.nowMs()) },
        newSyncId = SyncEnvironment::newSyncId,
    )

    private val engine = HealthSyncEngine(
        reader = HealthConnectReader(context),
        uploader = { records, deleted, reconcile, onRetry ->
            api.upload(authToken, deviceId, records.map { it.json }, deleted, reconcile, onRetry)
        },
        store = settings,
        ownPackage = context.packageName,
        destination = DestinationChange.normalize(endpoint),
        credentialsReady = endpoint.isNotBlank() && authToken.length >= 32,
        clock = SyncEnvironment::nowMs,
    )

    suspend fun runSleep(onProgress: (String) -> Unit = {}): SyncSummary = engine.runSleep(onProgress)

    suspend fun run(onProgress: (String) -> Unit = {}): SyncSummary = engine.run(onProgress)

    /** Re-sends the reconcile windows of every saved [ReconcileGap]; see [HealthSyncEngine.reverify]. */
    suspend fun reverify(onProgress: (String) -> Unit = {}): SyncSummary = engine.reverify(onProgress)

    /** See [HealthSyncEngine.confirmDelete]. */
    suspend fun confirmDelete(dataType: String, expected: Int, onProgress: (String) -> Unit = {}) =
        engine.confirmDelete(dataType, expected, onProgress)

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

typealias SyncSummary = HealthSyncEngine.SyncSummary

/**
 * [HealthReader] backed by [HealthConnectClient]; the request parameters are the app's sync policy.
 * Unit tests pass a FakeHealthConnectClient (androidx.health.connect:connect-testing).
 */
class HealthConnectReader(private val client: HealthConnectClient) : HealthReader {
    constructor(context: Context) : this(HealthConnectAccess.client(context))

    override suspend fun grantedPermissions(): Set<String> = client.permissionController.getGrantedPermissions()

    override suspend fun changesToken(): String = client.getChangesToken(ChangesTokenRequest(HealthConnectSync.recordTypes))

    override suspend fun changes(token: String): HealthChanges {
        val response = client.getChanges(token)
        if (response.changesTokenExpired) {
            return HealthChanges(emptyList(), emptyList(), nextToken = token, hasMore = false, tokenExpired = true)
        }
        return HealthChanges(
            upserts = response.changes.filterIsInstance<UpsertionChange>().map { item(it.record) },
            deletedIds = response.changes.filterIsInstance<DeletionChange>().map { it.recordId },
            nextToken = response.nextChangesToken,
            hasMore = response.hasMore,
            tokenExpired = false,
        )
    }

    override suspend fun readPage(dataType: String, startMs: Long, endMs: Long, pageToken: String?, ascending: Boolean): HealthPage {
        val response = client.readRecords(
            ReadRecordsRequest(
                recordType = @Suppress("UNCHECKED_CAST") (recordClass(dataType) as KClass<Record>),
                timeRangeFilter = TimeRangeFilter.between(Instant.ofEpochMilli(startMs), Instant.ofEpochMilli(endMs)),
                pageSize = PAGE_SIZE,
                pageToken = pageToken,
                ascendingOrder = ascending,
            ),
        )
        return HealthPage(response.records.map(::item), response.pageToken?.takeIf(String::isNotEmpty))
    }

    private fun item(record: Record) = HealthItem(
        id = record.metadata.id,
        startMs = HealthRecordJson.startOf(record).toEpochMilli(),
        originPackage = record.metadata.dataOrigin.packageName,
        json = HealthRecordJson.encode(record).toString(),
        endMs = HealthRecordJson.endOf(record).toEpochMilli(),
    )

    private fun recordClass(dataType: String): KClass<out Record> =
        HealthConnectSync.recordTypes.firstOrNull { HealthRecordJson.typeName(it) == dataType }
            ?: error("Unsupported data type: $dataType")

    internal companion object {
        const val PAGE_SIZE = 500
    }
}
