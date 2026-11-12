package tw.skyhong.infovore.health

import android.app.Application
import android.content.Context
import tw.skyhong.infovore.health.screen.ScreenSettings
import tw.skyhong.infovore.health.screen.ScreenUploadWorker

class InfovoreHealthApp : Application() {
    override fun onCreate() {
        super.onCreate()
        start(this)
    }

    companion object {
        /** Process start: binds a pre-0.3.2 phone token and schedules both periodic workers. */
        fun start(context: Context) {
            ScreenSettings(context).bindLegacyToken(DestinationChange.normalize(SecureSettings(context).endpoint))
            SyncScheduler.schedule(context)
            ScreenUploadWorker.schedule(context)
        }
    }
}
