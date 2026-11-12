package tw.skyhong.infovore.health.screen

import android.content.Context
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext
import org.json.JSONObject
import tw.skyhong.infovore.health.InfovoreApi
import tw.skyhong.infovore.health.SecureSettings
import java.io.IOException
import java.nio.charset.StandardCharsets
import java.time.Instant

/** Uploads queued phone observations; a process-wide mutex prevents concurrent double-sends. */
object ScreenUploader {
    const val OBSERVATIONS_PATH = "/api/ingest/dayflow-phone/observations"
    const val STATUS_PATH = "/api/ingest/dayflow-phone/status"
    const val MAX_BATCH_COUNT = 40
    const val MAX_BATCH_BYTES = 6L * 1024 * 1024
    private const val MAX_BATCHES_PER_RUN = 50

    private val mutex = Mutex()

    data class Outcome(val sent: Int, val accepted: Int, val duplicates: Int, val remaining: Int, val error: String?)

    suspend fun uploadPending(context: Context): Outcome = mutex.withLock {
        withContext(Dispatchers.IO) { uploadLocked(context.applicationContext) }
    }

    suspend fun checkStatus(context: Context): JSONObject = withContext(Dispatchers.IO) {
        val app = context.applicationContext
        val token = ScreenSettings(app).token
        require(token.length >= 32) { "請先輸入至少 32 字元的 DAYFLOW_PHONE_TOKEN" }
        InfovoreApi(SecureSettings(app)).getJson(STATUS_PATH, token)
    }

    private fun uploadLocked(context: Context): Outcome {
        val settings = ScreenSettings(context)
        val shared = SecureSettings(context)
        val queue = ObservationQueue.get(context)
        queue.prune()
        val token = settings.token
        if (token.length < 32) {
            return Outcome(0, 0, 0, queue.count(), "尚未設定 DAYFLOW_PHONE_TOKEN").also { record(settings, it) }
        }
        val api = InfovoreApi(shared)
        var sent = 0
        var accepted = 0
        var duplicates = 0
        var error: String? = null
        for (round in 1..MAX_BATCHES_PER_RUN) {
            val entries = queue.read(MAX_BATCH_COUNT)
            if (entries.isEmpty()) break
            val batch = Batching.split(entries, MAX_BATCH_COUNT, MAX_BATCH_BYTES) {
                it.json.toByteArray(StandardCharsets.UTF_8).size.toLong()
            }.first()
            val body = buildString {
                append("{\"schemaVersion\":1,\"deviceId\":")
                append(JSONObject.quote(shared.deviceId))
                append(",\"observations\":[")
                batch.forEachIndexed { index, entry ->
                    if (index > 0) append(',')
                    append(entry.json)
                }
                append("]}")
            }.toByteArray(StandardCharsets.UTF_8)
            try {
                val response = api.postJson(OBSERVATIONS_PATH, token, body)
                queue.remove(batch)
                sent += batch.size
                accepted += response.optInt("accepted")
                duplicates += response.optInt("duplicates")
            } catch (failure: InfovoreApi.HttpStatusException) {
                if (failure.status == 400) {
                    // The server rejected this content and always will: drop it instead of
                    // blocking every later observation behind it.
                    queue.remove(batch)
                    error = "已捨棄 ${batch.size} 筆無效資料：${failure.message}"
                } else {
                    // 401/413/503…: keep the batch and stop until the next scheduled run.
                    error = failure.message
                }
            } catch (failure: IOException) {
                error = failure.message ?: failure.javaClass.simpleName
            } catch (failure: IllegalArgumentException) {
                error = failure.message
            }
            if (error != null) break
        }
        return Outcome(sent, accepted, duplicates, queue.count(), error).also { record(settings, it) }
    }

    private fun record(settings: ScreenSettings, outcome: Outcome) {
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
