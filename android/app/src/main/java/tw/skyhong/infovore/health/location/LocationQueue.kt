package tw.skyhong.infovore.health.location

import android.content.Context
import java.io.File

/**
 * Fixes waiting for upload, one line each ([LocationJson.encodeLine]) in a file under
 * `noBackupFilesDir`. The tracking service appends; the uploader reads the oldest lines and
 * removes them only after the server stored them, so a failed upload loses nothing. At most
 * [MAX_LINES] fixes are kept (about a month at one a minute): past that the oldest are dropped.
 * All access goes through one process-wide lock.
 */
class LocationQueue(context: Context) {
    private val file = File(context.noBackupFilesDir, FILE_NAME)

    fun add(fix: LocationFix) = synchronized(LOCK) {
        file.appendText(LocationJson.encodeLine(fix) + "\n")
        appendsSinceTrim++
        if (appendsSinceTrim >= 500) {
            appendsSinceTrim = 0
            trimLocked()
        }
    }

    fun size(): Int = synchronized(LOCK) { lines().size }

    /** The oldest [max] fixes and the number of lines they span (unreadable lines included, so [remove] drops them too). */
    fun peek(max: Int): Pair<List<LocationFix>, Int> = synchronized(LOCK) {
        val head = lines().take(max)
        head.mapNotNull(LocationJson::decodeLine) to head.size
    }

    /** Removes the oldest [count] lines, those a [peek] returned and the server stored. */
    fun remove(count: Int) = synchronized(LOCK) {
        if (count <= 0) return@synchronized
        rewrite(lines().drop(count))
    }

    fun clear() = synchronized(LOCK) { file.delete() }

    private fun trimLocked() {
        val all = lines()
        if (all.size > MAX_LINES) rewrite(all.takeLast(MAX_LINES))
    }

    private fun lines(): List<String> = if (file.exists()) file.readLines().filter(String::isNotBlank) else emptyList()

    private fun rewrite(lines: List<String>) {
        if (lines.isEmpty()) {
            file.delete()
            return
        }
        val temp = File(file.parentFile, "$FILE_NAME.tmp")
        temp.writeText(lines.joinToString("\n", postfix = "\n"))
        if (!temp.renameTo(file)) {
            file.writeText(temp.readText())
            temp.delete()
        }
    }

    companion object {
        const val FILE_NAME = "location-queue.csv"
        const val MAX_LINES = 50_000
        private val LOCK = Any()
        private var appendsSinceTrim = 0
    }
}
