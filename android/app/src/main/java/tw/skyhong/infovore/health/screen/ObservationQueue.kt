package tw.skyhong.infovore.health.screen

import android.content.Context
import org.json.JSONObject
import java.io.File
import java.security.MessageDigest
import java.time.OffsetDateTime
import java.time.format.DateTimeFormatter
import java.util.Locale
import java.util.UUID

data class Observation(
    val id: String = UUID.randomUUID().toString(),
    val capturedAtMs: Long,
    val packageName: String,
    val appLabel: String,
    val text: String,
    val blocked: Boolean,
    val image: String? = null,
) {
    fun toJson(): JSONObject = JSONObject()
        .put("id", id)
        .put("capturedAt", isoTimestamp(capturedAtMs))
        .put("package", packageName.take(MAX_NAME_CHARS))
        .put("appLabel", appLabel.take(MAX_NAME_CHARS))
        .put("text", if (blocked) "" else ScreenText.cap(text))
        .put("blocked", blocked)
        .apply { if (!blocked && image != null) put("image", image) }

    companion object {
        const val MAX_NAME_CHARS = 200
        private val formatter = DateTimeFormatter.ofPattern("yyyy-MM-dd'T'HH:mm:ss.SSSXXX", Locale.ROOT)

        fun isoTimestamp(epochMs: Long): String = OffsetDateTime
            .ofInstant(java.time.Instant.ofEpochMilli(epochMs), java.time.ZoneId.systemDefault())
            .format(formatter)
    }
}

/**
 * Durable FIFO of observations, kept per sync destination: each observation is filed under the
 * destination (normalised endpoint, see [tw.skyhong.infovore.health.DestinationChange.normalize])
 * that was saved when it was captured, in `noBackupFilesDir/screen-queue/d-<hash>/`, one JSON file
 * named `<capturedAtMs>-<id>.json` so name order is capture order. Uploads read only the bucket of
 * the destination they send to, so records captured for one server are never sent to another.
 * Files directly in `screen-queue/` come from versions before 0.3.2, whose destination is unknown;
 * they count as belonging to another destination.
 *
 * Android-free apart from [get], so it can be unit tested; [isValidJson] defaults to org.json.
 */
