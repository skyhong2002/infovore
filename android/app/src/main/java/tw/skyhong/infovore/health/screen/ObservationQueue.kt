package tw.skyhong.infovore.health.screen

import android.content.Context
import org.json.JSONObject
import java.io.File
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
 * Durable FIFO of observations: one JSON file per observation in noBackupFilesDir/screen-queue/,
 * named `<capturedAtMs>-<id>.json` so name order is capture order.
 */
class ObservationQueue private constructor(private val dir: File) {

    data class Entry(val file: File, val json: String)

    @Synchronized
    fun enqueue(observation: Observation) {
        val json = observation.toJson().toString()
        val name = "${observation.capturedAtMs.toString().padStart(15, '0')}-${observation.id}.json"
        val temp = File(dir, "$name.tmp")
        temp.writeText(json, Charsets.UTF_8)
        if (!temp.renameTo(File(dir, name))) {
            temp.delete()
            return
        }
        prune()
    }

    @Synchronized
    fun count(): Int = files().size

    /** Drops stale items and the oldest items beyond the size cap; also removes orphaned temp files. */
    @Synchronized
    fun prune(nowMs: Long = System.currentTimeMillis()) {
        dir.listFiles { file -> file.name.endsWith(".tmp") && nowMs - file.lastModified() > 60_000L }
            ?.forEach { it.delete() }
        val all = files()
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

    /** Oldest-first entries, skipping and deleting unreadable files. */
    @Synchronized
    fun read(limit: Int): List<Entry> {
        val result = mutableListOf<Entry>()
        for (file in files()) {
            if (result.size >= limit) break
            val json = runCatching { file.readText(Charsets.UTF_8) }.getOrNull()
            if (json == null || runCatching { JSONObject(json) }.isFailure) {
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

    private fun files(): List<File> =
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
    }
}
