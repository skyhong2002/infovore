package tw.skyhong.infovore.health.ui

import androidx.health.connect.client.HealthConnectClient

/** Health Connect availability as the UI needs it, mapped from [HealthConnectClient.getSdkStatus]. */
enum class HealthConnectAvailability {
    AVAILABLE,
    UPDATE_REQUIRED,
    UNAVAILABLE,
    ;

    companion object {
        fun fromSdkStatus(status: Int): HealthConnectAvailability = when (status) {
            HealthConnectClient.SDK_AVAILABLE -> AVAILABLE
            HealthConnectClient.SDK_UNAVAILABLE_PROVIDER_UPDATE_REQUIRED -> UPDATE_REQUIRED
            else -> UNAVAILABLE
        }
    }
}

/** The one button shown next to the Health Connect status. */
enum class HealthAction { NONE, INSTALL_OR_UPDATE, GRANT, MANAGE }

enum class Tone { NEUTRAL, OK, WARNING, ERROR }

/** Everything the health section renders, derived from plain inputs so it can be unit tested. */
data class HealthUi(
    val headline: String,
    val detail: String?,
    val tone: Tone,
    val action: HealthAction,
    val actionLabel: String?,
    val sleepEnabled: Boolean,
    val syncEnabled: Boolean,
    /** Why the sync buttons are disabled, or what to do next; null when there is nothing to add. */
    val syncHint: String?,
    /** All read permissions granted: what else is allowed ("背景約每 6 小時同步 · 可讀取完整歷史"); else null. */
    val grantedDetail: String? = null,
    /** The part of [grantedDetail] that names a gap (shown in the warning color), or null. */
    val grantedDetailGap: String? = null,
)

data class HealthInputs(
    /** null while the status is still being checked. */
    val availability: HealthConnectAvailability?,
    /** Granted Health Connect permissions; null until known. */
    val granted: Set<String>?,
    val requiredRead: Set<String>,
    val sleepPermission: String,
    val backgroundPermission: String,
    val historyPermission: String,
    /** Problem with the connection settings that blocks syncing, or null when they are usable. */
    val connectionProblem: String?,
    val syncing: Boolean,
    /** The periodic background sync is running; manual syncs wait for it. */
    val backgroundSyncRunning: Boolean = false,
    /** True after the user returned from the permission screen without granting anything new. */
    val permissionRequestHadNoEffect: Boolean = false,
    /** Set when reading the granted permissions failed. */
    val permissionError: String? = null,
    /** Whether this device's Health Connect offers background reading; null when unknown. */
    val backgroundSupported: Boolean? = null,
    /** Setup is still running: a permission not granted yet is a to-do, not a problem. */
    val firstRun: Boolean = false,
)

object HealthStatus {
    const val BACKGROUND_NOT_ALLOWED = "未允許背景讀取"

    /** A saved sleep status reports failure with this prefix (see HealthConnectSync.runSleep). */
    fun sleepStatusFailed(status: String): Boolean = TimeText.splitStatus(status).second.startsWith("睡眠未完成")

    /** The saved sleep status when the window had no sleep at all (shown as a warning). */
    const val SLEEP_EMPTY = "沒有找到睡眠紀錄"

    fun sleepStatusEmpty(status: String): Boolean = TimeText.splitStatus(status).second.startsWith(SLEEP_EMPTY)

