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
 * many rows of a window the server refused (HTTP 409), together with that refusal's
 * [confirmDeleteToken] (the server's digest naming exactly those rows). The server then lifts its
 * automatic limits for this window only if the rows it would delete are still exactly that set
 * (same token, same count) and stay within [MAX_CONFIRMED_DELETES].
 */
data class ReconcileWindow(
    val dataType: String,
    val startMs: Long,
    val endMs: Long,
    val recordIds: List<String>,
    val confirmDeleteExpected: Int? = null,
    val confirmDeleteToken: String? = null,
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
        if (confirmDeleteExpected != null) {
            append(",\"confirmDelete\":{\"expected\":").append(confirmDeleteExpected)
            if (confirmDeleteToken != null) append(",\"token\":").append(JsonText.quote(confirmDeleteToken))
            append('}')
        }
        append('}')
    }

    companion object {
        /** The server's MAX_CONFIRMED_RECONCILE_DELETES: no confirmation lifts the limits beyond this. */
        const val MAX_CONFIRMED_DELETES = 2000

        private val TOKEN = Regex("[0-9a-f]{64}")
        private const val HEX = "0123456789abcdef"

        /** A well-formed server confirm token (lowercase hex SHA-256), or null. */
        fun cleanToken(token: String?): String? = token?.takeIf(TOKEN::matches)

        /**
         * A digest of the record ids the app listed for a window (sorted, so the read order does
         * not matter). Kept with a refusal instead of the ids, so a re-read before a confirmed
         * deletion can tell whether the phone's records are still exactly the same set.
         */
        fun idsDigest(recordIds: Collection<String>): String {
            val digest = java.security.MessageDigest.getInstance("SHA-256")
            for (id in recordIds.sorted()) {
                val bytes = id.toByteArray(Charsets.UTF_8)
                digest.update("${bytes.size}:".toByteArray(Charsets.UTF_8))
                digest.update(bytes)
            }
            return digest.digest().joinToString("") { byte ->
                val value = byte.toInt() and 0xff
                "${HEX[value shr 4]}${HEX[value and 0xf]}"
            }
        }
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
 * which source apps those rows came from; empty when the server did not report it. [confirmToken]
 * (servers from 0.4.4 on) is the server's digest naming exactly the rows it would delete; a
 * confirmed deletion must send it back. No record ids or values.
 */
data class ReconcileRefusal(
    val wouldDelete: Int,
    val checked: Int,
    val byOrigin: List<OriginCount> = emptyList(),
    val confirmToken: String? = null,
) {
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
            val token = ReconcileWindow.cleanToken(reconcile.optString("confirmToken").takeIf(String::isNotEmpty))
            return ReconcileRefusal(wouldDelete, checked, byOrigin, token)
        }
    }
}

