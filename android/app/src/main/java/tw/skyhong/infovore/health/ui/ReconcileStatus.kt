package tw.skyhong.infovore.health.ui

import tw.skyhong.infovore.health.GapRefusal
import tw.skyhong.infovore.health.HealthCatalog
import tw.skyhong.infovore.health.OriginCount
import tw.skyhong.infovore.health.ReconcileGap
import tw.skyhong.infovore.health.ReconcileWindow
import java.time.Instant
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import java.util.Locale

/** The health section's persistent "history not fully re-verified" box. */
data class ReconcileUi(
    /** e.g. "歷史尚未完整核實：步數、心率". */
    val headline: String,
    /** One line per type with its window, reason and last attempt, then what it means. */
    val detail: String,
    val reverifyEnabled: Boolean,
    /** Why "重新核實" is disabled, or null. */
    val reverifyHint: String?,
    /** One entry per type whose deletion the server refused as too large (HTTP 409 with counts). */
    val refusals: List<RefusalUi> = emptyList(),
)

/** A refused deletion: what the server would delete, and the user's two choices. */
data class RefusalUi(
    val dataType: String,
    /** "步數：伺服器偵測到要刪除 N 筆（窗內共 M 筆），因超過自動上限而保留資料。…" */
    val explanation: String,
    /** "我確認來源端已刪除，刪除這 N 筆", or null when the count is beyond what may be confirmed. */
    val confirmLabel: String?,
    /** The confirmed deletion needs the same conditions as a full sync (connection, permissions, nothing running). */
    val confirmEnabled: Boolean,
    /** The count the user confirms; sent as `confirmDelete.expected`. */
    val expected: Int,
    val ignoreLabel: String,
)

/** Title, message and confirm button of one dialog. */
data class DialogText(val title: String, val message: String, val ok: String)

/** The "keep the server's rows" reminders the user dismissed, shown as a quiet note. */
data class DismissedUi(val text: String)

/**
 * Maps the saved [ReconcileGap]s to UI text, kept separate from the general sync result: an
 * ordinary successful sync does not make this box go away, only a completed re-verification (or
 * the user dismissing a refused deletion, which keeps the server's rows).
 */
object ReconcileStatus {
    private val dayFormat = DateTimeFormatter.ofPattern("M/d", Locale.ROOT)
    private val dateFormat = DateTimeFormatter.ofPattern("yyyy/M/d", Locale.ROOT)

    fun map(
        gaps: List<ReconcileGap>,
        now: Instant,
        zone: ZoneId,
        /** Whether a full sync could start now (permissions, connection, nothing running). */
        syncReady: Boolean,
        syncHint: String?,
    ): ReconcileUi? {
        val active = gaps.filterNot { it.dismissed }
        if (active.isEmpty()) return null
        val labels = active.map { HealthCatalog.label(it.dataType) }
        val lines = active.map { gap ->
            "・${HealthCatalog.label(gap.dataType)}（${dayRange(gap.startMs, gap.endMs, zone)}）：${gap.reason}；" +
                "最後嘗試 ${TimeText.relative(Instant.ofEpochMilli(gap.checkedAtMs), now)}"
        }
        return ReconcileUi(
            headline = "歷史尚未完整核實：${labels.joinToString("、")}",
            detail = (lines + EXPLANATION).joinToString("\n"),
            reverifyEnabled = syncReady,
            reverifyHint = if (syncReady) null else syncHint ?: "目前無法重新核實",
            refusals = active.mapNotNull { gap -> gap.refusal?.let { refusal(gap, it, zone, syncReady) } },
        )
    }

    private fun refusal(gap: ReconcileGap, refusal: GapRefusal, zone: ZoneId, syncReady: Boolean): RefusalUi {
        val label = HealthCatalog.label(gap.dataType)
        val explanation = buildString {
            append(label).append("（").append(dayRange(refusal.startMs, refusal.endMs, zone)).append("）：")
            append("伺服器偵測到要刪除 ").append(refusal.wouldDelete).append(" 筆（窗內共 ").append(refusal.checked)
            append(" 筆），因超過自動上限而保留資料。")
            origins(refusal)?.let { append(it).append("。") }
            if (gap.confirmable) {
                append("若你確定這些資料已在來源端（Health Connect 或寫入它的 App）刪除，可確認刪除；否則請保留。")
            } else {
                append("超過 App 內可確認的上限 ").append(ReconcileWindow.MAX_CONFIRMED_DELETES)
                append(" 筆，無法在此刪除；可保留伺服器資料並忽略此提醒。")
            }
        }
        return RefusalUi(
            dataType = gap.dataType,
            explanation = explanation,
            confirmLabel = if (gap.confirmable) "我確認來源端已刪除，刪除這 ${refusal.wouldDelete} 筆" else null,
            confirmEnabled = gap.confirmable && syncReady,
            expected = refusal.wouldDelete,
            ignoreLabel = "保留伺服器資料並忽略此提醒",
        )
    }