    fun map(input: HealthInputs): HealthUi {
        val availability = input.availability
            ?: return blocked("正在檢查 Health Connect…", null, Tone.NEUTRAL, HealthAction.NONE, "正在檢查 Health Connect 狀態")
        when (availability) {
            HealthConnectAvailability.UPDATE_REQUIRED -> return blocked(
                headline = "Health Connect 需要安裝或更新",
                detail = "請安裝或更新 Health Connect 後回到這裡。Android 14 以上也可能需要先完成「Google Play 系統更新」。",
                tone = Tone.WARNING,
                action = HealthAction.INSTALL_OR_UPDATE,
                syncHint = "需先安裝或更新 Health Connect 才能同步",
            )
            HealthConnectAvailability.UNAVAILABLE -> return blocked(
                headline = "此裝置無法使用 Health Connect",
                detail = "這台裝置或目前的使用者設定檔不支援 Health Connect，因此無法同步健康資料。",
                tone = Tone.ERROR,
                action = HealthAction.NONE,
                syncHint = "此裝置不支援 Health Connect",
            )
            HealthConnectAvailability.AVAILABLE -> Unit
        }
        input.permissionError?.let { problem ->
            return blocked(
                headline = "無法讀取 Health Connect 權限",
                detail = "$problem\n可開啟 Health Connect 確認狀態後回到這裡。",
                tone = Tone.ERROR,
                action = HealthAction.MANAGE,
                syncHint = "需先確認 Health Connect 權限",
            )
        }
        val granted = input.granted
            ?: return blocked("正在讀取 Health Connect 權限…", null, Tone.NEUTRAL, HealthAction.NONE, "正在讀取權限")
        val missing = input.requiredRead - granted
        val sleepGranted = input.sleepPermission in granted
        val allGranted = missing.isEmpty()
        val background = input.backgroundPermission in granted
        val history = input.historyPermission in granted

        val headline: String
        val detail: String?
        val tone: Tone
        val action: HealthAction
        // What reading can do, then the background state; the history fact leads, as it never needs a fix.
        val historyText = if (history) "可讀取完整歷史" else "歷史最多 ${InputValidation.HISTORY_WITHOUT_PERMISSION_DAYS} 天"
        val grantedDetail = if (!allGranted) null else when {
            background -> "$historyText · 背景約每 6 小時同步"
            input.backgroundSupported == false -> "$historyText · 此裝置不支援背景讀取，需手動同步"
            else -> "$historyText · $BACKGROUND_NOT_ALLOWED"
        }
        val grantedDetailGap = if (allGranted && !background && input.backgroundSupported != false) BACKGROUND_NOT_ALLOWED else null
        when {
            allGranted && !background && input.backgroundSupported == true -> {
                headline = "未允許背景讀取"
                detail = "背景同步會被略過，新資料要手動同步。"
                tone = Tone.WARNING
                action = HealthAction.MANAGE
            }
            allGranted -> {
                headline = "Health Connect 已授權"
                detail = grantedDetail
                tone = Tone.OK
                action = HealthAction.MANAGE
            }
            granted.none { it in input.requiredRead } -> {
                headline = "尚未授權 Health Connect"
                detail = noEffectHint(input) ?: "需要讀取運動、步數、距離、卡路里、心率、睡眠、體重與體脂（僅讀取，不寫入）。"
                tone = if (input.firstRun && !input.permissionRequestHadNoEffect) Tone.NEUTRAL else Tone.WARNING
                action = if (input.permissionRequestHadNoEffect) HealthAction.MANAGE else HealthAction.GRANT
            }
            else -> {
                headline = "Health Connect 尚缺 ${missing.size} 項讀取權限"
                detail = noEffectHint(input)
                    ?: if (sleepGranted) "目前只能同步睡眠；完整同步需要全部 ${input.requiredRead.size} 項權限。" else "完整同步需要全部 ${input.requiredRead.size} 項權限。"
                tone = Tone.WARNING
                action = if (input.permissionRequestHadNoEffect) HealthAction.MANAGE else HealthAction.GRANT
            }
        }
        val actionLabel = when (action) {
            HealthAction.GRANT -> "授權 Health Connect"
            HealthAction.MANAGE -> when {
                allGranted && tone == Tone.WARNING -> "允許背景讀取"
                allGranted -> "管理權限"
                else -> "在 Health Connect 設定中授權"
            }
            else -> null
        }

        val connection = input.connectionProblem
        val syncHint = when {
            // Leaving the screen no longer cancels a sync, but without background read access
            // Health Connect itself refuses reads once the app is no longer in the foreground.
            input.syncing && background -> "同步進行中；離開此畫面也會繼續"
            input.syncing -> "同步進行中；尚未允許背景讀取，請保持此畫面開啟直到完成"
            input.backgroundSyncRunning -> "背景同步正在進行，完成後即可手動同步"
            connection != null -> connection
            !sleepGranted -> "請先授權 Health Connect 讀取睡眠等資料"
            !allGranted -> "「立即同步」需要全部讀取權限；目前可先只同步睡眠"
            else -> null
        }
        val ready = !input.syncing && !input.backgroundSyncRunning && connection == null
        return HealthUi(
            headline = headline,
            detail = detail,
            tone = tone,
            action = action,
            actionLabel = actionLabel,
            sleepEnabled = ready && sleepGranted,
            syncEnabled = ready && allGranted,
            syncHint = syncHint,
            grantedDetail = grantedDetail,
            grantedDetailGap = grantedDetailGap,
        )
    }

    private fun noEffectHint(input: HealthInputs): String? = if (input.permissionRequestHadNoEffect) {
        "沒有新增權限。若授權畫面沒有出現，可能是先前已拒絕過：請按「在 Health Connect 設定中授權」手動開啟 Infovore 的讀取權限。"
    } else {
        null
    }

    private fun blocked(headline: String, detail: String?, tone: Tone, action: HealthAction, syncHint: String) = HealthUi(
        headline = headline,
        detail = detail,
        tone = tone,
        action = action,
        actionLabel = when (action) {
            HealthAction.INSTALL_OR_UPDATE -> "安裝或更新 Health Connect"
            HealthAction.MANAGE -> "開啟 Health Connect"
            else -> null
        },
        sleepEnabled = false,
        syncEnabled = false,
        syncHint = syncHint,
    )
}
