package tw.skyhong.infovore.health.screen

import tw.skyhong.infovore.health.DestinationChange
import tw.skyhong.infovore.health.InfovoreApi
import tw.skyhong.infovore.health.JsonText
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import java.io.IOException
import java.nio.charset.StandardCharsets

/**
 * Where one upload run sends observations, captured once when the run starts and never re-read:
 * every batch of the run goes to [endpoint] with [token], whatever the settings say meanwhile.
 * [tokenDestination] is the destination the phone token was saved for.
 */
data class ScreenTarget(
    val endpoint: String,
    val token: String,
    val tokenDestination: String?,
    val deviceId: String,
) {
    val destination: String = DestinationChange.normalize(endpoint)

    /** Why this target must not be used, or null when it may upload. */
    fun problem(): String? = when {
        token.length < MIN_TOKEN_LENGTH -> NO_TOKEN
        tokenDestination != destination -> TOKEN_FOR_OTHER_DESTINATION
        else -> null
    }

    companion object {
        const val MIN_TOKEN_LENGTH = 32
        const val NO_TOKEN = "尚未設定 DAYFLOW_PHONE_TOKEN"
        const val TOKEN_FOR_OTHER_DESTINATION =
            "DAYFLOW_PHONE_TOKEN 是為先前的同步目的地儲存的；請為目前的目的地重新輸入並儲存"
    }
}

/** Sends one request body; throws [IOException] or [InfovoreApi.HttpStatusException] on failure. */
fun interface ObservationTransport {
    data class Response(val accepted: Int, val duplicates: Int)

    fun post(target: ScreenTarget, body: ByteArray): Response
}

/**
 * Uploads the queued observations that belong to the target's destination, oldest first, in
 * batches. Android-free so it can be unit tested; [ScreenUploader] wires in the real queue, HTTP
 * transport and the process-wide lock.
 */
class ScreenUploadEngine(
    private val queue: ObservationQueue,
    private val transport: ObservationTransport,
    private val maxBatchCount: Int = MAX_BATCH_COUNT,
    private val maxBatchBytes: Long = MAX_BATCH_BYTES,
    private val maxBatchesPerRun: Int = MAX_BATCHES_PER_RUN,
) {
    data class Outcome(val sent: Int, val accepted: Int, val duplicates: Int, val remaining: Int, val error: String?)

    fun upload(target: ScreenTarget): Outcome {
        queue.prune()
        target.problem()?.let { return Outcome(0, 0, 0, queue.count(target.destination), it) }
        var sent = 0
        var accepted = 0
        var duplicates = 0
        var error: String? = null
        for (round in 1..maxBatchesPerRun) {
            val entries = queue.read(target.destination, maxBatchCount)
            if (entries.isEmpty()) break
            val batch = Batching.split(entries, maxBatchCount, maxBatchBytes) {
                it.json.toByteArray(StandardCharsets.UTF_8).size.toLong()
            }.first()
            val body = buildString {
                append("{\"schemaVersion\":1,\"deviceId\":")
                append(JsonText.quote(target.deviceId))
                append(",\"observations\":[")
                batch.forEachIndexed { index, entry ->
                    if (index > 0) append(',')
                    append(entry.json)
                }
                append("]}")
            }.toByteArray(StandardCharsets.UTF_8)
            try {
                val response = transport.post(target, body)
                queue.remove(batch)
                sent += batch.size
                accepted += response.accepted
                duplicates += response.duplicates
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
        return Outcome(sent, accepted, duplicates, queue.count(target.destination), error)
    }

    companion object {
        const val MAX_BATCH_COUNT = 40
        const val MAX_BATCH_BYTES = 6L * 1024 * 1024
        const val MAX_BATCHES_PER_RUN = 50
    }
}

/**
 * The lock shared by upload runs and sync-destination changes: an upload holds it for the whole
 * run, and a destination change only goes ahead if it can take it immediately ([tryExclusive]).
 */
class UploadLock {
    private val mutex = Mutex()

    val isLocked: Boolean get() = mutex.isLocked

    suspend fun <T> withLock(block: suspend () -> T): T = mutex.withLock { block() }

    /** Runs the short, non-suspending [block] only if no upload holds the lock; returns whether it ran. */
    fun tryExclusive(block: () -> Unit): Boolean {
        if (!mutex.tryLock()) return false
        try {
            block()
        } finally {
            mutex.unlock()
        }
        return true
    }
}
