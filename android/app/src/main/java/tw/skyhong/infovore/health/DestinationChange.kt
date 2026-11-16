package tw.skyhong.infovore.health

import tw.skyhong.infovore.health.ui.InputValidation
import java.net.URI
import java.net.URISyntaxException

/**
 * Decides what saving a new endpoint must reset. The Health Connect change token only covers
 * changes since the last sync, so a new (possibly empty) server would otherwise never receive the
 * history the old server already has. Only a different destination resets: changing just the token, or
 * retyping the same URL with a trailing slash or different letter case in the scheme and host,
 * keeps everything.
 */
object DestinationChange {
    enum class Action {
        /** Same destination: keep the change token and import state. */
        KEEP,

        /** New destination with nothing tied to the old one: reset quietly. */
        RESET,

        /** New destination after a sync: confirm first. */
        CONFIRM_RESET,
    }

    /** What is tied to the saved destination when it changes. */
    data class Ties(
        /** A change token exists or a full sync has finished. */
        val hasSyncProgress: Boolean,
    ) {
        val any: Boolean get() = hasSyncProgress
    }

    /** Lower-cases scheme and host, drops default ports and trailing slashes. */
    fun normalize(raw: String): String {
        val text = raw.trim().trimEnd('/')
        val uri = try {
            URI(text)
        } catch (_: URISyntaxException) {
            return text
        }
        val scheme = uri.scheme?.lowercase() ?: return text
        val host = uri.host?.lowercase() ?: return text
        val port = uri.port.takeUnless { it == -1 || (scheme == "https" && it == 443) || (scheme == "http" && it == 80) }
        return buildString {
            append(scheme).append("://").append(host)
            if (port != null) append(':').append(port)
            append(uri.rawPath.orEmpty().trimEnd('/'))
        }
    }

    fun isNewDestination(savedEndpoint: String, newEndpoint: String): Boolean =
        normalize(savedEndpoint) != normalize(newEndpoint)

    /** [hasSyncProgress]: a change token exists or a full sync has finished. */
    fun decide(savedEndpoint: String, newEndpoint: String, hasSyncProgress: Boolean): Action =
        decide(savedEndpoint, newEndpoint, Ties(hasSyncProgress))

    fun decide(savedEndpoint: String, newEndpoint: String, ties: Ties): Action = when {
        !isNewDestination(savedEndpoint, newEndpoint) -> Action.KEEP
        ties.any -> Action.CONFIRM_RESET
        else -> Action.RESET
    }

    /**
     * The confirmation shown before switching to [newHost]. [reimportDays] is the history the next
     * full sync re-imports, or null when nothing was synced yet.
     */
    fun confirmMessage(newHost: String, ties: Ties, reimportDays: Int?): String = buildList {
        add("新的目的地（$newHost）不會有之前上傳到舊伺服器的資料。")
        if (ties.hasSyncProgress && reimportDays != null) {
            add(
                "健康資料：儲存後會清除增量同步游標，下次「立即同步」會重新匯入最近 $reimportDays 天的歷史資料，" +
                    "並重新完成「第一次同步」。",
            )
        }
        add("只更換 token 不會這樣做。")
    }.joinToString("\n\n")

    /** Days the next full sync re-imports, capped like HealthConnectSync.historyDays. */
    fun reimportDays(configuredDays: Int, historyPermissionGranted: Boolean): Int =
        configuredDays.coerceAtMost(
            if (historyPermissionGranted) SecureSettings.MAX_HISTORY_DAYS else InputValidation.HISTORY_WITHOUT_PERMISSION_DAYS,
        )

    /** Note under the endpoint field while an unsaved edit points somewhere new; null otherwise. */
    fun fieldNote(savedEndpoint: String, newEndpoint: String, hasSyncProgress: Boolean): String? =
        fieldNote(savedEndpoint, newEndpoint, Ties(hasSyncProgress))

    fun fieldNote(savedEndpoint: String, newEndpoint: String, ties: Ties): String? = when {
        decide(savedEndpoint, newEndpoint, ties) != Action.CONFIRM_RESET -> null
        else -> "這是新的同步目的地：儲存後，下次同步會重新匯入歷史資料"
    }

    /** The full-sync status saved after a reset, shown as the last result until the next sync. */
    fun resetStatus(days: Int): String = "同步目的地已變更；下次「立即同步」會重新匯入最近 $days 天的歷史資料"
}
