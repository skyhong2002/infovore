package tw.skyhong.infovore.health

import org.json.JSONObject
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
 *
 * [confirmDeleteExpected] is set only after the user explicitly confirmed deleting exactly that
 * many rows of a window the server refused (HTTP 409); the server then lifts its automatic limits
 * for this window only if the count matches exactly and stays within [MAX_CONFIRMED_DELETES].
 */
data class ReconcileWindow(
    val dataType: String,
    val startMs: Long,
    val endMs: Long,
    val recordIds: List<String>,
    val confirmDeleteExpected: Int? = null,
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
        append(']')
        if (confirmDeleteExpected != null) append(",\"confirmDelete\":{\"expected\":").append(confirmDeleteExpected).append('}')
        append('}')
    }

    companion object {
        /** The server's MAX_CONFIRMED_RECONCILE_DELETES: no confirmation lifts the limits beyond this. */
        const val MAX_CONFIRMED_DELETES = 2000
    }
}

/**
 * How many of the rows a refused window would delete came from one source app ([origin] is the
 * Health Connect data origin, a package name, or [OTHER] for the server's merged remainder).
 */
data class OriginCount(val origin: String, val count: Int) {
    companion object {
        const val OTHER = "other"

        /** The server lists at most 10 apps plus [OTHER]; anything beyond is ignored. */
        const val MAX_ENTRIES = 11
        private const val MAX_ORIGIN_CHARS = 200
        private val UNSAFE = Regex("[^A-Za-z0-9._-]")

        /** Keeps package-name characters only, so the value is safe to persist and show. */
        fun clean(origin: String): String = UNSAFE.replace(origin.take(MAX_ORIGIN_CHARS), "_")
    }
}

/**
 * The counts of a reconcile window the server refused with HTTP 409 (its response's
 * `reconcile.wouldDelete` / `reconcile.checked`): it would have deleted [wouldDelete] of the
 * [checked] rows this device has stored in the window. [byOrigin] (servers from 0.4.3 on) says
 * which source apps those rows came from; empty when the server did not report it. No record ids
 * or values.
 */
data class ReconcileRefusal(val wouldDelete: Int, val checked: Int, val byOrigin: List<OriginCount> = emptyList()) {
    companion object {
        /** The refusal in an HTTP [status] response body, or null when it is not a reconcile refusal. */
        fun fromResponse(status: Int, responseText: String): ReconcileRefusal? {
            if (status != 409) return null
            val reconcile = runCatching { JSONObject(responseText).optJSONObject("reconcile") }.getOrNull() ?: return null
            if (reconcile.optString("status") != "rejected") return null
            val wouldDelete = reconcile.optInt("wouldDelete", -1)
            val checked = reconcile.optInt("checked", -1)
            if (wouldDelete < 0 || checked < 0) return null
            val origins = reconcile.optJSONArray("byOrigin")
            val byOrigin = buildList {
                if (origins != null) {
                    for (index in 0 until origins.length()) {
                        if (size >= OriginCount.MAX_ENTRIES) break
                        val entry = origins.optJSONObject(index) ?: continue
                        val origin = OriginCount.clean(entry.optString("origin"))
                        val count = entry.optInt("count", -1)
                        if (origin.isNotEmpty() && count > 0) add(OriginCount(origin, count))
                    }
                }
            }
            return ReconcileRefusal(wouldDelete, checked, byOrigin)
        }
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

    /** Re-reading before a confirmed deletion found a different number of records: nothing was sent. */
    const val CHANGED_BEFORE_CONFIRM = "確認後手機上的紀錄已有變動，未刪除任何資料；請按「重新核實」取得最新數字後再確認"

    /** The server counted a different number than the user confirmed: nothing was deleted. */
    fun confirmMismatch(wouldDelete: Int): String = "伺服器實際要刪除的筆數已變為 $wouldDelete 筆，未刪除任何資料；請重新確認"

    const val NOTHING_LEFT_TO_DELETE = "伺服器上已沒有要刪除的資料（可能先前已刪除）；正在核實其餘範圍"

    const val CONFIRM_UNSUPPORTED = "伺服器不接受確認刪除（可能是舊版伺服器），未刪除任何資料"

    /** The result line of a confirmed deletion, or null when the engine already reported it. */
    fun confirmOutcome(outcome: HealthSyncEngine.ConfirmOutcome): String? = when (outcome) {
        is HealthSyncEngine.ConfirmOutcome.Deleted -> null
        HealthSyncEngine.ConfirmOutcome.Outdated -> "提醒內容已更新，未刪除任何資料；請檢視最新數字後再確認"
        HealthSyncEngine.ConfirmOutcome.SourceChanged -> CHANGED_BEFORE_CONFIRM
        is HealthSyncEngine.ConfirmOutcome.CountChanged -> confirmMismatch(outcome.wouldDelete)
        is HealthSyncEngine.ConfirmOutcome.NotAccepted -> outcome.reason
    }

    fun confirmedDeleted(deleted: Int): String = "已確認刪除 $deleted 筆；其餘範圍待重新核實"

    const val NOT_REPORTED = "伺服器未回報對帳結果（可能是舊版伺服器）"
    const val PERMISSION_WINDOW = "讀取權限無法確保涵蓋整個範圍"
    const val READ_FAILED = "讀取 Health Connect 中斷，尚未完成核實"
    const val NO_READ_PERMISSION = "尚未授權讀取此類資料"
}
