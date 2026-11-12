package tw.skyhong.infovore.health

import java.io.IOException

/** Synthetic fixtures only: invented ids, origins and times; no real health data. */
internal object Fixture {
    val NOW: Long = java.time.Instant.parse("2026-09-10T00:00:00Z").toEpochMilli()
    const val DAY = 86_400_000L
    const val GARMIN = "com.garmin.fixture"
    const val OWN = "tw.skyhong.infovore.health"

    val allPermissions: Set<String> = HealthCatalog.readPermissions

    fun item(id: String, startMs: Long, origin: String = GARMIN) =
        HealthItem(id, startMs, origin, "{\"id\":${JsonText.quote(id)}}")
}

internal class FakeStore : HealthSyncStore {
    override var changesToken: String? = null
    override var historyScan: HistoryScan? = null
    override var historyDays: Int = 7
    override var lastSleepStatus: String = ""
    override var reconcileGapsText: String = ""

    override fun saveHistoryScan(scan: HistoryScan) {
        historyScan = scan
    }

    override fun finishHistoryScan(changesToken: String) {
        this.changesToken = changesToken
        historyScan = null
    }

    override fun resetChangesToken() {
        changesToken = null
        historyScan = null
    }

    /** A new store holding only what SharedPreferences would persist: simulates an app restart. */
    fun reloaded(): FakeStore = FakeStore().also {
        it.changesToken = changesToken
        it.historyScan = historyScan
        it.historyDays = historyDays
        it.lastSleepStatus = lastSleepStatus
        it.reconcileGapsText = reconcileGapsText
    }
}

internal class FakeReader(var granted: Set<String> = Fixture.allPermissions, private val events: MutableList<String>) : HealthReader {
    data class Read(val dataType: String, val startMs: Long, val endMs: Long, val pageToken: String?, val ascending: Boolean)

    /** Pages per data type; page tokens are the next page's index. */
    val pages = mutableMapOf<String, List<List<HealthItem>>>()
    val reads = mutableListOf<Read>()
    var failAt: Pair<String, Int>? = null
    val changes = ArrayDeque<HealthChanges>()
    var changeTokenRequests = 0

    override suspend fun grantedPermissions(): Set<String> = granted

    override suspend fun changesToken(): String {
        changeTokenRequests++
        events += "changesToken"
        return "fixture-token-$changeTokenRequests"
    }

    override suspend fun changes(token: String): HealthChanges {
        events += "changes:$token"
        return changes.removeFirstOrNull() ?: HealthChanges(emptyList(), emptyList(), "$token+", hasMore = false, tokenExpired = false)
    }

    override suspend fun readPage(dataType: String, startMs: Long, endMs: Long, pageToken: String?, ascending: Boolean): HealthPage {
        val index = pageToken?.toInt() ?: 0
        events += "read:$dataType:$index"
        reads += Read(dataType, startMs, endMs, pageToken, ascending)
        if (failAt == dataType to index) throw IOException("fixture: Health Connect read failed")
        val list = pages[dataType].orEmpty()
        val next = if (index + 1 < list.size) (index + 1).toString() else null
        return HealthPage(list.getOrElse(index) { emptyList() }, next)
    }
}

internal class FakeUploader(private val events: MutableList<String>) : HealthUploader {
    val windows = mutableListOf<ReconcileWindow>()
    val uploadedIds = mutableListOf<String>()
    val deletedIds = mutableListOf<String>()

    /** Answers each reconcile window; by default the server confirms it and deletes nothing. */
    var onReconcile: (ReconcileWindow) -> InfovoreApi.UploadResult = { InfovoreApi.UploadResult(0, 0, 0, reconciled = true) }

    override fun upload(
        records: List<HealthItem>,
        deletedRecordIds: List<String>,
        reconcile: ReconcileWindow?,
        onRetry: (attempt: Int, message: String) -> Unit,
    ): InfovoreApi.UploadResult {
        if (reconcile != null) {
            require(records.isEmpty() && deletedRecordIds.isEmpty()) { "reconcile windows are sent on their own" }
            events += "reconcile:${reconcile.dataType}"
            val result = onReconcile(reconcile)
            windows += reconcile
            return result
        }
        events += "upload:${records.size}:${deletedRecordIds.size}"
        uploadedIds += records.map { it.id }
        deletedIds += deletedRecordIds
        return InfovoreApi.UploadResult(records.size, 0, deletedRecordIds.size)
    }

    fun windowsFor(dataType: String) = windows.filter { it.dataType == dataType }
}

internal class Harness(
    granted: Set<String> = Fixture.allPermissions,
    val store: FakeStore = FakeStore(),
    var nowMs: Long = Fixture.NOW,
    private val targetIds: Int = ReconcilePlanner.TARGET_IDS,
) {
    val events = mutableListOf<String>()
    val reader = FakeReader(granted, events)
    val uploader = FakeUploader(events)

    fun engine(store: HealthSyncStore = this.store) = HealthSyncEngine(
        reader = reader,
        uploader = uploader,
        store = store,
        ownPackage = Fixture.OWN,
        destination = DESTINATION,
        credentialsReady = true,
        clock = { nowMs },
        reconcileTargetIds = targetIds,
    )

    val gaps: List<ReconcileGap> get() = ReconcileGaps.decode(store.reconcileGapsText)

    companion object {
        const val DESTINATION = "https://infovore.example"
    }
}
