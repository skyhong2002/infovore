package tw.skyhong.infovore.health

/**
 * The narrow seams between the sync logic ([HealthSyncEngine]) and the outside world, so the
 * logic can be tested on the JVM without Health Connect, Android or a server. The real
 * implementations are [HealthConnectReader] and the [InfovoreApi]-backed uploader built in
 * [HealthConnectSync].
 */

/** One Health Connect record as the sync needs it: its id, start (the server's start_at), origin and encoded JSON. */
data class HealthItem(
    val id: String,
    val startMs: Long,
    val originPackage: String,
    /** The record exactly as uploaded (see [HealthRecordJson.encode]). */
    val json: String,
)

/** One page of a time-range read; [nextPageToken] is null after the last page. */
data class HealthPage(val items: List<HealthItem>, val nextPageToken: String?)

/** One page of Health Connect changes since a change token. */
data class HealthChanges(
    val upserts: List<HealthItem>,
    val deletedIds: List<String>,
    val nextToken: String,
    val hasMore: Boolean,
    val tokenExpired: Boolean,
)

/** Read access to Health Connect. Parameters match what [HealthConnectReader] passes to the client. */
interface HealthReader {
    suspend fun grantedPermissions(): Set<String>

    /** A change token covering every synced record type. */
    suspend fun changesToken(): String

    suspend fun changes(token: String): HealthChanges

    /** Reads one page of [dataType] records in [startMs, endMs), sorted by start time. */
    suspend fun readPage(dataType: String, startMs: Long, endMs: Long, pageToken: String?, ascending: Boolean): HealthPage
}

/** Sends one batch to the ingest endpoint; throws [java.io.IOException] or [InfovoreApi.HttpStatusException]. */
fun interface HealthUploader {
    fun upload(
        records: List<HealthItem>,
        deletedRecordIds: List<String>,
        reconcile: ReconcileWindow?,
        onRetry: (attempt: Int, message: String) -> Unit,
    ): InfovoreApi.UploadResult
}

/** The persisted sync state the engine reads and writes; [SecureSettings] in the app. */
interface HealthSyncStore {
    var changesToken: String?
    val historyScan: HistoryScan?
    fun saveHistoryScan(scan: HistoryScan)
    fun finishHistoryScan(changesToken: String)
    fun resetChangesToken()
    val historyDays: Int
    var lastSleepStatus: String

    /** Encoded [ReconcileGap]s (see [ReconcileGaps.encode]); empty when every window was verified. */
    var reconcileGapsText: String
}

/** The synced Health Connect data types, keyed by the server's dataType. */
object HealthCatalog {
    data class Type(val key: String, val label: String, val readPermission: String)

    private const val PREFIX = "android.permission.health."

    val SLEEP = Type("sleep_session", "睡眠", PREFIX + "READ_SLEEP")

    /** History scan order after sleep: exercise and steps first, then the remaining types. */
    val historyOrder: List<Type> = listOf(
        Type("exercise_session", "運動", PREFIX + "READ_EXERCISE"),
        Type("steps", "步數", PREFIX + "READ_STEPS"),
        Type("distance", "距離", PREFIX + "READ_DISTANCE"),
        Type("total_calories_burned", "卡路里", PREFIX + "READ_TOTAL_CALORIES_BURNED"),
        Type("heart_rate", "心率", PREFIX + "READ_HEART_RATE"),
        Type("weight", "體重", PREFIX + "READ_WEIGHT"),
        Type("body_fat", "體脂", PREFIX + "READ_BODY_FAT"),
    )

    val all: List<Type> = listOf(SLEEP) + historyOrder

    val readPermissions: Set<String> = all.map { it.readPermission }.toSet()

    const val HISTORY_PERMISSION = PREFIX + "READ_HEALTH_DATA_HISTORY"

    fun type(key: String): Type? = all.firstOrNull { it.key == key }

    fun label(key: String): String = type(key)?.label ?: key
}
