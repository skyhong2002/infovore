package tw.skyhong.infovore.health

import android.app.Application
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import tw.skyhong.infovore.health.screen.ScreenUploader
import tw.skyhong.infovore.health.ui.ErrorText
import tw.skyhong.infovore.health.ui.SecretDrafts
import tw.skyhong.infovore.health.ui.TimeText
import tw.skyhong.infovore.health.ui.Tone
import java.time.Instant
import java.time.ZoneId

/**
 * Screen state that must survive an activity recreation: the user-started screen tasks (manual
 * upload, connection test) and unsaved token drafts. Health Connect syncs are owned by the
 * process-wide [SyncRunner] instead, so leaving the screen does not cancel them either.
 */
class MainViewModel(application: Application) : AndroidViewModel(application) {
    enum class ScreenTask { UPLOAD, TEST }

    data class ScreenTaskState(
        val running: ScreenTask? = null,
        val result: String? = null,
        val tone: Tone = Tone.NEUTRAL,
        val failed: ScreenTask? = null,
    )

    /** In-memory only; see [SecretDrafts]. */
    val drafts = SecretDrafts()

    val sync: StateFlow<SyncState> = SyncRunner.state

    private val _screen = MutableStateFlow(ScreenTaskState())
    val screen: StateFlow<ScreenTaskState> = _screen.asStateFlow()

    fun startSync(kind: SyncKind): Boolean = SyncRunner.start(getApplication(), kind)

    fun uploadScreen() = runScreenTask(ScreenTask.UPLOAD) {
        val outcome = ScreenUploader.uploadPending(getApplication())
        val error = outcome.error
        val rejected = if (outcome.rejected > 0) "${outcome.rejected} 筆被伺服器拒收，已移到隔離區（未刪除）。" else ""
        when {
            error != null && outcome.sent > 0 ->
                ScreenTaskState(result = "已送出 ${outcome.sent} 筆後失敗：$error$rejected", tone = Tone.ERROR, failed = ScreenTask.UPLOAD)
            error != null -> ScreenTaskState(result = "上傳失敗：$error$rejected", tone = Tone.ERROR, failed = ScreenTask.UPLOAD)
            outcome.sent == 0 && outcome.rejected == 0 -> ScreenTaskState(result = "沒有待上傳的紀錄。", tone = Tone.NEUTRAL)
            else -> ScreenTaskState(
                result = "已送出 ${outcome.sent} 筆（新增 ${outcome.accepted}、重複 ${outcome.duplicates}），佇列剩 ${outcome.remaining} 筆。$rejected",
                tone = if (outcome.rejected > 0) Tone.WARNING else Tone.OK,
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

    override fun onCleared() {
        drafts.clearAll()
        super.onCleared()
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
