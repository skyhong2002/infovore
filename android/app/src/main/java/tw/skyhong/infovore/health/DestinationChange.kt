package tw.skyhong.infovore.health

import tw.skyhong.infovore.health.ui.InputValidation
import java.net.URI
import java.net.URISyntaxException

/**
 * Decides whether saving a new endpoint must reset the incremental sync state. The Health Connect
 * change token only covers changes since the last sync, so a new (possibly empty) server would
 * otherwise never receive the history the old server already has. Only a different destination
 * resets: changing just the token, or retyping the same URL with a trailing slash or different
 * letter case in the scheme and host, keeps the cursor.
 */
object DestinationChange {
    enum class Action {
        /** Same destination: keep the change token and import state. */
        KEEP,

        /** New destination but nothing synced yet: reset quietly. */
        RESET,

        /** New destination after a sync: confirm, then reset and re-import history. */
        CONFIRM_RESET,
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
    fun decide(savedEndpoint: String, newEndpoint: String, hasSyncProgress: Boolean): Action = when {
        !isNewDestination(savedEndpoint, newEndpoint) -> Action.KEEP
        hasSyncProgress -> Action.CONFIRM_RESET
        else -> Action.RESET
    }

    /** Days the next full sync re-imports, capped like HealthConnectSync.historyDays. */
    fun reimportDays(configuredDays: Int, historyPermissionGranted: Boolean): Int =
        configuredDays.coerceAtMost(
            if (historyPermissionGranted) SecureSettings.MAX_HISTORY_DAYS else InputValidation.HISTORY_WITHOUT_PERMISSION_DAYS,
        )

    /** Note under the endpoint field while an unsaved edit points somewhere new; null otherwise. */
    fun fieldNote(savedEndpoint: String, newEndpoint: String, hasSyncProgress: Boolean): String? =
        if (decide(savedEndpoint, newEndpoint, hasSyncProgress) == Action.CONFIRM_RESET) {
            "這是新的同步目的地：儲存後，下次同步會重新匯入歷史資料"
        } else {
            null
        }

    /** The full-sync status saved after a reset, shown as the last result until the next sync. */
    fun resetStatus(days: Int): String = "同步目的地已變更；下次「立即同步」會重新匯入最近 $days 天的歷史資料"
}
