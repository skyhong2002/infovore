package tw.skyhong.infovore.health

import android.app.Application
import android.content.Context

class InfovoreHealthApp : Application() {
    override fun onCreate() {
        super.onCreate()
        start(this)
    }

    companion object {
        /** Process start: removes what the retired phone screen recorder left and schedules the health sync. */
        fun start(context: Context) {
            RetiredScreenRecorder.cleanUp(context)
            SyncScheduler.schedule(context)
        }
    }
}
