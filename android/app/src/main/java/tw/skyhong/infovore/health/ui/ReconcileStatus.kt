package tw.skyhong.infovore.health.ui

import tw.skyhong.infovore.health.HealthCatalog
import tw.skyhong.infovore.health.ReconcileGap
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
)

/**
 * Maps the saved [ReconcileGap]s to UI text, kept separate from the general sync result: an
 * ordinary successful sync does not make this box go away, only a completed re-verification.
 */
object ReconcileStatus {
    private val dayFormat = DateTimeFormatter.ofPattern("M/d", Locale.ROOT)

    fun map(
        gaps: List<ReconcileGap>,
        now: Instant,
        zone: ZoneId,
        /** Whether a full sync could start now (permissions, connection, nothing running). */
        syncReady: Boolean,
        syncHint: String?,
    ): ReconcileUi? {
        if (gaps.isEmpty()) return null
        val labels = gaps.map { HealthCatalog.label(it.dataType) }
        val lines = gaps.map { gap ->
            val from = dayFormat.format(Instant.ofEpochMilli(gap.startMs).atZone(zone))
            // The window's end is exclusive; show the last day it covers.
            val to = dayFormat.format(Instant.ofEpochMilli(gap.endMs - 1).atZone(zone))
            val range = if (from == to) from else "$from–$to"
            "・${HealthCatalog.label(gap.dataType)}（$range）：${gap.reason}；最後嘗試 ${TimeText.relative(Instant.ofEpochMilli(gap.checkedAtMs), now)}"
        }
        return ReconcileUi(
            headline = "歷史尚未完整核實：${labels.joinToString("、")}",
            detail = (lines + EXPLANATION).joinToString("\n"),
            reverifyEnabled = syncReady,
            reverifyHint = if (syncReady) null else syncHint ?: "目前無法重新核實",
        )
    }

    const val EXPLANATION =
        "伺服器上可能仍留有已在手機刪除的這些資料；新資料仍照常同步。「重新核實」只重新讀取並比對上列範圍，" +
            "伺服器的刪除上限不變，被拒絕時會保留此提醒。"
}
