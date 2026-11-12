package tw.skyhong.infovore.health

import android.content.Context
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.flow.StateFlow
import tw.skyhong.infovore.health.ui.ErrorText
import java.time.Instant

/**
 * The single process-wide [SyncCoordinator] shared by the screen and [SyncWorker]. A manual sync
 * keeps running after the activity finishes, as long as the process lives. Sync policy, data
 * range and payloads are unchanged: this only wraps [HealthConnectSync].
 */
object SyncRunner {
    val coordinator = SyncCoordinator(CoroutineScope(SupervisorJob() + Dispatchers.IO), ErrorText::describe)
    val state: StateFlow<SyncState> get() = coordinator.state

    /** Starts a manual sync; returns false when one is already running. */
    fun start(context: Context, kind: SyncKind): Boolean {
        val app = context.applicationContext
        return coordinator.startManual(kind) { progress -> runManual(app, kind, progress) }
    }

    private suspend fun runManual(context: Context, kind: SyncKind, progress: (String) -> Unit) {
        val settings = SecureSettings(context)
        try {
            val sync = HealthConnectSync(context)
            val report: (String) -> Unit = { text ->
                // The full-sync status mirrors progress so a background check shows it too.
                if (kind == SyncKind.FULL) settings.lastStatus = text
                progress(text)
            }
            val summary = when (kind) {
                SyncKind.SLEEP -> sync.runSleep(report)
                SyncKind.FULL -> sync.run(report)
                // Re-verification has its own persistent status (the saved gaps); it never
                // touches the general sync status.
                SyncKind.REVERIFY -> sync.reverify(progress)
            }
            if (kind == SyncKind.FULL) {
                settings.lastStatus = "${Instant.now()}：同步完成，新增 ${summary.inserted}、更新 ${summary.updated}、刪除 ${summary.deleted}${ReconcileText.note(summary.unverified)}"
                settings.lastSyncFailed = false
                settings.initialImportDone = true
                SyncFailureNotifier.record(context, settings, SyncFailureAlerts.Outcome.SUCCESS)
            }
        } catch (cancelled: CancellationException) {
            throw cancelled
        } catch (error: Exception) {
            if (kind == SyncKind.FULL) {
                settings.lastStatus = "${Instant.now()}：同步失敗：${ErrorText.describe(error)}"
                settings.lastSyncFailed = true
            }
            throw error
        }
    }
}
