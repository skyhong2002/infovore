package tw.skyhong.infovore.health.ui

import tw.skyhong.infovore.health.screen.ObservationQueue
import tw.skyhong.infovore.health.screen.QuarantineAlerts
import java.time.Instant
import java.time.ZoneId

data class ScreenInputs(
    val recordingEnabled: Boolean,
    val pausedUntilMs: Long,
    val serviceEnabled: Boolean,
    val tokenConfigured: Boolean,
    /** Queued for the current sync destination. */
    val pending: Int,
    val lastCaptureAtMs: Long,
    val lastUploadStatus: String,
    val nowMs: Long,
    val zone: ZoneId,
    val use24Hour: Boolean = true,
    /** Queued for a previous (or unknown) destination; never uploaded automatically. */
    val otherDestinationPending: Int = 0,
    /** Rejected by the server (HTTP 400) and quarantined; never uploaded or deleted automatically. */
    val rejected: Int = 0,
    /** Of [rejected], how many may be put back into the current destination's queue. */
    val requeueable: Int = 0,
    /** Quarantine size at which uploads stop until the user deals with it. */
    val maxRejected: Int = ObservationQueue.MAX_REJECTED,
    /** "同步失敗時通知我" is on and POST_NOTIFICATIONS granted: quarantine warnings reach the user in the background. */
    val notificationsOn: Boolean = true,
)

enum class ScreenState { OFF, NEEDS_SERVICE, PAUSED, RECORDING }

data class ScreenUi(
    val state: ScreenState,
    /** Short status for the collapsed section header. */
    val summary: String,
    val headline: String,
    val tone: Tone,
    /** What the user should do next, or null when nothing is required. */
    val nextStep: String?,
    val details: String,
    val pauseLabel: String,
    val pauseEnabled: Boolean,
    val uploadEnabled: Boolean,
    val uploadHint: String?,
    /** Explains records left from an earlier destination, or null when there are none. */
    val otherDestinationNote: String? = null,
    /** Explains quarantined records the server rejected, or null when there are none. */
    val rejectedNote: String? = null,
    /** Label of "put back into the queue", or null when no quarantined record can go back. */
    val requeueLabel: String? = null,
    /** The quarantine is full: uploads are stopped until the user requeues or deletes records. */
    val quarantineFull: Boolean = false,
    /**
     * The quarantine is nearly or completely full while notifications are off: suggests turning
     * them on, so the next warning also reaches the user in the background. Null otherwise.
     */
    val notificationHint: String? = null,
)

/** Maps phone screen-recording settings to UI text. Never changes any setting itself. */
object ScreenStatus {
    const val QUARANTINE_FULL_STEP =
        "被拒收的畫面紀錄已達上限 %d 筆，已停止上傳。被拒收的紀錄不會自動刪除；停止上傳期間，目前目的地的待傳紀錄也不會因超過 7 天而刪除（停止的時間不計入 7 天），但待傳佇列超出 40 MB 容量時仍會刪除最舊的紀錄。請放回佇列重送或刪除被拒收的紀錄，讓上傳繼續。"

    const val NOTIFICATION_HINT =
        "「同步失敗時通知我」目前關閉，所以 App 不在前景時不會提醒這個狀態。建議到「健康資料同步」區塊開啟它：被拒收的紀錄接近或達到上限時會發出通知（只含筆數，不含畫面內容）。"

    private fun rejectedNote(input: ScreenInputs, full: Boolean): String = buildString {
        append(input.rejected).append(" 筆畫面紀錄被伺服器拒收（HTTP 400，格式不被接受）。它們已移出上傳佇列，不會自動再送出，")
        append("也不會自動刪除。")
        if (full) {
            append("已達上限 ").append(input.maxRejected).append(" 筆：上傳已停止，處理後才會繼續。")
            append("停止期間，目前目的地的待傳紀錄不會因超過 7 天而刪除，但待傳佇列超出 40 MB 時仍會刪除最舊的紀錄。")
        } else if (QuarantineAlerts.level(input.rejected, input.maxRejected) == QuarantineAlerts.Level.NEAR) {
            append("已接近上限：達 ").append(input.maxRejected).append(" 筆時會停止上傳，請儘早處理。")
        } else {
            append("其他紀錄照常上傳；達 ").append(input.maxRejected).append(" 筆時會停止上傳。")
        }
        val stuck = input.rejected - input.requeueable
        when {
            input.requeueable == 0 -> append("它們不屬於目前的目的地或已超過 7 天，無法放回佇列，只能刪除。")
            stuck > 0 -> append("其中 ").append(input.requeueable).append(" 筆可放回目前目的地的佇列重送；")
                .append(stuck).append(" 筆屬於其他目的地或已超過 7 天，只能刪除。")
            else -> append("如伺服器端問題已修正，可放回佇列重送；確認不需要後也可刪除。")
        }
    }

