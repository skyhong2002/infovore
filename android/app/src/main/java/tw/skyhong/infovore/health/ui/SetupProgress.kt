package tw.skyhong.infovore.health.ui

/** The three first-run steps shown at the top of the screen. */
enum class SetupStep(val title: String, val doneText: String, val todoText: String) {
    CONNECTION("設定連線", "Endpoint 與 token 已儲存", "填入 Infovore 網址與 HEALTH_CONNECT_TOKEN 後儲存"),
    PERMISSIONS("授權 Health Connect", "已授權讀取健康資料", "允許 Infovore 讀取 Health Connect 的健康資料"),
    FIRST_SYNC("完成第一次同步", "已完成首次匯入，之後每 6 小時自動檢查", "按「立即同步」匯入最近的健康資料"),
}

enum class StepState { DONE, CURRENT, PENDING }

data class StepView(val step: SetupStep, val state: StepState) {
    val number: Int get() = step.ordinal + 1
    val text: String get() = if (state == StepState.DONE) step.doneText else step.todoText

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
    fun compute(connectionSaved: Boolean, permissionsGranted: Boolean, firstSyncDone: Boolean): List<StepView> {
        val done = listOf(connectionSaved, permissionsGranted, firstSyncDone)
        val firstOpen = done.indexOfFirst { !it }
        return SetupStep.entries.mapIndexed { index, step ->
            val state = when {
                done[index] -> StepState.DONE
                index == firstOpen -> StepState.CURRENT
                else -> StepState.PENDING
            }
            StepView(step, state)
        }
    }

    fun nextStep(steps: List<StepView>): SetupStep? = steps.firstOrNull { it.state == StepState.CURRENT }?.step

    fun summary(steps: List<StepView>): String {
        val done = steps.count { it.state == StepState.DONE }
        return if (done == steps.size) "設定完成" else "已完成 $done / ${steps.size} 步"
    }
}
