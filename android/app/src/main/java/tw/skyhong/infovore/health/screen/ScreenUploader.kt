package tw.skyhong.infovore.health.screen

import android.content.Context
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import org.json.JSONObject
import tw.skyhong.infovore.health.DestinationChange
import tw.skyhong.infovore.health.BackgroundRetry
import tw.skyhong.infovore.health.InfovoreApi
import tw.skyhong.infovore.health.RetryAfter
import tw.skyhong.infovore.health.SyncEnvironment
import tw.skyhong.infovore.health.QuarantineNotifier
import tw.skyhong.infovore.health.SecureSettings
import java.time.Instant

/**
 * Uploads queued phone observations. A process-wide mutex prevents concurrent double-sends and is
 * also taken by a sync-destination change ([tryExclusive]), so the destination can never change
 * in the middle of an upload run. Each run captures its [ScreenTarget] once at the start.
 */
object ScreenUploader {
    const val OBSERVATIONS_PATH = "/api/ingest/dayflow-phone/observations"
    const val STATUS_PATH = "/api/ingest/dayflow-phone/status"

    private val lock = UploadLock()

    /** True while an upload run holds the lock. */
    val isUploading: Boolean get() = lock.isLocked

    /**
     * Uploads the current destination's queue. [automatic] runs (the worker, the recording
     * service) send nothing while the server's last `Retry-After` has not passed
     * ([ScreenSettings.retryNotBefore]) and return an outcome with [ScreenUploadEngine.Outcome.deferredUntilMs];
     * a manual upload always tries. Every run saves the server's new hint, or clears it.
     */
    suspend fun uploadPending(context: Context, automatic: Boolean = false): ScreenUploadEngine.Outcome = lock.withLock {
        withContext(Dispatchers.IO) {
            val app = context.applicationContext
            val settings = ScreenSettings(app)
            val queue = ObservationQueue.get(app)
            val target = currentTarget(app)
            val notBefore = settings.retryNotBefore
            if (automatic && notBefore > System.currentTimeMillis()) {
                return@withContext ScreenUploadEngine.Outcome(0, 0, 0, queue.count(target.destination), null, deferredUntilMs = notBefore)
            }
            // Every request goes to the endpoint and token captured in the run's target.
            val transport = ObservationTransport { runTarget, body ->
                val response = InfovoreApi(runTarget.endpoint, timing = SyncEnvironment.apiTiming())
                    .postJson(OBSERVATIONS_PATH, runTarget.token, body)
                ObservationTransport.Response(response.optInt("accepted"), response.optInt("duplicates"))
            }
            ScreenUploadEngine(queue, transport).upload(target).also { outcome ->
                settings.retryNotBefore = outcome.retryAfterMs
                    ?.let { System.currentTimeMillis() + it.coerceAtMost(BackgroundRetry.MAX_WAIT_MS) } ?: 0L
                record(settings, outcome)
                QuarantineNotifier.record(app, queue.countRejected(), queue.count(target.destination))
            }
        }
    }

    /**
     * Runs a short, non-suspending [block] only while no upload is running; returns false without
     * running it otherwise.
     */
    fun tryExclusive(block: () -> Unit): Boolean = lock.tryExclusive(block)

    suspend fun checkStatus(context: Context): JSONObject = withContext(Dispatchers.IO) {
        val target = currentTarget(context.applicationContext)
        target.problem()?.let { throw IllegalArgumentException(it) }
        InfovoreApi(target.endpoint, timing = SyncEnvironment.apiTiming()).getJson(STATUS_PATH, target.token)
    }

    /** The normalised destination new observations are filed under and uploads go to. */
    fun currentDestination(context: Context): String = DestinationChange.normalize(SecureSettings(context).endpoint)

    /** Snapshot of the saved endpoint, phone token and device id. */
    fun currentTarget(context: Context): ScreenTarget {
        val shared = SecureSettings(context)
        val screen = ScreenSettings(context)
        return ScreenTarget(shared.endpoint, screen.token, screen.tokenDestination, shared.deviceId)
    }

    /**
     * Deletes queued observations that belong to another (or an unknown) destination; returns how
     * many, or null when an upload is running.
     */
    fun deleteOtherDestinations(context: Context): Int? {
        var removed: Int? = null
        tryExclusive {
            removed = ObservationQueue.get(context).removeOtherDestinations(currentDestination(context))
        }
        return removed
    }

    /**
     * Deletes, after the user confirmed, the observations the server rejected; returns how many,
     * or null when an upload is running.
     */
    fun deleteRejected(context: Context): Int? {
        var removed: Int? = null
        tryExclusive { removed = ObservationQueue.get(context).removeRejected() }
        if (removed != null) recheckQuarantine(context)
        return removed
    }

    /**
     * Moves, after the user confirmed, the rejected observations of the current destination back
     * into its upload queue; returns how many, or null when an upload is running.
     */
    fun requeueRejected(context: Context): Int? {
        var moved: Int? = null
        tryExclusive { moved = ObservationQueue.get(context).requeueRejected(currentDestination(context)) }
        if (moved != null) recheckQuarantine(context)
        return moved
    }

    /**
     * After the user dealt with the quarantine, or turned notifications on: removes a warning
     * that no longer applies, or shows one that does and was not shown yet.
     */
    fun recheckQuarantine(context: Context) {
        val queue = ObservationQueue.get(context)
        QuarantineNotifier.record(context.applicationContext, queue.countRejected(), queue.count(currentDestination(context)))
    }

    private fun record(settings: ScreenSettings, outcome: ScreenUploadEngine.Outcome) {
        settings.lastUploadStatus = "${Instant.now()}：${describe(outcome)}"
    }

    /** One line for an upload run's result; also used for the manual upload's result. */
    fun describe(outcome: ScreenUploadEngine.Outcome): String {
        val rejected = if (outcome.rejected > 0) "；${outcome.rejected} 筆被伺服器拒收（已隔離，未上傳）" else ""
        val wait = outcome.retryAfterMs?.let { "；伺服器要求約 ${RetryAfter.describe(it)}後再試，自動上傳會等到那時" } ?: ""
        return when {
            outcome.error != null && outcome.sent > 0 -> "已送出 ${outcome.sent} 筆後失敗：${outcome.error}$rejected$wait"
            outcome.error != null -> "${outcome.error}$rejected$wait"
            outcome.sent == 0 && outcome.rejected == 0 -> "沒有待上傳的資料"
            else -> "已送出 ${outcome.sent} 筆（新增 ${outcome.accepted}、重複 ${outcome.duplicates}）$rejected"
        }
    }
}
