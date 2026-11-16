package tw.skyhong.infovore.health

import android.app.Application
import android.content.Context
import tw.skyhong.infovore.health.location.LocationSettings
import tw.skyhong.infovore.health.location.LocationUploadScheduler

class InfovoreHealthApp : Application() {
    override fun onCreate() {
        super.onCreate()
        start(this)
    }

    companion object {
        /**
         * Process start: removes what the retired phone screen recorder left, schedules the health
         * sync, and keeps the location upload scheduled while recording is on.
         */
        fun start(context: Context) {
            RetiredScreenRecorder.cleanUp(context)
            SyncScheduler.schedule(context)
            if (LocationSettings(context).trackingEnabled) LocationUploadScheduler.schedule(context)
        }
    }
}
