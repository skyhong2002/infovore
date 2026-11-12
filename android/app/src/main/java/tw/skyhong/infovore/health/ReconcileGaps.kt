package tw.skyhong.infovore.health

/**
 * The window of one reconcile request the server refused with HTTP 409, and what it reported:
 * deleting [wouldDelete] of the [checked] rows this device has stored in [startMs, endMs).
 * [sentIds] is how many record ids the app listed for that window, so a later re-read can tell
 * whether the phone's records changed since. Counts only: no record ids, no health values.
 */
data class GapRefusal(
    val startMs: Long,
    val endMs: Long,
    val wouldDelete: Int,
    val checked: Int,
    val sentIds: Int,
)

/**
 * A data type whose server rows in [startMs, endMs) could not be re-verified against Health
 * Connect (so rows deleted at the source may still be on the server). Holds no health values and
 * no record ids: only the type, the window, why, when it was last tried and, when the server
 * refused a deletion as too large, that [refusal]'s counts. [dismissed]: the user chose to keep
 * the server's rows and hide this reminder; nothing was deleted.
 */
data class ReconcileGap(
    val dataType: String,
    val startMs: Long,
    val endMs: Long,
    val reason: String,
    val checkedAtMs: Long,
    val refusal: GapRefusal? = null,
    val dismissed: Boolean = false,
) {
    /** The user may confirm this refused deletion in the app (the server's hard ceiling allows it). */
    val confirmable: Boolean
        get() = !dismissed && refusal != null && refusal.wouldDelete in 1..ReconcileWindow.MAX_CONFIRMED_DELETES
}

/**
 * The persisted list of [ReconcileGap]s, at most one per data type. A gap is added whenever a
 * reconcile pass of a type does not complete (refused by the server, not reported, an out-of-order
 * or interrupted read, or a window the read permission may not fully cover), and removed only
 * when a later reconcile pass of the same type completes over a window that covers it. Nothing
 * else (an incremental sync, a sleep-only sync) clears it. Dismissing keeps it, marked as such.
 */
object ReconcileGaps {
    fun decode(text: String): List<ReconcileGap> = text.lineSequence().mapNotNull { line ->
        val parts = line.split('\t')
        // 5 fields up to 0.4.0; 0.4.1 appends the refusal (5 fields, empty when none) and the dismissed flag.
        if (parts.size != 5 && parts.size != 11) return@mapNotNull null
        val start = parts[1].toLongOrNull() ?: return@mapNotNull null
        val end = parts[2].toLongOrNull() ?: return@mapNotNull null
        val checked = parts[3].toLongOrNull() ?: return@mapNotNull null
        if (parts[0].isEmpty() || start >= end) return@mapNotNull null
        val refusal = if (parts.size == 11) refusal(parts.subList(5, 10)) else null
        ReconcileGap(parts[0], start, end, parts[4], checked, refusal, dismissed = parts.size == 11 && parts[10] == "1")
    }.toList()

    fun encode(gaps: List<ReconcileGap>): String = gaps.joinToString("\n") { gap ->
        val refusal = gap.refusal
        val refusalFields = if (refusal == null) {
            List(5) { "" }
        } else {
            listOf(refusal.startMs, refusal.endMs, refusal.wouldDelete, refusal.checked, refusal.sentIds).map(Any::toString)
        }
        (listOf(gap.dataType, gap.startMs, gap.endMs, gap.checkedAtMs, clean(gap.reason)).map(Any::toString) +
            refusalFields + (if (gap.dismissed) "1" else "0")).joinToString("\t")
    }

    /**
     * Adds [gap]; an existing gap of the same type grows to cover both windows and takes the new
     * reason and refusal. A dismissed gap stays dismissed only when the server refused the very
     * same deletion again (same counts, inside the dismissed window); anything new shows again.
     */
    fun record(gaps: List<ReconcileGap>, gap: ReconcileGap): List<ReconcileGap> {
        val existing = gaps.firstOrNull { it.dataType == gap.dataType }
        val merged = if (existing == null) gap else gap.copy(
            startMs = minOf(existing.startMs, gap.startMs),
            endMs = maxOf(existing.endMs, gap.endMs),
            dismissed = existing.dismissed && sameRefusalAgain(existing, gap),
        )
        return (gaps.filterNot { it.dataType == gap.dataType } + merged).sortedBy { order(it.dataType) }
    }

    /** Removes the gap of [dataType] if a completed reconcile over [startMs, endMs) covers it. */
    fun verified(gaps: List<ReconcileGap>, dataType: String, startMs: Long, endMs: Long): List<ReconcileGap> =
        gaps.filterNot { it.dataType == dataType && startMs <= it.startMs && endMs >= it.endMs }

    /** Replaces the gap of [dataType] (if any) with [change] applied. */
    fun update(gaps: List<ReconcileGap>, dataType: String, change: (ReconcileGap) -> ReconcileGap): List<ReconcileGap> =
        gaps.map { if (it.dataType == dataType) change(it) else it }

    /** "Keep the server's rows and ignore this reminder": marks the gap dismissed. Deletes nothing. */
    fun dismiss(gaps: List<ReconcileGap>, dataType: String): List<ReconcileGap> = update(gaps, dataType) { it.copy(dismissed = true) }

    /** Shows a dismissed reminder again. */
    fun restore(gaps: List<ReconcileGap>, dataType: String): List<ReconcileGap> = update(gaps, dataType) { it.copy(dismissed = false) }

    private fun sameRefusalAgain(existing: ReconcileGap, gap: ReconcileGap): Boolean {
        val old = existing.refusal ?: return false
        val new = gap.refusal ?: return false
        return gap.startMs >= existing.startMs && gap.endMs <= existing.endMs &&
            old.wouldDelete == new.wouldDelete && old.checked == new.checked
    }

    private fun refusal(fields: List<String>): GapRefusal? {
        if (fields.all(String::isEmpty)) return null
        val start = fields[0].toLongOrNull() ?: return null
        val end = fields[1].toLongOrNull() ?: return null
        val wouldDelete = fields[2].toIntOrNull() ?: return null
        val checked = fields[3].toIntOrNull() ?: return null
        val sentIds = fields[4].toIntOrNull() ?: return null
        if (start >= end || wouldDelete < 0 || checked < 0 || sentIds < 0) return null
        return GapRefusal(start, end, wouldDelete, checked, sentIds)
    }

    private fun order(dataType: String): Int =
        HealthCatalog.all.indexOfFirst { it.key == dataType }.let { if (it < 0) Int.MAX_VALUE else it }

    private fun clean(reason: String) = reason.replace('\t', ' ').replace('\n', ' ').replace('\r', ' ')
}
