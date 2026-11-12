package tw.skyhong.infovore.health.screen

/**
 * When to warn that the quarantine of rejected screen records is filling up or full (uploads
 * stop at [ObservationQueue.MAX_REJECTED]). Android-free so it can be unit tested;
 * [ScreenUploadAlerts] applies the decision on the existing "同步問題" channel, only when the
 * user turned on "同步失敗時通知我" and granted POST_NOTIFICATIONS.
 *
 * One notification per step up ([Level.NEAR], then [Level.FULL]); nothing repeats while the
 * level stays the same, and the notification is removed once the user brought it back down.
 */
object QuarantineAlerts {
    /** Share of the limit at which the "almost full" warning is shown. */
    const val NEAR_PERCENT = 80

    enum class Level { NONE, NEAR, FULL }

    data class Decision(
        val level: Level,
        /** Show (or replace) the notification for [level]. */
        val notify: Boolean,
        /** Remove a notification shown for a higher level. */
        val clear: Boolean,
    )

    fun level(rejected: Int, maxRejected: Int): Level = when {
        maxRejected <= 0 || rejected >= maxRejected -> Level.FULL
        rejected.toLong() * 100 >= maxRejected.toLong() * NEAR_PERCENT -> Level.NEAR
        else -> Level.NONE
    }

    /** The count at which [Level.NEAR] starts. */
    fun nearThreshold(maxRejected: Int): Int = ((maxRejected.toLong() * NEAR_PERCENT + 99) / 100).toInt()

    fun next(previous: Level, rejected: Int, maxRejected: Int, notificationsEnabled: Boolean): Decision {
        val level = level(rejected, maxRejected)
        return Decision(
            level = level,
            notify = notificationsEnabled && level > previous,
            clear = level < previous,
        )
    }

    /** Notification texts: counts only, never screen content, app names or error details. */
    fun title(level: Level): String = when (level) {
        Level.FULL -> "Infovore 畫面紀錄已停止上傳"
        else -> "Infovore 被拒收的畫面紀錄接近上限"
    }

    fun text(level: Level, rejected: Int, maxRejected: Int, pending: Int): String = when (level) {
        Level.FULL ->
            "被伺服器拒收的畫面紀錄已達上限 $maxRejected 筆，上傳已停止；目前有 $pending 筆待傳。" +
                "停止期間待傳紀錄不會因超過 7 天而刪除，但總量超過 40 MB 時仍會刪除最舊的紀錄。點此開啟 App 處理。"
        else ->
            "被伺服器拒收的畫面紀錄已有 $rejected 筆（上限 $maxRejected 筆）；達到上限後會停止上傳。點此開啟 App 查看。"
    }
}

/**
 * A period during which uploads to one destination (its queue [bucket]) were stopped by a full
 * quarantine. Time inside the hold does not count toward that bucket's seven-day limit, so
 * records waiting only because uploads were stopped are not dropped for their age; once the hold
 * ends ([untilMs]) they get the rest of their seven days to upload. The 40 MB cap still applies.
 */
data class AgeHold(val bucket: String, val sinceMs: Long, val untilMs: Long? = null) {
    fun encode(): String = "$bucket $sinceMs ${untilMs ?: "-"}"

    companion object {
        fun decode(text: String?): AgeHold? {
            val parts = text?.trim()?.split(' ') ?: return null
            if (parts.size != 3 || parts[0].isEmpty()) return null
            val since = parts[1].toLongOrNull() ?: return null
            val until = if (parts[2] == "-") null else parts[2].toLongOrNull() ?: return null
            if (until != null && until < since) return null
            return AgeHold(parts[0], since, until)
        }
    }
}

/** The queue's seven-day rule, with [AgeHold] applied. Android-free and unit tested. */
object QueueRetention {
    /** How long [capturedAtMs] has counted toward [maxAgeMs]: its age minus any time spent inside [hold]. */
    fun countedAge(capturedAtMs: Long, nowMs: Long, hold: AgeHold?): Long {
        val age = nowMs - capturedAtMs
        if (hold == null) return age
        val holdEnd = minOf(hold.untilMs ?: nowMs, nowMs)
        val overlap = (holdEnd - maxOf(capturedAtMs, hold.sinceMs)).coerceAtLeast(0)
        return age - overlap
    }

    fun isStale(capturedAtMs: Long, nowMs: Long, hold: AgeHold?, maxAgeMs: Long = ObservationQueue.MAX_AGE_MS): Boolean =
        countedAge(capturedAtMs, nowMs, hold) > maxAgeMs

    /**
     * The hold after a prune that saw the quarantine [full] (or not) while [bucket] was the
     * current destination's bucket (null when unknown: the hold is kept as it is).
     */
    fun nextHold(
        previous: AgeHold?,
        bucket: String?,
        full: Boolean,
        nowMs: Long,
        maxAgeMs: Long = ObservationQueue.MAX_AGE_MS,
    ): AgeHold? {
        if (bucket == null) return previous
        val open = previous?.takeIf { it.untilMs == null }
        return when {
            full && open != null && open.bucket == bucket -> open
            // Full again for the same destination: continue the earlier hold (the time in between
            // counts as held too) rather than give up the credit records already had.
            full && previous != null && previous.bucket == bucket && previous.untilMs != null &&
                nowMs - previous.untilMs <= maxAgeMs -> previous.copy(untilMs = null)
            // Starts now; for a destination that changed meanwhile the old bucket's records are no
            // longer uploaded anyway, so they go back to the normal rule.
            full -> AgeHold(bucket, nowMs)
            open != null -> open.copy(untilMs = nowMs)
            // Once a whole seven days have passed since the hold ended, no record benefits from it.
            previous?.untilMs != null && nowMs - previous.untilMs > maxAgeMs -> null
            else -> previous
        }
    }
}
