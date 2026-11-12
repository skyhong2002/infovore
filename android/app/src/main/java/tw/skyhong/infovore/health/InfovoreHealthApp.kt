package tw.skyhong.infovore.health

import android.app.Application
import tw.skyhong.infovore.health.screen.ScreenUploadWorker

class InfovoreHealthApp : Application() {
    override fun onCreate() {
        super.onCreate()
        SyncScheduler.schedule(this)
        ScreenUploadWorker.schedule(this)
    }
}
