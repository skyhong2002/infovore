package tw.skyhong.infovore.health.ui

import java.time.Instant
import java.time.ZoneId

data class ScreenInputs(
    val recordingEnabled: Boolean,
    val pausedUntilMs: Long,
    val serviceEnabled: Boolean,
    val tokenConfigured: Boolean,
    val pending: Int,
    val lastCaptureAtMs: Long,
    val lastUploadStatus: String,
    val nowMs: Long,
    val zone: ZoneId,
    val use24Hour: Boolean = true,
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
)

/** Maps phone screen-recording settings to UI text. Never changes any setting itself. */
object ScreenStatus {
    fun map(input: ScreenInputs): ScreenUi {
        val now = Instant.ofEpochMilli(input.nowMs)
        val paused = input.pausedUntilMs > input.nowMs
        val state = when {
            !input.recordingEnabled -> ScreenState.OFF
            !input.serviceEnabled -> ScreenState.NEEDS_SERVICE
            paused -> ScreenState.PAUSED
            else -> ScreenState.RECORDING
        }
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
            ScreenState.RECORDING -> if (input.tokenConfigured) Tone.OK else Tone.WARNING
        }
        val nextStep = when {
            !input.recordingEnabled && !input.serviceEnabled ->
                "如要使用：先儲存 DAYFLOW_PHONE_TOKEN，再到無障礙設定開啟「Infovore 手機 Dayflow」，最後在此啟用記錄。"
            !input.recordingEnabled -> "無障礙服務已開啟，但記錄仍關閉；不使用時建議也關閉無障礙服務。"
            !input.serviceEnabled -> "請按「開啟無障礙設定」並開啟「Infovore 手機 Dayflow」。側載安裝需先允許受限制的設定。"
            !input.tokenConfigured -> "尚未儲存 DAYFLOW_PHONE_TOKEN，紀錄會留在手機佇列，無法上傳。"
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
        }
        val summary = when (state) {
            ScreenState.OFF -> "關閉"
            ScreenState.NEEDS_SERVICE -> "等待開啟無障礙服務"
            ScreenState.PAUSED -> "已暫停"
            ScreenState.RECORDING -> "記錄中"
        } + if (input.pending > 0) " · 佇列 ${input.pending} 筆" else ""
        val uploadHint = when {
            !input.tokenConfigured -> "需先儲存 DAYFLOW_PHONE_TOKEN"
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
            uploadEnabled = input.tokenConfigured && input.pending > 0,
            uploadHint = uploadHint,
        )
    }
}
