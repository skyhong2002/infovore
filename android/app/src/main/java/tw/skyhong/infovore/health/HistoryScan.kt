package tw.skyhong.infovore.health

/**
 * Progress of an unfinished initial (or post-expiry) history scan, saved after each data type so
 * a scan interrupted by the system can resume instead of starting over. [changesToken] was taken
 * before the scan began and is only promoted to the real sync cursor once every type is done;
 * the window stays fixed, and changes after it are picked up through that token.
 */
data class HistoryScan(
    val changesToken: String,
    val startMs: Long,
    val endMs: Long,
    /** Normalised endpoint the scan uploads to; a scan never resumes against another destination. */
    val destination: String,
    val completed: Set<String> = emptySet(),
) {
    fun withCompleted(type: String) = copy(completed = completed + type)

    fun remaining(order: List<String>): List<String> = order.filterNot { it in completed }

    companion object {
        private const val DEFAULT_READ_DAYS = 30L
        private const val DAY_MS = 24L * 60 * 60 * 1000

        /**
         * Whether Health Connect is sure to return every record in a scan window starting at
         * [startMs], so deletions in it may be reconciled. Without the history permission an app
         * reads only from 30 days before its first permission grant. A fresh scan's window never
         * reaches further back than that (the grant came first), but a resumed one may: after a
         * revoke and re-grant, or once the history permission is gone. Those are only reconciled
         * when the window still lies within the last 30 days.
         */
        fun canReconcile(resumed: Boolean, historyPermission: Boolean, startMs: Long, nowMs: Long): Boolean =
            !resumed || historyPermission || startMs >= nowMs - DEFAULT_READ_DAYS * DAY_MS

        /** The saved scan if it can resume uploading to [destination], otherwise null. */
        fun resumable(saved: HistoryScan?, destination: String): HistoryScan? =
            saved?.takeIf { it.destination == destination && it.startMs < it.endMs }
    }
}