class ObservationQueue internal constructor(
    private val root: File,
    private val isValidJson: (String) -> Boolean = { json -> runCatching { JSONObject(json) }.isSuccess },
) {

    data class Entry(val file: File, val json: String)

    @Synchronized
    fun enqueue(destination: String, observation: Observation) =
        enqueueJson(destination, observation.capturedAtMs, observation.id, observation.toJson().toString())

    @Synchronized
    internal fun enqueueJson(destination: String, capturedAtMs: Long, id: String, json: String) {
        val dir = bucket(destination).apply { mkdirs() }
        val name = "${capturedAtMs.toString().padStart(15, '0')}-$id.json"
        val temp = File(dir, "$name.tmp")
        temp.writeText(json, Charsets.UTF_8)
        if (!temp.renameTo(File(dir, name))) {
            temp.delete()
            return
        }
        prune()
    }

    /** Pending observations for [destination]. */
    @Synchronized
    fun count(destination: String): Int = files(bucket(destination)).size

    /** Pending observations that belong to any other (or an unknown, pre-0.3.2) destination. */
    @Synchronized
    fun countOtherDestinations(destination: String): Int = otherDirs(destination).sumOf { files(it).size }

    /** Deletes every pending observation not filed under [destination]; returns how many. */
    @Synchronized
    fun removeOtherDestinations(destination: String): Int {
        var removed = 0
        for (dir in otherDirs(destination)) {
            for (file in files(dir)) if (file.delete()) removed++
            dir.listFiles { file -> file.name.endsWith(".tmp") }?.forEach { it.delete() }
            if (dir != root) dir.delete()
        }
        return removed
    }

    /** Drops stale items and the oldest items beyond the size cap; also removes orphaned temp files. */
    @Synchronized
    fun prune(nowMs: Long = System.currentTimeMillis()) {
        for (dir in allDirs()) {
            dir.listFiles { file -> file.name.endsWith(".tmp") && nowMs - file.lastModified() > 60_000L }
                ?.forEach { it.delete() }
        }
        val all = allDirs().flatMap(::files).sortedBy { it.name }
        val cutoff = nowMs - MAX_AGE_MS
        val fresh = all.filter { file ->
            val stale = capturedAt(file)?.let { it < cutoff } ?: true
            if (stale) file.delete()
            !stale
        }
        var total = fresh.sumOf { it.length() }
        for (file in fresh) {
            if (total <= MAX_TOTAL_BYTES) break
            total -= file.length()
            file.delete()
        }
    }

    /** Oldest-first entries for [destination], skipping and deleting unreadable files. */
    @Synchronized
    fun read(destination: String, limit: Int): List<Entry> {
        val result = mutableListOf<Entry>()
        for (file in files(bucket(destination))) {
            if (result.size >= limit) break
            val json = runCatching { file.readText(Charsets.UTF_8) }.getOrNull()
            if (json == null || !isValidJson(json)) {
                file.delete()
                continue
            }
            result += Entry(file, json)
        }
        return result
    }

    @Synchronized
    fun remove(entries: List<Entry>) {
        entries.forEach { it.file.delete() }
    }

    /**
     * Moves observations the server rejected (HTTP 400, one by one) out of the upload queue into
     * `screen-queue/rejected/`. They are never uploaded, pruned or deleted automatically; only
     * [removeRejected], after the user confirms, deletes them.
     */
    @Synchronized
    fun quarantine(entries: List<Entry>) {
        val dir = rejectedDir().apply { mkdirs() }
        for (entry in entries) {
            val target = File(dir, entry.file.name)
            if (!entry.file.renameTo(target)) {
                // Never leave a rejected record in the queue, where it would block every later one.
                target.writeText(entry.json, Charsets.UTF_8)
                entry.file.delete()
            }
        }
    }

    /** Observations the server rejected, kept until the user deletes them. */
    @Synchronized
    fun countRejected(): Int = files(rejectedDir()).size

    /** Deletes every rejected observation; returns how many. */
    @Synchronized
    fun removeRejected(): Int {
        var removed = 0
        for (file in files(rejectedDir())) if (file.delete()) removed++
        return removed
    }

    private fun bucket(destination: String): File = File(root, bucketName(destination))

    // Not a "d-" bucket, so uploads, pruning and destination clean-up never touch it.
    private fun rejectedDir(): File = File(root, REJECTED_DIR)

    private fun allDirs(): List<File> =
        listOf(root) + root.listFiles { file -> file.isDirectory && file.name.startsWith(BUCKET_PREFIX) }.orEmpty()

    private fun otherDirs(destination: String): List<File> {
        val own = bucketName(destination)
        return allDirs().filter { it.name != own }
    }

    private fun files(dir: File): List<File> =
        dir.listFiles { file -> file.isFile && file.name.endsWith(".json") }
            ?.sortedBy { it.name }
            .orEmpty()

    private fun capturedAt(file: File): Long? = file.name.substringBefore('-').toLongOrNull()

    companion object {
        @Volatile private var instance: ObservationQueue? = null

        /** Process-wide instance so @Synchronized guards every reader and writer. */
        fun get(context: Context): ObservationQueue = instance ?: synchronized(this) {
            instance ?: ObservationQueue(
                File(context.applicationContext.noBackupFilesDir, "screen-queue").apply { mkdirs() },
            ).also { instance = it }
        }

        const val MAX_AGE_MS = 7L * 24 * 60 * 60 * 1000
        const val MAX_TOTAL_BYTES = 40L * 1024 * 1024
        private const val BUCKET_PREFIX = "d-"
        private const val REJECTED_DIR = "rejected"

        /** A stable directory name for a normalised destination, without putting the URL in a path. */
        internal fun bucketName(destination: String): String {
            val digest = MessageDigest.getInstance("SHA-256").digest(destination.toByteArray(Charsets.UTF_8))
            return BUCKET_PREFIX + digest.take(16).joinToString("") { String.format(Locale.ROOT, "%02x", it) }
        }
    }
}
