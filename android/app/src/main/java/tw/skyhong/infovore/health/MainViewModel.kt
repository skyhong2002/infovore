package tw.skyhong.infovore.health

import android.app.Application
import androidx.lifecycle.AndroidViewModel
import kotlinx.coroutines.flow.StateFlow
import tw.skyhong.infovore.health.ui.SecretDrafts

/**
 * Screen state that must survive an activity recreation: unsaved token drafts. Health Connect syncs are owned by the
 * process-wide [SyncRunner] instead, so leaving the screen does not cancel them either.
 */
class MainViewModel(application: Application) : AndroidViewModel(application) {
    /** In-memory only; see [SecretDrafts]. */
    val drafts = SecretDrafts()

    val sync: StateFlow<SyncState> = SyncRunner.state

    fun startSync(kind: SyncKind): Boolean = SyncRunner.start(getApplication(), kind)

    override fun onCleared() {
        drafts.clearAll()
        super.onCleared()
    }
}
