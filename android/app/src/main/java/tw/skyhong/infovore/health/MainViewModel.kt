package tw.skyhong.infovore.health

import android.app.Application
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import tw.skyhong.infovore.health.screen.ScreenUploader
import tw.skyhong.infovore.health.ui.ErrorText
import tw.skyhong.infovore.health.ui.TimeText
import tw.skyhong.infovore.health.ui.Tone
import java.time.Instant
import java.time.ZoneId

/**
 * Runs the user-started tasks (manual sync, manual upload, connection test) outside the activity,
 * so rotating the phone or switching dark mode neither cancels a sync nor loses its progress.
 * Sync policy, data range and payloads are unchanged: this only wraps the existing calls.
 */
class MainViewModel(application: Application) : AndroidViewModel(application) {
    enum class SyncKind { SLEEP, FULL }

    data class SyncState(
        val running: SyncKind? = null,
        val progress: String? = null,
        /** The last manual run that failed in this session, offered as "重試". */
        val failed: SyncKind? = null,
        val error: String? = null,
    )

    enum class ScreenTask { UPLOAD, TEST }

    data class ScreenTaskState(
        val running: ScreenTask? = null,
        val result: String? = null,
        val tone: Tone = Tone.NEUTRAL,
        val failed: ScreenTask? = null,
    )

    private val settings = SecureSettings(application)
    private val _sync = MutableStateFlow(SyncState())
    val sync: StateFlow<SyncState> = _sync.asStateFlow()
    private val _screen = MutableStateFlow(ScreenTaskState())
    val screen: StateFlow<ScreenTaskState> = _screen.asStateFlow()

    fun startSync(kind: SyncKind) {
        if (_sync.value.running != null) return
        _sync.value = SyncState(running = kind, progress = "準備中…")
        viewModelScope.launch {
            try {
                val summary = withContext(Dispatchers.IO) {
                    val sync = HealthConnectSync(getApplication())
                    val progress: (String) -> Unit = { text ->
                        // The full-sync status mirrors progress so a background check shows it too.
                        if (kind == SyncKind.FULL) settings.lastStatus = text
                        _sync.update { it.copy(progress = text) }
                    }
                    if (kind == SyncKind.SLEEP) sync.runSleep(progress) else sync.run(progress)
                }
                if (kind == SyncKind.FULL) {
                    settings.lastStatus = "${Instant.now()}：同步完成，新增 ${summary.inserted}、更新 ${summary.updated}、刪除 ${summary.deleted}"
                    settings.lastSyncFailed = false
                }
                _sync.value = SyncState()
            } catch (cancelled: CancellationException) {
                throw cancelled
            } catch (error: Exception) {
                val message = ErrorText.describe(error)
                if (kind == SyncKind.FULL) {
                    settings.lastStatus = "${Instant.now()}：同步失敗：$message"
                    settings.lastSyncFailed = true
                }
                _sync.value = SyncState(failed = kind, error = message)
            }
        }
    }

    fun uploadScreen() = runScreenTask(ScreenTask.UPLOAD) {
        val outcome = ScreenUploader.uploadPending(getApplication())
        val error = outcome.error
        when {
            error != null && outcome.sent > 0 ->
                ScreenTaskState(result = "已送出 ${outcome.sent} 筆後失敗：$error", tone = Tone.ERROR, failed = ScreenTask.UPLOAD)
            error != null -> ScreenTaskState(result = "上傳失敗：$error", tone = Tone.ERROR, failed = ScreenTask.UPLOAD)
            outcome.sent == 0 -> ScreenTaskState(result = "沒有待上傳的紀錄。", tone = Tone.NEUTRAL)
            else -> ScreenTaskState(
                result = "已送出 ${outcome.sent} 筆（新增 ${outcome.accepted}、重複 ${outcome.duplicates}），佇列剩 ${outcome.remaining} 筆。",
                tone = Tone.OK,
            )
        }
    }

    fun testScreenConnection(use24Hour: Boolean) = runScreenTask(ScreenTask.TEST) {
        val status = ScreenUploader.checkStatus(getApplication())
        val last = TimeText.parseServerTime(status.optString("lastObservationAt"))
            ?.let { TimeText.friendly(it, Instant.now(), ZoneId.systemDefault(), use24Hour) }
            ?: "尚無資料"
        ScreenTaskState(
            result = "連線成功（${status.optString("status")}）。伺服器最後收到：$last；待處理 ${status.optInt("pending")} 筆。",
            tone = Tone.OK,
        )
    }

    fun clearScreenResult() {
        if (_screen.value.running == null) _screen.value = ScreenTaskState()
    }

    private fun runScreenTask(task: ScreenTask, block: suspend () -> ScreenTaskState) {
        if (_screen.value.running != null) return
        _screen.value = ScreenTaskState(running = task)
        viewModelScope.launch {
            _screen.value = try {
                block()
            } catch (cancelled: CancellationException) {
                throw cancelled
            } catch (error: Exception) {
                val prefix = if (task == ScreenTask.TEST) "連線失敗" else "上傳失敗"
                ScreenTaskState(result = "$prefix：${ErrorText.describe(error)}", tone = Tone.ERROR, failed = task)
            }
        }
    }
}
