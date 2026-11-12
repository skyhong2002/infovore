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

    // Destination and credentials are read once per run: every request of this run goes to the
    // same server with the same token, even if the settings change while it runs.
    private val endpoint = settings.endpoint
    private val authToken = settings.token
    private val deviceId = settings.deviceId
    private val api = InfovoreApi(endpoint)

    // Independent of the all-types change token: works after upgrades and
    // when a large historical step import has never finished.
    // [reconcile]: the read is part of a history rescan, so also re-verify deletions (see ReconcilePlanner).
    suspend fun runSleep(onProgress: (String) -> Unit = {}, reconcile: Boolean = false): SyncSummary {
        settings.lastSleepStatus = "正在讀取睡眠…"
        onProgress(settings.lastSleepStatus)
        try {
            require(endpoint.isNotBlank() && authToken.length >= 32) {
                "請先儲存 endpoint 與 token"
            }
            val granted = client.permissionController.getGrantedPermissions()
            require(HealthPermission.getReadPermission(SleepSessionRecord::class) in granted) {
                "尚未授權讀取睡眠，請按「授權 Health Connect」"
            }
            val days = historyDays(granted)
            val end = Instant.now().truncatedTo(ChronoUnit.MILLIS)
            val result = uploadHistoryType(
                SleepSessionRecord::class, "睡眠", end.minus(days, ChronoUnit.DAYS), end, { progress ->
                    settings.lastSleepStatus = progress
                    onProgress(progress)
                }, newestFirst = true, reconcile = reconcile,
            )
            val count = result.inserted + result.updated
            settings.lastSleepStatus = if (count == 0) {
                "${Instant.now()}：睡眠 0 筆（查詢 $days 天）。請確認 Health Connect 內有睡眠紀錄、Garmin 已獲准寫入睡眠，並完成手錶同步。"
            } else {
                "${Instant.now()}：睡眠已上傳 $count 筆（新增 ${result.inserted}、更新 ${result.updated}）"
            }
            onProgress(settings.lastSleepStatus)
            return result
        } catch (error: Exception) {
            settings.lastSleepStatus = "${Instant.now()}：睡眠未完成：${error.message ?: error.javaClass.simpleName}"
            onProgress(settings.lastSleepStatus)
            throw error
        }
    }

    suspend fun run(onProgress: (String) -> Unit = {}): SyncSummary {
        onProgress("檢查連線設定與 Health Connect 權限…")
        require(endpoint.isNotBlank() && authToken.length >= 32) {
            "請先儲存 Infovore endpoint 與 HEALTH_CONNECT_TOKEN"
        }
        val granted = client.permissionController.getGrantedPermissions()
        val missing = readPermissions - granted
        require(missing.isEmpty()) { "請先授權 Health Connect（尚缺 ${missing.size} 項權限）" }

        var token = settings.changesToken
        var scan: HistoryScan? = null
        var resumed = false
        if (token == null) {
            val destination = DestinationChange.normalize(endpoint)
            scan = HistoryScan.resumable(settings.historyScan, destination)
            if (scan != null) {
                resumed = true
            } else {
                // Capture the token before the historical scan so changes made while
                // the scan runs are included in the following incremental pass.
                onProgress("建立增量同步游標…")
                val captured = client.getChangesToken(ChangesTokenRequest(recordTypes))
                val end = Instant.now().truncatedTo(ChronoUnit.MILLIS)
                scan = HistoryScan(
                    changesToken = captured,
                    startMs = end.minus(historyDays(granted), ChronoUnit.DAYS).toEpochMilli(),
                    endMs = end.toEpochMilli(),
                    destination = destination,
                )
                settings.saveHistoryScan(scan)
            }
            token = scan.changesToken
        }
        // Refresh sleep on every run, even with an existing change token.
        var summary = runSleep(onProgress, reconcile = scan != null)
        if (scan != null) {
            var progress: HistoryScan = scan
            val start = Instant.ofEpochMilli(progress.startMs)
            val end = Instant.ofEpochMilli(progress.endMs)
            val remaining = progress.remaining(historyOrder.map { it.key })
            onProgress(
                if (resumed) {
                    "繼續上次中斷的初始掃描（剩 ${remaining.size} / ${historyOrder.size} 類）…"
                } else {
                    "初始掃描最近 ${ChronoUnit.DAYS.between(start, end)} 天…"
                },
            )
            val canReconcile = HistoryScan.canReconcile(
                resumed,
                historyPermission = HealthPermission.PERMISSION_READ_HEALTH_DATA_HISTORY in granted,
                startMs = progress.startMs,
                nowMs = System.currentTimeMillis(),
            )
            // Sleep has already been uploaded before the larger histories.
            for (type in historyOrder) {
                if (type.key !in remaining) continue
                summary += uploadHistoryType(type.recordType, type.label, start, end, onProgress, reconcile = canReconcile)
                if (!canReconcile) summary += SyncSummary(unverified = listOf("${type.label}（${ReconcileText.PERMISSION_WINDOW}）"))
                progress = progress.withCompleted(type.key)
                settings.saveHistoryScan(progress)
            }
            settings.finishHistoryScan(progress.changesToken)
        }

        var currentToken = requireNotNull(token)
        do {
            onProgress("檢查初始掃描期間的新變更…")
            val response = client.getChanges(currentToken)
            if (response.changesTokenExpired) {
                settings.resetChangesToken()
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

        onProgress("同步完成：新增 ${summary.inserted}、更新 ${summary.updated}、刪除 ${summary.deleted}${ReconcileText.note(summary.unverified)}")
        return summary
    }

    // The configured window is capped by what Health Connect lets us read:
    // 30 days unless the history permission was granted.
    private fun historyDays(granted: Set<String>): Long {
        val allowed = if (HealthPermission.PERMISSION_READ_HEALTH_DATA_HISTORY in granted) 3650L else 30L
        return settings.historyDays.toLong().coerceAtMost(allowed)
    }

    /**
     * Reads every [type] record in [start, end) page by page and uploads it. With [reconcile],
     * the pages also feed a [ReconcilePlanner], and each window it completes is sent so the server
     * can drop rows the phone no longer has. Any window the server refuses, or a read that breaks
     * the planner's assumptions, stops reconciling this type and is reported in [SyncSummary.unverified].
     */
    private suspend fun uploadHistoryType(
        type: KClass<out Record>,
        label: String,
        start: Instant,
        end: Instant,
        onProgress: (String) -> Unit,
        newestFirst: Boolean = false,
        reconcile: Boolean = false,
    ): SyncSummary {
        var summary = SyncSummary()
        var processed = 0
        var pageToken: String? = null
        val planner = if (reconcile) {
            ReconcilePlanner(HealthRecordJson.typeName(type), start.toEpochMilli(), end.toEpochMilli(), ascending = !newestFirst)
        } else {
            null
        }
        var unverified: String? = null
        fun sendWindows(windows: List<ReconcileWindow>) {
            for (window in windows) {
                if (unverified != null) return
                val result = try {
                    upload(emptyList(), emptyList(), onProgress, window)
                } catch (refused: InfovoreApi.HttpStatusException) {
                    if (refused.status != 400 && refused.status != 409) throw refused
                    unverified = ReconcileText.serverRejected(refused.status)
                    return
                }
                if (!result.reconciled) {
                    unverified = ReconcileText.NOT_REPORTED
                    return
                }
                summary += SyncSummary(deleted = result.deleted)
            }
        }
        onProgress("讀取${label}資料…")
        do {
            val response = client.readRecords(
                ReadRecordsRequest(
                    recordType = @Suppress("UNCHECKED_CAST") (type as KClass<Record>),
                    timeRangeFilter = TimeRangeFilter.between(start, end),
                    pageSize = 500,
                    pageToken = pageToken,
                    ascendingOrder = !newestFirst,
                )
            )
            for (chunk in response.records.chunked(50)) {
                upload(chunk, emptyList(), onProgress).also {
                    summary += SyncSummary(inserted = it.inserted, updated = it.updated)
                }
            }
            if (planner != null) {
                sendWindows(planner.add(response.records.map {
                    ReconcilePlanner.Item(it.metadata.id, HealthRecordJson.startOf(it).toEpochMilli())
                }))
            }
            processed += response.records.size
            onProgress("${label}：已處理 $processed 筆")
            pageToken = response.pageToken?.takeIf(String::isNotEmpty)
        } while (pageToken != null)
        if (planner != null) {
            if (unverified == null) {
                planner.finish()?.let { sendWindows(listOf(it)) }
            }
            val reason = unverified ?: planner.failure
            if (reason != null) summary += SyncSummary(unverified = listOf("$label（$reason）"))
        }
        return summary
    }

    private fun upload(
        records: List<Record>,
        deletedRecordIds: List<String>,
        onProgress: (String) -> Unit,
        reconcile: ReconcileWindow? = null,
    ) = api.upload(authToken, deviceId, records, deletedRecordIds, reconcile) { attempt, message ->
        onProgress("連線中斷，正在進行第 $attempt 次上傳：$message")
    }

    data class SyncSummary(
        val inserted: Int = 0,
        val updated: Int = 0,
        val deleted: Int = 0,
        /** Rescanned types whose server-side deletions could not be re-verified, with the reason. */
        val unverified: List<String> = emptyList(),
    ) {
        operator fun plus(other: SyncSummary) = SyncSummary(
            inserted = inserted + other.inserted,
            updated = updated + other.updated,
            deleted = deleted + other.deleted,
            unverified = unverified + other.unverified,
        )
    }

    private class HistoryType(val key: String, val label: String, val recordType: KClass<out Record>)

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

        /** History scan order after sleep: exercise and steps first, then the remaining types. */
        private val historyOrder: List<HistoryType> = listOf(
            HistoryType("exercise_session", "運動", ExerciseSessionRecord::class),
            HistoryType("steps", "步數", StepsRecord::class),
            HistoryType("distance", "距離", DistanceRecord::class),
            HistoryType("total_calories_burned", "卡路里", TotalCaloriesBurnedRecord::class),
            HistoryType("heart_rate", "心率", HeartRateRecord::class),
            HistoryType("weight", "體重", WeightRecord::class),
            HistoryType("body_fat", "體脂", BodyFatRecord::class),
        )

        fun permissionContract() = PermissionController.createRequestPermissionResultContract()
    }
}
