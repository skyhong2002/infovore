package tw.skyhong.infovore.health.screen

import android.content.Context
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import org.json.JSONObject
import tw.skyhong.infovore.health.DestinationChange
import tw.skyhong.infovore.health.InfovoreApi
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

    suspend fun uploadPending(context: Context): ScreenUploadEngine.Outcome = lock.withLock {
        withContext(Dispatchers.IO) {
            val app = context.applicationContext
            // Every request goes to the endpoint and token captured in the run's target.
            val transport = ObservationTransport { target, body ->
                val response = InfovoreApi(target.endpoint).postJson(OBSERVATIONS_PATH, target.token, body)
                ObservationTransport.Response(response.optInt("accepted"), response.optInt("duplicates"))
            }
            val engine = ScreenUploadEngine(ObservationQueue.get(app), transport)
            engine.upload(currentTarget(app)).also { record(ScreenSettings(app), it) }
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
        InfovoreApi(target.endpoint).getJson(STATUS_PATH, target.token)
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

    private fun record(settings: ScreenSettings, outcome: ScreenUploadEngine.Outcome) {
        val now = Instant.now()
        settings.lastUploadStatus = when {
            outcome.error != null && outcome.sent > 0 ->
                "$now：已送出 ${outcome.sent} 筆後失敗：${outcome.error}"
            outcome.error != null -> "$now：${outcome.error}"
            outcome.sent == 0 -> "$now：沒有待上傳的資料"
            else -> "$now：已送出 ${outcome.sent} 筆（新增 ${outcome.accepted}、重複 ${outcome.duplicates}）"
        }
    }
}
