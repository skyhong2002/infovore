package tw.skyhong.infovore.health

/**
 * The window of one reconcile request the server refused with HTTP 409, and what it reported:
 * deleting [wouldDelete] of the [checked] rows this device has stored in [startMs, endMs).
 * [sentIds] is how many record ids the app listed for that window, so a later re-read can tell
 * whether the phone's records changed since. [byOrigin]: which source apps the rows to delete
 * came from, when the server reported it (0.4.3+). [confirmToken] (0.4.4+): the server's digest
 * naming exactly the rows it would delete, sent back with a confirmation. [idsDigest] (0.4.4+):
 * [ReconcileWindow.idsDigest] of the ids the app listed, so a re-read can tell whether the phone
 * still has exactly the same set (not only the same number). Counts, package names and digests
 * only: no record ids, no health values.
 */
data class GapRefusal(
    val startMs: Long,
    val endMs: Long,
    val wouldDelete: Int,
    val checked: Int,
    val sentIds: Int,
    val byOrigin: List<OriginCount> = emptyList(),
    val confirmToken: String? = null,
    val idsDigest: String? = null,
) {
    /** Saved with what a confirmation needs: the server's token and the digest of the ids sent. */
    val bound: Boolean get() = confirmToken != null && idsDigest != null
}

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
    /** Within the server's hard ceiling, so a confirmation could be accepted. */
    val withinCeiling: Boolean
        get() = refusal != null && refusal.wouldDelete in 1..ReconcileWindow.MAX_CONFIRMED_DELETES

    /**
     * The user may confirm this refused deletion in the app: within the server's hard ceiling and
     * saved with the server's token for exactly these rows (a refusal saved before 0.4.4 has none
     * and must be re-verified first).
     */
    val confirmable: Boolean
        get() = !dismissed && withinCeiling && refusal?.bound == true
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
        // 5 fields up to 0.4.0; 0.4.1 appends the refusal (5 fields, empty when none) and the
        // dismissed flag; 0.4.3 appends the refusal's source-app counts; 0.4.4 its confirm token
        // and the digest of the ids sent.
        if (parts.size != 5 && parts.size != 11 && parts.size != 12 && parts.size != 14) return@mapNotNull null
        val start = parts[1].toLongOrNull() ?: return@mapNotNull null
        val end = parts[2].toLongOrNull() ?: return@mapNotNull null
        val checked = parts[3].toLongOrNull() ?: return@mapNotNull null
        if (parts[0].isEmpty() || start >= end) return@mapNotNull null
        val refusal = if (parts.size >= 11) {
            refusal(parts.subList(5, 10))?.copy(
                byOrigin = origins(parts.getOrNull(11)),
                confirmToken = ReconcileWindow.cleanToken(parts.getOrNull(12)),
                idsDigest = ReconcileWindow.cleanToken(parts.getOrNull(13)),
            )
        } else {
            null
        }
        ReconcileGap(parts[0], start, end, parts[4], checked, refusal, dismissed = parts.size >= 11 && parts[10] == "1")
    }.toList()

    fun encode(gaps: List<ReconcileGap>): String = gaps.joinToString("\n") { gap ->
        val refusal = gap.refusal
        val refusalFields = if (refusal == null) {
            List(5) { "" }
        } else {
            listOf(refusal.startMs, refusal.endMs, refusal.wouldDelete, refusal.checked, refusal.sentIds).map(Any::toString)
        }
        val origins = refusal?.byOrigin.orEmpty().joinToString("|") { "${OriginCount.clean(it.origin)}=${it.count}" }
        val digests = listOf(
            ReconcileWindow.cleanToken(refusal?.confirmToken).orEmpty(),
            ReconcileWindow.cleanToken(refusal?.idsDigest).orEmpty(),
        )
        (listOf(gap.dataType, gap.startMs, gap.endMs, gap.checkedAtMs, clean(gap.reason)).map(Any::toString) +
            refusalFields + (if (gap.dismissed) "1" else "0") + origins + digests).joinToString("\t")
    }

    private fun origins(field: String?): List<OriginCount> = field.orEmpty().split('|').mapNotNull { entry ->
        val origin = entry.substringBefore('=', "")
        val count = entry.substringAfter('=', "").toIntOrNull()
        if (origin.isEmpty() || count == null || count <= 0) null else OriginCount(origin, count)
    }.take(OriginCount.MAX_ENTRIES)

    /**
     * Adds [gap]; an existing gap of the same type grows to cover both windows and takes the new
     * reason and refusal. A dismissed gap stays dismissed only when the server refused the very
     * same deletion again (same counts and the same confirm token, inside the dismissed window);
     * anything new shows again.
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
            old.wouldDelete == new.wouldDelete && old.checked == new.checked &&
            // A reminder dismissed before 0.4.4 has no token: its counts decide, as they did then.
            (old.confirmToken == null || old.confirmToken == new.confirmToken)
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
