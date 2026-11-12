package tw.skyhong.infovore.health

/**
 * A data type whose server rows in [startMs, endMs) could not be re-verified against Health
 * Connect (so rows deleted at the source may still be on the server). Holds no health values and
 * no record ids: only the type, the window, why, and when it was last tried.
 */
data class ReconcileGap(
    val dataType: String,
    val startMs: Long,
    val endMs: Long,
    val reason: String,
    val checkedAtMs: Long,
)

/**
 * The persisted list of [ReconcileGap]s, at most one per data type. A gap is added whenever a
 * reconcile pass of a type does not complete (refused by the server, not reported, an out-of-order
 * or interrupted read, or a window the read permission may not fully cover), and removed only
 * when a later reconcile pass of the same type completes over a window that covers it. Nothing
 * else (an incremental sync, a sleep-only sync) clears it.
 */
object ReconcileGaps {
    fun decode(text: String): List<ReconcileGap> = text.lineSequence().mapNotNull { line ->
        val parts = line.split('\t')
        if (parts.size != 5) return@mapNotNull null
        val start = parts[1].toLongOrNull() ?: return@mapNotNull null
        val end = parts[2].toLongOrNull() ?: return@mapNotNull null
        val checked = parts[3].toLongOrNull() ?: return@mapNotNull null
        if (parts[0].isEmpty() || start >= end) return@mapNotNull null
        ReconcileGap(parts[0], start, end, parts[4], checked)
    }.toList()

    fun encode(gaps: List<ReconcileGap>): String = gaps.joinToString("\n") { gap ->
        listOf(gap.dataType, gap.startMs, gap.endMs, gap.checkedAtMs, clean(gap.reason)).joinToString("\t")
    }

    /** Adds [gap]; an existing gap of the same type grows to cover both windows and takes the new reason. */
    fun record(gaps: List<ReconcileGap>, gap: ReconcileGap): List<ReconcileGap> {
        val existing = gaps.firstOrNull { it.dataType == gap.dataType }
        val merged = if (existing == null) gap else gap.copy(
            startMs = minOf(existing.startMs, gap.startMs),
            endMs = maxOf(existing.endMs, gap.endMs),
        )
        return (gaps.filterNot { it.dataType == gap.dataType } + merged).sortedBy { order(it.dataType) }
    }

    /** Removes the gap of [dataType] if a completed reconcile over [startMs, endMs) covers it. */
    fun verified(gaps: List<ReconcileGap>, dataType: String, startMs: Long, endMs: Long): List<ReconcileGap> =
        gaps.filterNot { it.dataType == dataType && startMs <= it.startMs && endMs >= it.endMs }

    private fun order(dataType: String): Int =
        HealthCatalog.all.indexOfFirst { it.key == dataType }.let { if (it < 0) Int.MAX_VALUE else it }

    private fun clean(reason: String) = reason.replace('\t', ' ').replace('\n', ' ').replace('\r', ' ')
}