/**
 * Turns the pages of one complete history read into reconcile windows, without holding every id
 * of a long history in memory. Pages must arrive in the read order (by start time, [ascending] or
 * descending). Each window lists every record starting inside it.
 *
 * Where a window is cut matters for records deleted at the source: the server only deletes an
 * unlisted row that starts in a window and ends before its end, so a deleted record lying across
 * an internal cut would belong to no window and stay on the server forever. A window is therefore
 * cut only at a time no record read so far lies across: at the latest end of the records on the
 * earlier side (at least just after their latest start), and only if that is no later than the
 * first record on the later side starts. A record deleted at the source between the two then
 * starts after the cut and is deleted by the later window. When no such time turns up (long,
 * overlapping records), the cut waits; if the window would then exceed [maxIds], or more than
 * [maxIds] records share one start time, reconciling this type stops for the rest of the read
 * (it stays unverified rather than risking a cut); [failure] then says why, and nothing more is
 * emitted.
 *
 * Descending reads see the earlier side only one record at a time, so their cut can only avoid
 * the records seen so far; a longer, earlier record may still lie across it (it is then kept,
 * never wrongly deleted).
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
    /** One record of the read: its id, start (the server's start_at) and end (its end_at; the start for an instant). */
    data class Item(val id: String, val startMs: Long, val endMs: Long = startMs)

    var failure: String? = null
        private set

    private val pending = mutableListOf<String>()
    private var lastStart: Long? = null
    private var sharedStart = true

    /** Ascending: the latest end of the pending records (the earlier side of the next cut). */
    private var pendingMaxEnd = Long.MIN_VALUE
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
            val itemEnd = maxOf(item.endMs, item.startMs)
            if (last != null && item.startMs != last && pending.size >= targetIds) {
                val cut = cutBefore(item, itemEnd, last)
                if (cut != null) {
                    // Every record on the settled side of the cut has been seen, and none read lies across it.
                    completed += if (ascending) {
                        window(boundary, cut).also { boundary = cut }
                    } else {
                        window(cut, boundary).also { boundary = cut }
                    }
                    pending.clear()
                    pendingMaxEnd = Long.MIN_VALUE
                    sharedStart = true
                }
            }
            if (last != null && item.startMs != last && pending.isNotEmpty()) sharedStart = false
            pending += item.id
            if (ascending) pendingMaxEnd = maxOf(pendingMaxEnd, itemEnd)
            lastStart = item.startMs
            if (pending.size > maxIds) return fail(if (sharedStart) TOO_MANY_AT_ONCE else NO_SAFE_CUT, completed)
        }
        return completed
    }

    /**
     * Where to cut between the pending records and [item] (which starts at a different time than
     * [last], the latest pending start), or null when a record read so far would lie across it.
     */
    private fun cutBefore(item: Item, itemEnd: Long, last: Long): Long? = if (ascending) {
        // After every pending record ends (and strictly after the latest pending start), no later than item's start.
        maxOf(pendingMaxEnd, last + 1).takeIf { it <= item.startMs }
    } else {
        // item is the latest-starting record of the earlier side: cut where it ends, no later
        // than the earliest pending start.
        maxOf(itemEnd, item.startMs + 1).takeIf { it <= last }
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
        const val NO_SAFE_CUT = "紀錄彼此重疊過多，無法安全分段核實"
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

    /** Re-reading before a confirmed deletion found different records: nothing was sent. */
    const val CHANGED_BEFORE_CONFIRM = "確認後手機上的紀錄已有變動，未刪除任何資料；請按「重新核實」取得最新數字後再確認"

    /**
     * The server would now delete other rows than the user confirmed (a different count, or
     * [sameCount] but a different set of rows): nothing was deleted.
     */
    fun confirmMismatch(wouldDelete: Int, sameCount: Boolean = false): String = if (sameCount) {
        "伺服器上要刪除的紀錄已變動（仍是 $wouldDelete 筆，但不是你確認的那些），未刪除任何資料；請檢視最新來源分布後重新確認"
    } else {
        "伺服器實際要刪除的筆數已變為 $wouldDelete 筆，未刪除任何資料；請重新確認"
    }

    /** A refusal saved without the server's confirm token (an older server or app version). */
    const val CONFIRM_NEEDS_REVERIFY = "缺少伺服器的確認資訊（舊版紀錄），無法在此刪除；請先按「重新核實」取得最新內容"

    const val NOTHING_LEFT_TO_DELETE = "伺服器上已沒有要刪除的資料（可能先前已刪除）；正在核實其餘範圍"

    const val CONFIRM_UNSUPPORTED = "伺服器不接受確認刪除（可能是舊版伺服器），未刪除任何資料"

    /** The result line of a confirmed deletion, or null when the engine already reported it. */
    fun confirmOutcome(outcome: HealthSyncEngine.ConfirmOutcome): String? = when (outcome) {
        is HealthSyncEngine.ConfirmOutcome.Deleted -> null
        HealthSyncEngine.ConfirmOutcome.Outdated -> "提醒內容已更新，未刪除任何資料；請檢視最新數字後再確認"
        HealthSyncEngine.ConfirmOutcome.SourceChanged -> CHANGED_BEFORE_CONFIRM
        is HealthSyncEngine.ConfirmOutcome.CountChanged -> confirmMismatch(outcome.wouldDelete, outcome.sameCount)
        is HealthSyncEngine.ConfirmOutcome.NotAccepted -> outcome.reason
    }

    fun confirmedDeleted(deleted: Int): String = "已確認刪除 $deleted 筆；其餘範圍待重新核實"

    const val NOT_REPORTED = "伺服器未回報對帳結果（可能是舊版伺服器）"
    const val PERMISSION_WINDOW = "讀取權限無法確保涵蓋整個範圍"
    const val READ_FAILED = "讀取 Health Connect 中斷，尚未完成核實"
    const val NO_READ_PERMISSION = "尚未授權讀取此類資料"
}