    fun map(input: ScreenInputs): ScreenUi {
        val now = Instant.ofEpochMilli(input.nowMs)
        val paused = input.pausedUntilMs > input.nowMs
        val state = when {
            !input.recordingEnabled -> ScreenState.OFF
            !input.serviceEnabled -> ScreenState.NEEDS_SERVICE
            paused -> ScreenState.PAUSED
            else -> ScreenState.RECORDING
        }
        val quarantineLevel = QuarantineAlerts.level(input.rejected, input.maxRejected)
        val quarantineFull = quarantineLevel == QuarantineAlerts.Level.FULL
        val pausedUntil = Instant.ofEpochMilli(input.pausedUntilMs)
        val headline = when (state) {
            ScreenState.OFF -> "記錄已關閉"
            ScreenState.NEEDS_SERVICE -> "已啟用，但無障礙服務尚未開啟，目前沒有記錄"
            ScreenState.PAUSED ->
                "已暫停至 ${TimeText.clock(pausedUntil, input.zone, input.use24Hour)}（${TimeText.relative(pausedUntil, now)}恢復）"
            ScreenState.RECORDING -> "記錄中（螢幕開啟且解鎖時）"
        }
        val tone = when (state) {
            ScreenState.OFF -> Tone.NEUTRAL
            ScreenState.NEEDS_SERVICE -> Tone.WARNING
            ScreenState.PAUSED -> Tone.NEUTRAL
            ScreenState.RECORDING -> if (input.tokenConfigured && !quarantineFull) Tone.OK else Tone.WARNING
        }
        val nextStep = when {
            !input.recordingEnabled && !input.serviceEnabled ->
                "如要使用：先儲存 DAYFLOW_PHONE_TOKEN，再到無障礙設定開啟「Infovore 手機 Dayflow」，最後在此啟用記錄。"
            !input.recordingEnabled -> "無障礙服務已開啟，但記錄仍關閉；不使用時建議也關閉無障礙服務。"
            !input.serviceEnabled -> "請按「開啟無障礙設定」並開啟「Infovore 手機 Dayflow」。側載安裝需先允許受限制的設定。"
            !input.tokenConfigured -> "尚未儲存 DAYFLOW_PHONE_TOKEN，紀錄會留在手機佇列，無法上傳。"
            quarantineFull -> QUARANTINE_FULL_STEP.format(input.maxRejected)
            else -> null
        }
        val lastCapture = if (input.lastCaptureAtMs > 0) {
            TimeText.friendly(Instant.ofEpochMilli(input.lastCaptureAtMs), now, input.zone, input.use24Hour)
        } else {
            "尚未擷取"
        }
        val details = buildString {
            append("最後擷取：").append(lastCapture)
            append("\n佇列中：").append(input.pending).append(" 筆待上傳")
            append("\n最後上傳：").append(TimeText.humanizeStatus(input.lastUploadStatus, now, input.zone, input.use24Hour))
            if (input.otherDestinationPending > 0) {
                append("\n舊目的地：").append(input.otherDestinationPending).append(" 筆（不會上傳）")
            }
            if (input.rejected > 0) {
                append("\n被拒收：").append(input.rejected).append(" 筆（已隔離，不會上傳）")
            }
        }
        val summary = when (state) {
            ScreenState.OFF -> "關閉"
            ScreenState.NEEDS_SERVICE -> "等待開啟無障礙服務"
            ScreenState.PAUSED -> "已暫停"
            ScreenState.RECORDING -> "記錄中"
        } + when (quarantineLevel) {
            // Visible on the collapsed header, without opening the section.
            QuarantineAlerts.Level.FULL -> " · 上傳已停止"
            QuarantineAlerts.Level.NEAR -> " · 被拒收 ${input.rejected} 筆"
            QuarantineAlerts.Level.NONE -> ""
        } + if (input.pending > 0) " · 佇列 ${input.pending} 筆" else ""
        val uploadHint = when {
            !input.tokenConfigured -> "需先儲存 DAYFLOW_PHONE_TOKEN"
            quarantineFull -> "被拒收的紀錄已達上限 ${input.maxRejected} 筆，已停止上傳"
            input.pending == 0 -> "佇列中沒有待上傳的紀錄"
            else -> null
        }
        return ScreenUi(
            state = state,
            summary = summary,
            headline = headline,
            tone = tone,
            nextStep = nextStep,
            details = details,
            pauseLabel = if (paused) "恢復記錄" else "暫停 1 小時",
            pauseEnabled = input.recordingEnabled,
            uploadEnabled = input.tokenConfigured && input.pending > 0 && !quarantineFull,
            uploadHint = uploadHint,
            otherDestinationNote = if (input.otherDestinationPending > 0) {
                "${input.otherDestinationPending} 筆待傳紀錄屬於舊目的地（變更同步目的地前，或 0.3.2 版以前擷取），" +
                    "不會送到目前的目的地。不需要時可刪除。"
            } else {
                null
            },
            rejectedNote = if (input.rejected > 0) rejectedNote(input, quarantineFull) else null,
            requeueLabel = if (input.requeueable > 0) "放回佇列重送（${input.requeueable} 筆）" else null,
            quarantineFull = quarantineFull,
            notificationHint = if (quarantineLevel != QuarantineAlerts.Level.NONE && !input.notificationsOn) NOTIFICATION_HINT else null,
        )
    }
}
