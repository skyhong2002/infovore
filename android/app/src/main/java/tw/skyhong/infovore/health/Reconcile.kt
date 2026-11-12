package tw.skyhong.infovore.health

import java.time.Instant

/** Minimal JSON string encoding for payloads built without org.json (which is a stub in JVM unit tests). */
object JsonText {
    fun quote(value: String): String = buildString(value.length + 2) {
        append('"')
        for (char in value) {
            when (char) {
                '"' -> append("\\\"")
                '\\' -> append("\\\\")
                '\n' -> append("\\n")
                '\r' -> append("\\r")
                '\t' -> append("\\t")
                '\b' -> append("\\b")
                '\u000C' -> append("\\f")
                else -> if (char < ' ' || char == ' ' || char == ' ') {
                    append("\\u").append(String.format(java.util.Locale.ROOT, "%04x", char.code))
                } else {
                    append(char)
                }
            }
        }
        append('"')
    }
}

/**
 * One reconcile window sent to the server: [recordIds] is every Health Connect record id of
 * [dataType] that starts in [startMs, endMs), read completely during this sync. The server then
 * deletes this device's stored rows of that type that start in the window, end by its end, and
 * are not listed.
 */
data class ReconcileWindow(
    val dataType: String,
    val startMs: Long,
    val endMs: Long,
    val recordIds: List<String>,
) {
    fun toJson(): String = buildString {
        append("{\"dataType\":").append(JsonText.quote(dataType))
        append(",\"start\":").append(JsonText.quote(Instant.ofEpochMilli(startMs).toString()))
        append(",\"end\":").append(JsonText.quote(Instant.ofEpochMilli(endMs).toString()))
        append(",\"recordIds\":[")
        recordIds.forEachIndexed { index, id ->
            if (index > 0) append(',')
            append(JsonText.quote(id))
        }
        append("]}")
    }
}

/**
 * Turns the pages of one complete history read into reconcile windows, without holding every id
 * of a long history in memory. Pages must arrive in the read order (by start time, [ascending] or
 * descending). A window is closed only at a start time that every later record lies beyond, so
 * each window lists every record starting inside it. Anything that breaks those assumptions (an
 * out-of-order record, or more than [maxIds] records sharing one start time) stops reconciling
 * this type for the rest of the read; [failure] then says why, and nothing more is emitted.
 *
 * Records starting outside [startMs, endMs) are ignored: the server never reconciles outside
 * the window either.
 */
class ReconcilePlanner(
    private val dataType: String,
    private val startMs: Long,
    private val endMs: Long,
    private val ascending: Boolean,
    private val targetIds: Int = TARGET_IDS,
    private val maxIds: Int = MAX_IDS,
) {
    data class Item(val id: String, val startMs: Long)

    var failure: String? = null
        private set

    private val pending = mutableListOf<String>()
    private var lastStart: Long? = null
    private var finished = false

    /** The window edge already settled: its start when ascending, its end when descending. */
    private var boundary = if (ascending) startMs else endMs

    init {
        require(startMs < endMs) { "reconcile window must not be empty" }
        require(targetIds in 1..maxIds)
    }

    /** Feeds one page (after it was uploaded); returns the windows it completed. */
    fun add(items: List<Item>): List<ReconcileWindow> {
        check(!finished)
        if (failure != null) return emptyList()
        val completed = mutableListOf<ReconcileWindow>()
        for (item in items) {
            if (item.startMs < startMs || item.startMs >= endMs) continue
            val last = lastStart
            if (last != null && (if (ascending) item.startMs < last else item.startMs > last)) {
                return fail(OUT_OF_ORDER, completed)
            }
            if (last != null && item.startMs != last && pending.size >= targetIds) {
                // Every record on the settled side of this start time has been seen.
                completed += if (ascending) {
                    window(boundary, item.startMs).also { boundary = item.startMs }
                } else {
                    window(last, boundary).also { boundary = last }
                }
                pending.clear()
            }
            pending += item.id
            lastStart = item.startMs
            if (pending.size > maxIds) return fail(TOO_MANY_AT_ONCE, completed)
        }
        return completed
    }

    /** Call once after the last page was read successfully; returns the final window, if any. */
    fun finish(): ReconcileWindow? {
        check(!finished)
        finished = true
        if (failure != null) return null
        return if (ascending) window(boundary, endMs) else window(startMs, boundary)
    }

    private fun window(from: Long, to: Long) = ReconcileWindow(dataType, from, to, pending.toList())

    private fun fail(reason: String, completed: List<ReconcileWindow>): List<ReconcileWindow> {
        failure = reason
        pending.clear()
        return completed
    }

    companion object {
        /** Ids per window the planner aims for (well under the server's limit). */
        const val TARGET_IDS = 2000

        /** The server's MAX_RECONCILE_RECORD_IDS. */
        const val MAX_IDS = 5000

        const val OUT_OF_ORDER = "讀取順序異常"
        const val TOO_MANY_AT_ONCE = "同一時間的紀錄過多"
    }
}

/** Text for data types whose deletions could not be re-verified after a history rescan. */
object ReconcileText {
    /** The suffix appended to a finished sync's status, or "" when every rescanned type was verified. */
    fun note(unverified: List<String>): String =
        if (unverified.isEmpty()) "" else "；未重新核實來源已刪除的資料：${unverified.joinToString("、")}"

    fun serverRejected(status: Int): String = when (status) {
        409 -> "伺服器拒絕：刪除比例異常"
        400 -> "伺服器不接受對帳（可能是舊版伺服器）"
        else -> "伺服器回應 HTTP $status"
    }

    const val NOT_REPORTED = "伺服器未回報對帳結果（可能是舊版伺服器）"
    const val PERMISSION_WINDOW = "讀取權限無法確保涵蓋整個範圍"
    const val READ_FAILED = "讀取 Health Connect 中斷，尚未完成核實"
    const val NO_READ_PERMISSION = "尚未授權讀取此類資料"
}
