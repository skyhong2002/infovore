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
 *
 * Retention: the oldest records beyond [maxTotalBytes] (40 MB) are always dropped, and records older
 * than [MAX_AGE_MS] too, except that time during which a full quarantine ([maxRejected]) stopped
 * uploads does not count toward the current destination's seven days (see [AgeHold]).
 */
class ObservationQueue internal constructor(
    private val root: File,
    private val maxRejected: Int = MAX_REJECTED,
    private val maxTotalBytes: Long = MAX_TOTAL_BYTES,
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
        prune(destination = destination)
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

    /**
     * Drops stale items and the oldest items beyond the size cap; also removes orphaned temp files.
     * [destination] is the current destination (null when unknown): while the quarantine is full,
     * its records are not dropped for their age ([AgeHold]); the size cap still applies to all.
     */
    @Synchronized
    fun prune(nowMs: Long = System.currentTimeMillis(), destination: String? = null) {
        for (dir in allDirs()) {
            dir.listFiles { file -> file.name.endsWith(".tmp") && nowMs - file.lastModified() > 60_000L }
                ?.forEach { it.delete() }
        }
        val previous = ageHold()
        val hold = QueueRetention.nextHold(previous, destination?.let(::bucketName), countRejected() >= maxRejected, nowMs)
        if (hold != previous) writeAgeHold(hold)
        val all = allDirs().flatMap(::files).sortedBy { it.name }
        val fresh = all.filter { file ->
            val held = hold?.takeIf { it.bucket == file.parentFile?.name }
            val stale = capturedAt(file)?.let { QueueRetention.isStale(it, nowMs, held) } ?: true
            if (stale) file.delete()
            !stale
        }
        var total = fresh.sumOf { it.length() }
        for (file in fresh) {
            if (total <= maxTotalBytes) break
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
     * Moves observations of [destination] the server rejected (HTTP 400, one by one) out of the
     * upload queue into `screen-queue/rejected/d-<hash>/`, remembering their destination. They are
     * never uploaded, pruned or deleted automatically; only the user can put them back
     * ([requeueRejected], same destination only) or delete them ([removeRejected]).
     */
    @Synchronized
    fun quarantine(destination: String, entries: List<Entry>) {
        val dir = rejectedBucket(destination).apply { mkdirs() }
        for (entry in entries) {
            val target = File(dir, entry.file.name)
            if (!entry.file.renameTo(target)) {
                // Never leave a rejected record in the queue, where it would block every later one.
                target.writeText(entry.json, Charsets.UTF_8)
                entry.file.delete()
            }
        }
    }

    /** The current [AgeHold], or null when uploads were not recently stopped by a full quarantine. */
    @Synchronized
    fun ageHold(): AgeHold? = AgeHold.decode(runCatching { File(root, AGE_HOLD_FILE).readText(Charsets.UTF_8) }.getOrNull())

    private fun writeAgeHold(hold: AgeHold?) {
        val file = File(root, AGE_HOLD_FILE)
        if (hold == null) {
            file.delete()
        } else {
            runCatching { file.writeText(hold.encode(), Charsets.UTF_8) }
        }
    }

    /** Observations the server rejected, kept until the user deletes them or puts them back. */
    @Synchronized
    fun countRejected(): Int = rejectedDirs().sumOf { files(it).size }

    /**
     * Rejected observations that may go back to [destination]'s upload queue: quarantined from
     * that destination (records quarantined before 0.4.1 have no known destination) and still
     * younger than [MAX_AGE_MS], which the queue would otherwise drop at once.
     */
    @Synchronized
    fun countRequeueable(destination: String, nowMs: Long = System.currentTimeMillis()): Int =
        requeueable(destination, nowMs).size

    /**
     * Moves the [countRequeueable] observations back into [destination]'s upload queue, after
     * the user confirmed; returns how many. Everything else stays quarantined.
     */
    @Synchronized
    fun requeueRejected(destination: String, nowMs: Long = System.currentTimeMillis()): Int {
        val target = bucket(destination).apply { mkdirs() }
        var moved = 0
        for (file in requeueable(destination, nowMs)) {
            val back = File(target, file.name)
            if (file.renameTo(back)) {
                moved++
            } else {
                // Never lose a record: copy, and remove the quarantined copy only once it is written.
                val copied = runCatching { file.copyTo(back, overwrite = true) }.isSuccess
                if (copied && file.delete()) moved++
            }
        }
        rejectedBucket(destination).delete()
        return moved
    }

    /** Deletes every rejected observation; returns how many. */
    @Synchronized
    fun removeRejected(): Int {
        var removed = 0
        for (dir in rejectedDirs()) {
            for (file in files(dir)) if (file.delete()) removed++
            if (dir != rejectedDir()) dir.delete()
        }
        return removed
    }

    private fun requeueable(destination: String, nowMs: Long): List<File> {
        val cutoff = nowMs - MAX_AGE_MS
        return files(rejectedBucket(destination)).filter { file -> capturedAt(file)?.let { it >= cutoff } ?: false }
    }

    private fun bucket(destination: String): File = File(root, bucketName(destination))

    // Not a "d-" bucket, so uploads, pruning and destination clean-up never touch it. Files
    // directly in it were quarantined before 0.4.1 and have no known destination.
    private fun rejectedDir(): File = File(root, REJECTED_DIR)

    private fun rejectedBucket(destination: String): File = File(rejectedDir(), bucketName(destination))

    private fun rejectedDirs(): List<File> =
        listOf(rejectedDir()) + rejectedDir().listFiles { file -> file.isDirectory && file.name.startsWith(BUCKET_PREFIX) }.orEmpty()

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

        /** At this many quarantined observations uploads stop until the user deals with them. */
        const val MAX_REJECTED = 500
        private const val BUCKET_PREFIX = "d-"
        private const val REJECTED_DIR = "rejected"

        /** Not a .json file and not a directory, so no listing of records ever sees it. */
        private const val AGE_HOLD_FILE = "age-hold"

        /** A stable directory name for a normalised destination, without putting the URL in a path. */
        internal fun bucketName(destination: String): String {
            val digest = MessageDigest.getInstance("SHA-256").digest(destination.toByteArray(Charsets.UTF_8))
            return BUCKET_PREFIX + digest.take(16).joinToString("") { String.format(Locale.ROOT, "%02x", it) }
        }
    }
}