    /**
     * The two dialogs shown, one after the other, before a confirmed deletion: what will be
     * deleted (type, time range, count), then a last, explicit "cannot be undone".
     */
    fun confirmDialogs(gap: ReconcileGap, zone: ZoneId, use24Hour: Boolean = true): Pair<DialogText, DialogText>? {
        val refusal = gap.refusal ?: return null
        if (!gap.confirmable) return null
        val label = HealthCatalog.label(gap.dataType)
        val range = timeRange(refusal, zone, use24Hour)
        val count = refusal.wouldDelete
        val first = DialogText(
            title = "刪除伺服器上的 $count 筆${label}資料？",
            message = "資料類型：$label\n時間範圍：$range\n將刪除：$count 筆（伺服器上這段範圍共 ${refusal.checked} 筆，" +
                "屬於這支手機）" + (origins(refusal)?.let { "\n$it" } ?: "") + "\n\n只在你確定這些紀錄已在來源端（Health Connect 或寫入它的 App）刪除時才繼續。" +
                "按下後會先重新讀取這段範圍；若數字已改變，不會刪除任何資料，並請你重新確認。",
            ok = "繼續",
        )
        val second = DialogText(
            title = "最後確認：無法復原",
            message = "伺服器將永久刪除 $range 的 $count 筆${label}資料。刪除後無法復原，" +
                "伺服器不會保留備份，手機也不會重新上傳這些紀錄。",
            ok = "刪除 $count 筆",
        )
        return first to second
    }

    /** The dialog before keeping the server's rows and hiding the reminder. Deletes nothing. */
    fun ignoreDialog(gap: ReconcileGap, zone: ZoneId, use24Hour: Boolean = true): DialogText {
        val label = HealthCatalog.label(gap.dataType)
        val refusal = gap.refusal
        val what = if (refusal != null) {
            "伺服器上 ${timeRange(refusal, zone, use24Hour)} 的 ${refusal.wouldDelete} 筆${label}資料會保留"
        } else {
            "伺服器上的${label}資料會保留"
        }
        return DialogText(
            title = "保留伺服器資料並忽略此提醒？",
            message = "$what，不會刪除任何資料。此提醒會記錄為已忽略並隱藏；" +
                "之後若出現不同的對帳結果，會再次提醒。",
            ok = "保留並忽略",
        )
    }

    /** A quiet note for dismissed reminders, or null when there are none. */
    fun dismissed(gaps: List<ReconcileGap>): DismissedUi? {
        val dismissed = gaps.filter { it.dismissed }
        if (dismissed.isEmpty()) return null
        return DismissedUi(
            text = "已忽略的對帳提醒：${dismissed.joinToString("、") { HealthCatalog.label(it.dataType) }}" +
                "（保留伺服器資料，未刪除任何資料）",
        )
    }

    /**
     * "來自：25 筆 com.garmin.connect、2 筆其他 App" — which source apps the rows to delete came
     * from, as the server reported it; null for servers before 0.4.3 (counts only).
     */
    fun origins(refusal: GapRefusal): String? {
        if (refusal.byOrigin.isEmpty()) return null
        return "來自：" + refusal.byOrigin.joinToString("、") { entry ->
            if (entry.origin == OriginCount.OTHER) "${entry.count} 筆其他 App" else "${entry.count} 筆 ${entry.origin}"
        }
    }

    private fun dayRange(startMs: Long, endMs: Long, zone: ZoneId): String {
        val from = dayFormat.format(Instant.ofEpochMilli(startMs).atZone(zone))
        // The window's end is exclusive; show the last day it covers.
        val to = dayFormat.format(Instant.ofEpochMilli(endMs - 1).atZone(zone))
        return if (from == to) from else "$from–$to"
    }

    private fun timeRange(refusal: GapRefusal, zone: ZoneId, use24Hour: Boolean): String {
        fun at(ms: Long): String {
            val instant = Instant.ofEpochMilli(ms)
            return "${dateFormat.format(instant.atZone(zone))} ${TimeText.clock(instant, zone, use24Hour)}"
        }
        return "${at(refusal.startMs)} 至 ${at(refusal.endMs)}（不含）"
    }

    const val EXPLANATION =
        "伺服器上可能仍留有已在手機刪除的這些資料；新資料仍照常同步。「重新核實」只重新讀取並比對上列範圍，" +
            "伺服器的刪除上限不變，被拒絕時會保留此提醒。"
}
