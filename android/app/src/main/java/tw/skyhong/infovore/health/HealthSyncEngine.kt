package tw.skyhong.infovore.health

import kotlinx.coroutines.CancellationException
import java.time.Instant

/**
 * The Health Connect sync logic, Android-free so it can be tested with fake readers and
 * uploaders. [HealthConnectSync] wires it to Health Connect, [InfovoreApi] and [SecureSettings];
 * the read parameters, sync order and policy are the ones described in android/README.md.
 *
 * [destination] is the normalised endpoint every upload of this run goes to; [credentialsReady]
 * is false when the endpoint or token is missing.
 */
class HealthSyncEngine(
    private val reader: HealthReader,
    private val uploader: HealthUploader,
    private val store: HealthSyncStore,
    private val ownPackage: String,
    private val destination: String,
    private val credentialsReady: Boolean,
    private val clock: () -> Long = System::currentTimeMillis,
    private val reconcileTargetIds: Int = ReconcilePlanner.TARGET_IDS,
) {
    data class SyncSummary(
        val inserted: Int = 0,
        val updated: Int = 0,
        val deleted: Int = 0,
        /** Types whose server-side deletions could not be re-verified, with the reason. */
        val unverified: List<String> = emptyList(),
    ) {
        operator fun plus(other: SyncSummary) = SyncSummary(
            inserted = inserted + other.inserted,
            updated = updated + other.updated,
            deleted = deleted + other.deleted,
            unverified = unverified + other.unverified,
        )
    }

    /** The persisted windows still waiting to be re-verified. */
    val gaps: List<ReconcileGap> get() = ReconcileGaps.decode(store.reconcileGapsText)

    // Independent of the all-types change token: works after upgrades and
    // when a large historical step import has never finished.
    // [reconcile]: the read is part of a history rescan, so also re-verify deletions (see ReconcilePlanner).
    suspend fun runSleep(onProgress: (String) -> Unit = {}, reconcile: Boolean = false): SyncSummary {
        store.lastSleepStatus = "正在讀取睡眠…"
        onProgress(store.lastSleepStatus)
        try {
            require(credentialsReady) { "請先儲存 endpoint 與 token" }
            val granted = reader.grantedPermissions()
            require(HealthCatalog.SLEEP.readPermission in granted) {
                "尚未授權讀取睡眠，請按「授權 Health Connect」"
            }
            val days = historyDays(granted)
            val end = clock()
            val result = uploadHistoryType(
                HealthCatalog.SLEEP, end - days * DAY_MS, end, { progress ->
                    store.lastSleepStatus = progress
                    onProgress(progress)
                }, newestFirst = true, reconcile = reconcile,
            )
            val count = result.inserted + result.updated
            store.lastSleepStatus = if (count == 0) {
                "${now()}：睡眠 0 筆（查詢 $days 天）。請確認 Health Connect 內有睡眠紀錄、Garmin 已獲准寫入睡眠，並完成手錶同步。"
            } else {
                "${now()}：睡眠已上傳 $count 筆（新增 ${result.inserted}、更新 ${result.updated}）"
            }
            onProgress(store.lastSleepStatus)
            return result
        } catch (cancelled: CancellationException) {
            throw cancelled
        } catch (error: Exception) {
            store.lastSleepStatus = "${now()}：睡眠未完成：${error.message ?: error.javaClass.simpleName}"
            onProgress(store.lastSleepStatus)
            throw error
        }
    }

    suspend fun run(onProgress: (String) -> Unit = {}): SyncSummary {
        onProgress("檢查連線設定與 Health Connect 權限…")
        require(credentialsReady) { "請先儲存 Infovore endpoint 與 HEALTH_CONNECT_TOKEN" }
        val granted = reader.grantedPermissions()
        val missing = HealthCatalog.readPermissions - granted
        require(missing.isEmpty()) { "請先授權 Health Connect（尚缺 ${missing.size} 項權限）" }

        var token = store.changesToken
        var scan: HistoryScan? = null
        var resumed = false
        if (token == null) {
            scan = HistoryScan.resumable(store.historyScan, destination)
            if (scan != null) {
                resumed = true
            } else {
                // Capture the token before the historical scan so changes made while
                // the scan runs are included in the following incremental pass.
                onProgress("建立增量同步游標…")
                val captured = reader.changesToken()
                val end = clock()
                scan = HistoryScan(
                    changesToken = captured,
                    startMs = end - historyDays(granted) * DAY_MS,
                    endMs = end,
                    destination = destination,
                )
                store.saveHistoryScan(scan)
            }
            token = scan.changesToken
        }
        // Refresh sleep on every run, even with an existing change token. Within a scan its
        // deletions are re-verified once; a resumed scan does not send that reconcile again.
        val sleepReconcile = scan != null && HealthCatalog.SLEEP.key !in scan.completed
        var summary = runSleep(onProgress, reconcile = sleepReconcile)
        if (scan != null) {
            var progress: HistoryScan = scan
            if (sleepReconcile) {
                progress = progress.withCompleted(HealthCatalog.SLEEP.key)
                store.saveHistoryScan(progress)
            }
            val order = HealthCatalog.historyOrder
            val remaining = progress.remaining(order.map { it.key })
            onProgress(
                if (resumed) {
                    "繼續上次中斷的初始掃描（剩 ${remaining.size} / ${order.size} 類）…"
                } else {
                    "初始掃描最近 ${(progress.endMs - progress.startMs) / DAY_MS} 天…"
                },
            )
            val canReconcile = HistoryScan.canReconcile(
                resumed,
                historyPermission = HealthCatalog.HISTORY_PERMISSION in granted,
                startMs = progress.startMs,
                nowMs = clock(),
            )
            // Sleep has already been uploaded before the larger histories.
            for (type in order) {
                if (type.key !in remaining) continue
                summary += uploadHistoryType(type, progress.startMs, progress.endMs, onProgress, reconcile = canReconcile)
                if (!canReconcile) {
                    summary += unverified(type, progress.startMs, progress.endMs, ReconcileText.PERMISSION_WINDOW)
                }
                progress = progress.withCompleted(type.key)
                store.saveHistoryScan(progress)
            }
            store.finishHistoryScan(progress.changesToken)
        }

        var currentToken = requireNotNull(token)
        do {
            onProgress("檢查初始掃描期間的新變更…")
            val response = reader.changes(currentToken)
            if (response.tokenExpired) {
                store.resetChangesToken()
                onProgress("增量游標已過期，重新掃描歷史資料…")
                return run(onProgress)
            }
            val records = response.upserts.filter { it.originPackage != ownPackage }
            val deletedIds = response.deletedIds
            for (chunk in records.chunked(50)) {
                upload(chunk, emptyList(), onProgress).also {
                    summary += SyncSummary(inserted = it.inserted, updated = it.updated)
                }
                onProgress("上傳增量資料：${records.size} 筆；刪除 ${deletedIds.size} 筆…")
            }
            for (chunk in deletedIds.chunked(250)) {
                upload(emptyList(), chunk, onProgress).also { summary += SyncSummary(deleted = it.deleted) }
            }
            currentToken = response.nextToken
            store.changesToken = currentToken
        } while (response.hasMore)

        onProgress("同步完成：新增 ${summary.inserted}、更新 ${summary.updated}、刪除 ${summary.deleted}${ReconcileText.note(summary.unverified)}")
        return summary
    }

    /**
     * Re-reads each persisted [ReconcileGap] window and sends only its reconcile windows (no
     * record uploads). A gap is cleared only when every window of it was confirmed; a refusal
     * (e.g. HTTP 409 from the server's deletion limits) keeps it with the new reason. Windows the
     * read permission may not fully cover are not sent at all.
     */
    suspend fun reverify(onProgress: (String) -> Unit = {}): SyncSummary {
        onProgress("檢查連線設定與 Health Connect 權限…")
        require(credentialsReady) { "請先儲存 Infovore endpoint 與 HEALTH_CONNECT_TOKEN" }
        val pending = gaps
        if (pending.isEmpty()) return SyncSummary()
        val granted = reader.grantedPermissions()
        var summary = SyncSummary()
        for (gap in pending) {
            val type = HealthCatalog.type(gap.dataType)
            if (type == null) {
                // Not a type this version syncs (only from a damaged setting): nothing can verify it.
                store.reconcileGapsText = ReconcileGaps.encode(gaps.filterNot { it.dataType == gap.dataType })
                continue
            }
            if (type.readPermission !in granted) {
                summary += unverified(type, gap.startMs, gap.endMs, ReconcileText.NO_READ_PERMISSION)
                continue
            }
            val readable = HistoryScan.canReconcile(
                resumed = true,
                historyPermission = HealthCatalog.HISTORY_PERMISSION in granted,
                startMs = gap.startMs,
                nowMs = clock(),
            )
            if (!readable) {
                summary += unverified(type, gap.startMs, gap.endMs, ReconcileText.PERMISSION_WINDOW)
                continue
            }
            summary += uploadHistoryType(type, gap.startMs, gap.endMs, onProgress, reconcile = true, uploadRecords = false)
        }
        onProgress(
            if (summary.unverified.isEmpty()) "重新核實完成：刪除 ${summary.deleted} 筆來源已刪除的資料"
            else "重新核實未完成${ReconcileText.note(summary.unverified)}",
        )
        return summary
    }

    // The configured window is capped by what Health Connect lets us read:
    // 30 days unless the history permission was granted.
    private fun historyDays(granted: Set<String>): Long {
        val allowed = if (HealthCatalog.HISTORY_PERMISSION in granted) 3650L else 30L
        return store.historyDays.toLong().coerceAtMost(allowed)
    }

    /**
     * Reads every [type] record in [startMs, endMs) page by page and (with [uploadRecords])
     * uploads it. With [reconcile], the pages also feed a [ReconcilePlanner], and each window it
     * completes is sent so the server can drop rows the phone no longer has. A refused window, a
     * read that breaks the planner's assumptions, or a failed read or upload stops reconciling
     * this type; the type is then reported in [SyncSummary.unverified] and saved as a
     * [ReconcileGap]. A completed pass clears the type's gap. A failed read of any page also
     * saves the gap (nothing more is sent for the type).
     */
    private suspend fun uploadHistoryType(
        type: HealthCatalog.Type,
        startMs: Long,
        endMs: Long,
        onProgress: (String) -> Unit,
        newestFirst: Boolean = false,
        reconcile: Boolean = false,
        uploadRecords: Boolean = true,
    ): SyncSummary {
        var summary = SyncSummary()
        var processed = 0
        var pageToken: String? = null
        val planner = if (reconcile) {
            ReconcilePlanner(type.key, startMs, endMs, ascending = !newestFirst, targetIds = reconcileTargetIds)
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
        onProgress("讀取${type.label}資料…")
        do {
            val response = try {
                reader.readPage(type.key, startMs, endMs, pageToken, ascending = !newestFirst)
            } catch (cancelled: CancellationException) {
                throw cancelled
            } catch (error: Exception) {
                // An incomplete read can never be reconciled: no window of the rest is sent, and the
                // type stays unverified until a later complete pass.
                if (planner != null) recordGap(type, startMs, endMs, unverified ?: ReconcileText.READ_FAILED)
                throw error
            }
            if (uploadRecords) {
                for (chunk in response.items.chunked(50)) {
                    upload(chunk, emptyList(), onProgress).also {
                        summary += SyncSummary(inserted = it.inserted, updated = it.updated)
                    }
                }
            }
            if (planner != null) {
                sendWindows(planner.add(response.items.map { ReconcilePlanner.Item(it.id, it.startMs) }))
            }
            processed += response.items.size
            onProgress("${type.label}：已處理 $processed 筆")
            pageToken = response.nextPageToken?.takeIf(String::isNotEmpty)
        } while (pageToken != null)
        // Upload failures (network, HTTP 5xx including the server's retryable 503) propagate
        // without side effects: the sync fails, the scan keeps its progress, and the type is read
        // and reconciled again on the next run.
        if (planner != null) {
            if (unverified == null) planner.finish()?.let { sendWindows(listOf(it)) }
            val reason = unverified ?: planner.failure
            if (reason != null) {
                summary += unverified(type, startMs, endMs, reason)
            } else {
                store.reconcileGapsText = ReconcileGaps.encode(ReconcileGaps.verified(gaps, type.key, startMs, endMs))
            }
        }
        return summary
    }

    /** Saves the gap and returns the summary line for it. */
    private fun unverified(type: HealthCatalog.Type, startMs: Long, endMs: Long, reason: String): SyncSummary {
        recordGap(type, startMs, endMs, reason)
        return SyncSummary(unverified = listOf("${type.label}（$reason）"))
    }

    private fun recordGap(type: HealthCatalog.Type, startMs: Long, endMs: Long, reason: String) {
        store.reconcileGapsText = ReconcileGaps.encode(
            ReconcileGaps.record(gaps, ReconcileGap(type.key, startMs, endMs, reason, clock())),
        )
    }

    private fun upload(
        records: List<HealthItem>,
        deletedRecordIds: List<String>,
        onProgress: (String) -> Unit,
        reconcile: ReconcileWindow? = null,
    ) = uploader.upload(records, deletedRecordIds, reconcile) { attempt, message ->
        onProgress("連線中斷，正在進行第 $attempt 次上傳：$message")
    }

    private fun now(): Instant = Instant.ofEpochMilli(clock())

    private companion object {
        const val DAY_MS = 24L * 60 * 60 * 1000
    }
}
