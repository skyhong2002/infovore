package tw.skyhong.infovore.health.screen

/**
 * Running totals of the queued screen records [ObservationQueue] deleted on its own before they
 * could be uploaded: older than seven days ([expired]) or the oldest beyond the 40 MB cap
 * ([overCapacity]), with when each last happened. Counts and times only, never record content,
 * app names or destinations. Kept until the user confirms they have seen it ([ObservationQueue.resetDropLog]);
 * uploads never clear it. Android-free so it can be unit tested.
 */
data class DropLog(
    val expired: Long = 0,
    val overCapacity: Long = 0,
    val lastExpiredMs: Long? = null,
    val lastCapacityMs: Long? = null,
) {
    val total: Long get() = expired + overCapacity

    val isEmpty: Boolean get() = total == 0L

    /** When records were last dropped for either reason; null when none were. */
    val lastMs: Long? get() = listOfNotNull(lastExpiredMs, lastCapacityMs).maxOrNull()

    /** Adds one prune's drops at [nowMs]. */
    fun add(expired: Int, overCapacity: Int, nowMs: Long): DropLog = copy(
        expired = this.expired + expired.coerceAtLeast(0),
        overCapacity = this.overCapacity + overCapacity.coerceAtLeast(0),
        lastExpiredMs = if (expired > 0) nowMs else lastExpiredMs,
        lastCapacityMs = if (overCapacity > 0) nowMs else lastCapacityMs,
    )

    fun encode(): String = "$VERSION $expired $overCapacity ${lastExpiredMs ?: "-"} ${lastCapacityMs ?: "-"}"

    companion object {
        private const val VERSION = "v1"

        /** Unreadable or missing text reads as nothing dropped. */
        fun decode(text: String?): DropLog {
            val parts = text?.trim()?.split(' ') ?: return DropLog()
            if (parts.size != 5 || parts[0] != VERSION) return DropLog()
            val expired = parts[1].toLongOrNull()?.takeIf { it >= 0 } ?: return DropLog()
            val capacity = parts[2].toLongOrNull()?.takeIf { it >= 0 } ?: return DropLog()
            fun time(value: String): Long? = if (value == "-") null else value.toLongOrNull()?.takeIf { it > 0 }
            return DropLog(
                expired = expired,
                overCapacity = capacity,
                lastExpiredMs = time(parts[3]).takeIf { expired > 0 },
                lastCapacityMs = time(parts[4]).takeIf { capacity > 0 },
            )
        }
    }
}
