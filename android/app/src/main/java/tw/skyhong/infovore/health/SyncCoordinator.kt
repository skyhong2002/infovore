package tw.skyhong.infovore.health

import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex

enum class SyncKind { SLEEP, FULL }

data class SyncState(
    /** The manual sync that is running (or waiting for the background sync to finish). */
    val running: SyncKind? = null,
    val progress: String? = null,
    /** The last manual run that failed in this process, offered as "重試". */
    val failed: SyncKind? = null,
    val error: String? = null,
    /** The periodic background sync ([SyncWorker]) currently holds the sync lock. */
    val backgroundRunning: Boolean = false,
) {
    val busy: Boolean get() = running != null || backgroundRunning
}

/**
 * Process-wide owner of Health Connect syncs. Manual syncs run in [scope], which outlives any
 * activity, so pressing back or leaving the app no longer cancels them. Manual and background
 * syncs share one [Mutex]: they never run at the same time, a second manual request is refused
 * while one is running, a manual request waits for a running background sync, and the background
 * sync is skipped (and retried later by WorkManager) while a manual one runs.
 *
 * Android-free so it can be unit tested; [SyncRunner] wires it to [HealthConnectSync].
 */
class SyncCoordinator(
    private val scope: CoroutineScope,
    private val describe: (Throwable) -> String,
) {
    private val lock = Mutex()
    private val _state = MutableStateFlow(SyncState())
    val state: StateFlow<SyncState> = _state.asStateFlow()

    /**
     * Starts a manual sync of [kind]; returns false (and does nothing) if a manual sync is
     * already running. [work] reports progress through its callback and throws on failure.
     */
    fun startManual(kind: SyncKind, work: suspend (onProgress: (String) -> Unit) -> Unit): Boolean {
        while (true) {
            val current = _state.value
            if (current.running != null) return false
            val claimed = current.copy(running = kind, progress = PREPARING, failed = null, error = null)
            if (_state.compareAndSet(current, claimed)) break
        }
        scope.launch {
            if (!lock.tryLock()) {
                setProgress(kind, WAITING_FOR_BACKGROUND)
                try {
                    lock.lock()
                } catch (cancelled: CancellationException) {
                    _state.update { it.copy(running = null, progress = null) }
                    throw cancelled
                }
            }
            try {
                setProgress(kind, PREPARING)
                work { text -> setProgress(kind, text) }
                _state.update { it.copy(running = null, progress = null) }
            } catch (cancelled: CancellationException) {
                _state.update { it.copy(running = null, progress = null) }
                throw cancelled
            } catch (error: Exception) {
                _state.update { it.copy(running = null, progress = null, failed = kind, error = describe(error)) }
            } finally {
                lock.unlock()
            }
        }
        return true
    }

    /**
     * Runs the background sync [block] unless another sync holds the lock, in which case it
     * returns null immediately without running [block].
     */
    suspend fun <T> runBackground(block: suspend () -> T): T? {
        if (!lock.tryLock()) return null
        _state.update { it.copy(backgroundRunning = true) }
        try {
            return block()
        } finally {
            _state.update { it.copy(backgroundRunning = false) }
            lock.unlock()
        }
    }

    /**
     * Runs a short, non-suspending [block] (such as resetting the sync cursor) only while no sync
     * is running or waiting; returns false without running it otherwise.
     */
    fun tryExclusive(block: () -> Unit): Boolean {
        if (_state.value.running != null) return false
        if (!lock.tryLock()) return false
        try {
            block()
        } finally {
            lock.unlock()
        }
        return true
    }

    /** Clears a stale manual failure of [kind], e.g. after a later background sync succeeded. */
    fun clearFailure(kind: SyncKind) {
        _state.update { if (it.running == null && it.failed == kind) it.copy(failed = null, error = null) else it }
    }

    private fun setProgress(kind: SyncKind, text: String) {
        _state.update { if (it.running == kind) it.copy(progress = text) else it }
    }

    companion object {
        const val PREPARING = "準備中…"
        const val WAITING_FOR_BACKGROUND = "背景同步正在進行，完成後立即開始…"
    }
}
