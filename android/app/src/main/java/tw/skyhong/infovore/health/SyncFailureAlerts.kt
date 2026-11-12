package tw.skyhong.infovore.health

/**
 * When to warn that background syncs keep failing. Android-free so it can be unit tested;
 * [SyncFailureNotifier] applies the decision.
 *
 * Only a background run that WorkManager gives up on counts (its in-run retries do not), so
 * [THRESHOLD] consecutive failures span about 18 hours of the six-hourly schedule: well before
 * the public page reports the data as stale after 36 hours. Any successful full sync, manual or
 * background, resets the count and removes the notification.
 *
 * A warning counts as delivered only when it was posted while the system would show it (the
 * permission, Infovore's notifications and the "同步問題" channel all on, see [delivery]); one
 * that could not be shown is delivered once they are on again ([catchUp]).
 */
object SyncFailureAlerts {
    const val THRESHOLD = 3

    /** Hours between periodic background syncs (see [SyncScheduler]). */
    const val PERIOD_HOURS = 6

    enum class Outcome {
        SUCCESS,

        /** Failed, but WorkManager retries this run; not counted yet. */
        RETRY,

        /** Failed and WorkManager will not retry until the next period. */
        FINAL_FAILURE,
    }

    data class Decision(
        val failures: Int,
        /** Show (or update) the notification. */
        val notify: Boolean,
        /** Remove any notification shown earlier. */
        val clear: Boolean,
    )

    fun next(previousFailures: Int, outcome: Outcome, notificationsEnabled: Boolean): Decision = when (outcome) {
        Outcome.SUCCESS -> Decision(failures = 0, notify = false, clear = true)
        Outcome.RETRY -> Decision(failures = previousFailures, notify = false, clear = false)
        Outcome.FINAL_FAILURE -> {
            val failures = previousFailures.coerceAtLeast(0) + 1
            Decision(failures = failures, notify = notificationsEnabled && failures >= THRESHOLD, clear = false)
        }
    }

    /**
     * When notifications were turned on (the opt-in, or the permission granted) or may have been
     * unblocked in system settings (the app came back to the foreground): whether the failures
     * already counted call for the warning now, instead of only at the next failed run. A warning
     * already delivered ([notified]) is not repeated.
     */
    fun catchUp(failures: Int, notificationsEnabled: Boolean, notified: Boolean = false): Boolean =
        notificationsEnabled && failures >= THRESHOLD && !notified

    /** Whether a notification on the "同步問題" channel would actually be shown. */
    enum class Delivery {
        SHOWN,

        /** POST_NOTIFICATIONS is not granted. */
        NO_PERMISSION,

        /** The user turned off all of Infovore's notifications in system settings. */
        APP_BLOCKED,

        /** The user turned off only the "同步問題" channel in system settings. */
        CHANNEL_BLOCKED,
        ;

        val shown: Boolean get() = this == SHOWN
    }

    /**
     * [channelBlocked]: the channel exists with importance NONE. A channel not created yet is
     * created at its default importance when the first notification is posted, so it does not block.
     */
    fun delivery(permission: Boolean, appEnabled: Boolean, channelBlocked: Boolean): Delivery = when {
        !permission -> Delivery.NO_PERMISSION
        !appEnabled -> Delivery.APP_BLOCKED
        channelBlocked -> Delivery.CHANNEL_BLOCKED
        else -> Delivery.SHOWN
    }

    /** Whether a failed attempt (0-based [runAttemptCount]) is the last one WorkManager runs this period. */
    fun isFinalAttempt(runAttemptCount: Int): Boolean = runAttemptCount >= MAX_RETRIES

    /** Background attempts retried within one period before giving up (see [SyncWorker]). */
    const val MAX_RETRIES = 4

    /** Notification text: counts only, never health values, error details or tokens. */
    fun title(): String = "Infovore 健康資料背景同步失敗"

    fun text(failures: Int): String =
        "背景同步已連續失敗 $failures 次（約 ${failures * PERIOD_HOURS} 小時沒有成功）。點此開啟 App 查看原因並重試。"
}
