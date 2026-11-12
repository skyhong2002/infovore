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
    private val maxRejected: Int = ObservationQueue.MAX_REJECTED,
) {
    /** Quarantining one more record would exceed [maxRejected]: the run stops and the record stays queued. */
    private class QuarantineFull : Exception()

    /**
     * [rejected]: observations the server refused (HTTP 400) one by one in this run, moved to the
     * queue's quarantine. [error] stops the run and leaves everything not yet confirmed queued;
     * [needsAction] marks an error retrying cannot fix (token, destination, quarantine, a refused
     * request), and [retryAfterMs] carries the server's `Retry-After` of a transient one.
     * [deferredUntilMs]: nothing was sent because the server asked automatic uploads to wait
     * until then ([ScreenUploader.uploadPending]).
     */
    data class Outcome(
        val sent: Int,
        val accepted: Int,
        val duplicates: Int,
        val remaining: Int,
        val error: String?,
        val rejected: Int = 0,
        val needsAction: Boolean = false,
        val retryAfterMs: Long? = null,
        val deferredUntilMs: Long? = null,
    )

    private class Totals {
        var sent = 0
        var accepted = 0
        var duplicates = 0
        var rejected = 0
    }

    fun upload(target: ScreenTarget): Outcome {
        queue.prune(destination = target.destination)
        target.problem()?.let { return Outcome(0, 0, 0, queue.count(target.destination), it, needsAction = true) }
        // A full quarantine stops uploads until the user deals with it. Rejected records are never
        // deleted automatically, and the pending queue stops dropping records for their age
        // meanwhile (the 40 MB cap still applies; see ObservationQueue.prune).
        if (queue.countRejected() >= maxRejected) {
            return Outcome(0, 0, 0, queue.count(target.destination), QUARANTINE_FULL, needsAction = true)
        }
        val totals = Totals()
        var error: String? = null
        var needsAction = false
        var retryAfterMs: Long? = null
        for (round in 1..maxBatchesPerRun) {
            val entries = queue.read(target.destination, maxBatchCount)
            if (entries.isEmpty()) break
            val batch = Batching.split(entries, maxBatchCount, maxBatchBytes) {
                it.json.toByteArray(StandardCharsets.UTF_8).size.toLong()
            }.first()
            val rejectedBefore = totals.rejected
            try {
                deliver(target, batch, totals)
                if (batch.size > 1 && totals.rejected - rejectedBefore == batch.size) {
                    // Every observation of the batch was refused: likely a problem with the request
                    // itself rather than its content. Stop instead of probing the whole queue.
                    error = REJECTED_WHOLE_BATCH
                    needsAction = true
                }
            } catch (_: QuarantineFull) {
                error = QUARANTINE_FULL
                needsAction = true
            } catch (failure: InfovoreApi.HttpStatusException) {
                // 401/403/404/413, or a 503 marked not retryable: keep everything not yet
                // confirmed and stop; retrying cannot help until settings change.
                error = failure.message
                needsAction = true
            } catch (failure: IOException) {
                // Network failures and HTTP 408/429/5xx (including the server's retryable 503 for
                // storage failures): keep everything and retry later (at Retry-After, if given).
                error = failure.message ?: failure.javaClass.simpleName
                retryAfterMs = (failure as? InfovoreApi.RetryableHttpException)?.retryAfterMs
            } catch (failure: IllegalArgumentException) {
                // The endpoint policy refused the destination.
                error = failure.message
                needsAction = true
            }
            if (error != null) break
        }
        return Outcome(
            totals.sent, totals.accepted, totals.duplicates, queue.count(target.destination), error, totals.rejected,
            needsAction = needsAction, retryAfterMs = retryAfterMs,
        )
    }

    /**
     * Sends [batch]; files are deleted only after the server confirms them. On HTTP 400 the batch
     * is split in halves and each half is sent again, down to single observations, so only the
     * observations the server itself rejects are quarantined and every valid one still uploads.
     * Any other failure propagates and stops the run.
     */
    private fun deliver(target: ScreenTarget, batch: List<ObservationQueue.Entry>, totals: Totals) {
        try {
            val response = transport.post(target, body(target, batch))
            queue.remove(batch)
            totals.sent += batch.size
            totals.accepted += response.accepted
            totals.duplicates += response.duplicates
        } catch (failure: InfovoreApi.HttpStatusException) {
            if (failure.status != 400) throw failure
            if (batch.size == 1) {
                if (queue.countRejected() >= maxRejected) throw QuarantineFull()
                queue.quarantine(target.destination, batch)
                totals.rejected++
                return
            }
            val middle = batch.size / 2
            deliver(target, batch.subList(0, middle), totals)
            deliver(target, batch.subList(middle, batch.size), totals)
        }
    }

    private fun body(target: ScreenTarget, batch: List<ObservationQueue.Entry>): ByteArray = buildString {
        append("{\"schemaVersion\":1,\"deviceId\":")
        append(JsonText.quote(target.deviceId))
        append(",\"observations\":[")
        batch.forEachIndexed { index, entry ->
            if (index > 0) append(',')
            append(entry.json)
        }
        append("]}")
    }.toByteArray(StandardCharsets.UTF_8)

    companion object {
        const val MAX_BATCH_COUNT = 40
        const val MAX_BATCH_BYTES = 6L * 1024 * 1024
        const val MAX_BATCHES_PER_RUN = 50
        const val REJECTED_WHOLE_BATCH = "伺服器拒收了整批畫面紀錄（已隔離，未刪除）；暫停上傳到下次執行"
        const val QUARANTINE_FULL =
            "被拒收的畫面紀錄已達上限 ${ObservationQueue.MAX_REJECTED} 筆，已停止上傳；請先放回佇列重送或刪除被拒收的紀錄"
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
