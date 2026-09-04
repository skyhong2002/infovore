package tw.skyhong.infovore.health

import android.app.Application

class InfovoreHealthApp : Application() {
    override fun onCreate() {
        super.onCreate()
        SyncScheduler.schedule(this)
    }
}
