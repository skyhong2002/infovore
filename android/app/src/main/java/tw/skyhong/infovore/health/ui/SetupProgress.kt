package tw.skyhong.infovore.health.ui

/** The three first-run steps shown at the top of the screen. */
enum class SetupStep(val title: String, val doneText: String, val todoText: String) {
    CONNECTION("設定連線", "Endpoint 與 token 已儲存", "填入 Infovore 網址與 HEALTH_CONNECT_TOKEN 後儲存"),
    PERMISSIONS("授權 Health Connect", "已授權讀取健康資料", "允許 Infovore 讀取 Health Connect 的健康資料"),
    FIRST_SYNC("完成第一次同步", "已完成首次匯入", "按「立即同步」匯入最近的健康資料"),
}

/** Whether Health Connect lets this app read in the background, which decides what happens after setup. */
enum class BackgroundSync { GRANTED, NOT_GRANTED, UNSUPPORTED, UNKNOWN }

enum class StepState { DONE, CURRENT, PENDING }

data class StepView(
    val step: SetupStep,
    val state: StepState,
    val background: BackgroundSync = BackgroundSync.UNKNOWN,
    val partialImport: Boolean = false,
) {
    val number: Int get() = step.ordinal + 1
    val text: String
        get() = when {
            step != SetupStep.FIRST_SYNC -> if (state == StepState.DONE) step.doneText else step.todoText
            state == StepState.DONE -> step.doneText + when (background) {
                BackgroundSync.GRANTED -> "；之後約每 6 小時在背景嘗試同步，實際時間受系統省電與網路影響"
                BackgroundSync.NOT_GRANTED -> "；尚未允許背景讀取，新資料要手動按「立即同步」，或到權限設定允許背景讀取"
                BackgroundSync.UNSUPPORTED -> "；這台裝置不支援背景讀取，新資料要手動按「立即同步」"
                BackgroundSync.UNKNOWN -> "；背景同步狀態要等 Health Connect 可用後才能確認"
            }
            partialImport -> "歷史資料已上傳，但首次同步還沒完整完成；按「立即同步」重試，已上傳的資料不會重複"
            else -> step.todoText
        }

    /** Spoken by TalkBack, e.g. "步驟 2，下一步：授權 Health Connect。允許…". */
    val accessibilityText: String
        get() {
            val stateText = when (state) {
                StepState.DONE -> "已完成"
                StepState.CURRENT -> "下一步"
                StepState.PENDING -> "尚未開始"
            }
            return "步驟 $number，$stateText：${step.title}。$text"
        }
}

object SetupProgress {
    fun compute(
        connectionSaved: Boolean,
        permissionsGranted: Boolean,
        firstSyncDone: Boolean,
        background: BackgroundSync = BackgroundSync.UNKNOWN,
        partialImport: Boolean = false,
    ): List<StepView> {
        val done = listOf(connectionSaved, permissionsGranted, firstSyncDone)
        val firstOpen = done.indexOfFirst { !it }
        return SetupStep.entries.mapIndexed { index, step ->
            val state = when {
                done[index] -> StepState.DONE
                index == firstOpen -> StepState.CURRENT
                else -> StepState.PENDING
            }
            StepView(step, state, background, partialImport && !firstSyncDone)
        }
    }

    fun nextStep(steps: List<StepView>): SetupStep? = steps.firstOrNull { it.state == StepState.CURRENT }?.step

    fun summary(steps: List<StepView>): String {
        val done = steps.count { it.state == StepState.DONE }
        return if (done == steps.size) "設定完成" else "已完成 $done / ${steps.size} 步"
    }
}
