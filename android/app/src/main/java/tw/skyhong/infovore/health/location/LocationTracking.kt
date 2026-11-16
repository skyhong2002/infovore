package tw.skyhong.infovore.health.location

import android.Manifest
import android.annotation.SuppressLint
import android.app.ForegroundServiceStartNotAllowedException
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import androidx.core.content.ContextCompat
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow

/**
 * Turning the location recorder on and off, and the permissions it needs. Recording runs in
 * [LocationTrackingService], a foreground service with a visible notification. Android lets it
 * start while Infovore is on screen with "使用應用程式時" location; restarting it after a reboot
 * or an app update needs "一律允許" (background location), which stays optional.
 */
object LocationTracking {
    private val _changes = MutableStateFlow(0L)

    /** Bumped on every new fix, upload or state change, so the screen re-renders. */
    val changes: StateFlow<Long> = _changes

    fun notifyChanged() {
        _changes.value = _changes.value + 1
    }

    fun foregroundGranted(context: Context): Boolean = granted(context, Manifest.permission.ACCESS_FINE_LOCATION)

    fun backgroundGranted(context: Context): Boolean = granted(context, Manifest.permission.ACCESS_BACKGROUND_LOCATION)

    private fun granted(context: Context, permission: String) =
        ContextCompat.checkSelfPermission(context, permission) == PackageManager.PERMISSION_GRANTED

    /** Turns recording on and starts the service; the caller already holds the location permission. */
    fun enable(context: Context): Boolean {
        val settings = LocationSettings(context)
        settings.trackingEnabled = true
        settings.serviceProblem = null
        LocationUploadScheduler.schedule(context)
        return start(context)
    }

    /** Turns recording off, stops the service and sends what is still queued. */
    fun disable(context: Context) {
        LocationSettings(context).apply {
            trackingEnabled = false
            serviceProblem = null
        }
        stopService(context)
        LocationUploadScheduler.uploadSoon(context)
        LocationUploadScheduler.cancelPeriodic(context)
        notifyChanged()
    }

    /** From an activity coming to the foreground: restarts recording that was on but stopped. */
    fun resumeIfEnabled(context: Context) {
        val settings = LocationSettings(context)
        if (!settings.trackingEnabled) return
        if (!foregroundGranted(context)) {
            settings.serviceProblem = "已撤銷精確位置權限，記錄已暫停。"
            notifyChanged()
            return
        }
        LocationUploadScheduler.schedule(context)
        start(context)
    }

    /** Restarts a running recorder so it picks up a changed accuracy setting. */
    fun restart(context: Context) {
        if (!LocationSettings(context).trackingEnabled) return
        stopService(context)
        start(context)
    }

    // stopService matches the service by component, not by Intent identity (lint mistakes it for a listener removal).
    @SuppressLint("ImplicitSamInstance")
    private fun stopService(context: Context) {
        context.stopService(Intent(context, LocationTrackingService::class.java))
    }

    /** Starts the service; false (with [LocationSettings.serviceProblem] set) when Android refuses. */
    fun start(context: Context): Boolean = try {
        ContextCompat.startForegroundService(context, Intent(context, LocationTrackingService::class.java))
        true
    } catch (_: ForegroundServiceStartNotAllowedException) {
        LocationSettings(context).serviceProblem = "Android 不允許在背景啟動位置記錄；打開 Infovore 即可繼續。"
        notifyChanged()
        false
    } catch (_: SecurityException) {
        LocationSettings(context).serviceProblem = "缺少位置權限，記錄已暫停。"
        notifyChanged()
        false
    }
}

/** After a reboot or an app update: resumes recording when it was on and "一律允許" location is granted. */
class LocationBootReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        if (intent.action != Intent.ACTION_BOOT_COMPLETED && intent.action != Intent.ACTION_MY_PACKAGE_REPLACED) return
        val settings = LocationSettings(context)
        if (!settings.trackingEnabled) return
        LocationUploadScheduler.schedule(context)
        if (LocationTracking.foregroundGranted(context) && LocationTracking.backgroundGranted(context)) {
            LocationTracking.start(context)
        } else {
            settings.serviceProblem = "手機重新啟動後記錄已暫停；打開 Infovore 即可繼續（授予「一律允許」位置可自動繼續）。"
        }
    }
}
