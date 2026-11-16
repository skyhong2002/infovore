package tw.skyhong.infovore.health.location

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Intent
import android.content.pm.ServiceInfo
import android.location.Location
import android.location.LocationListener
import android.location.LocationManager
import android.location.LocationRequest
import android.os.IBinder
import androidx.core.app.NotificationCompat
import tw.skyhong.infovore.health.MainActivity
import tw.skyhong.infovore.health.R
import java.util.concurrent.Executors

/**
 * Records this phone's position while "持續記錄位置" is on. It asks the platform's fused provider
 * (or GPS / network when a phone has none) for a fix about once a minute, at most every
 * [MIN_DISTANCE_M] metres of movement, and queues each one ([LocationQueue]) for
 * [LocationUploadWorker]. Balanced accuracy (Wi-Fi and cell, about 20–100 m) is the default;
 * "高精確度" uses GPS and costs more battery.
 */
class LocationTrackingService : Service() {
    private val executor = Executors.newSingleThreadExecutor()
    private var listening = false
    private lateinit var queue: LocationQueue
    private lateinit var settings: LocationSettings

    private val listener = LocationListener { location -> record(location) }

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onCreate() {
        super.onCreate()
        queue = LocationQueue(this)
        settings = LocationSettings(this)
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        if (!settings.trackingEnabled || !LocationTracking.foregroundGranted(this)) {
            stopSelf()
            return START_NOT_STICKY
        }
        try {
            startForeground(NOTIFICATION_ID, notification(), ServiceInfo.FOREGROUND_SERVICE_TYPE_LOCATION)
        } catch (_: RuntimeException) {
            // Restarted from the background without "一律允許" location: Android refuses the location type.
            settings.serviceProblem = "Android 不允許在背景繼續記錄位置；打開 Infovore 即可繼續。"
            LocationTracking.notifyChanged()
            stopSelf()
            return START_NOT_STICKY
        }
        settings.serviceProblem = null
        listen()
        LocationTracking.notifyChanged()
        return START_STICKY
    }

    private fun listen() {
        if (listening) return
        val manager = getSystemService(LocationManager::class.java) ?: return
        val provider = listOf(LocationManager.FUSED_PROVIDER, LocationManager.GPS_PROVIDER, LocationManager.NETWORK_PROVIDER)
            .firstOrNull { manager.allProviders.contains(it) } ?: return
        val request = LocationRequest.Builder(INTERVAL_MS)
            .setMinUpdateIntervalMillis(MIN_INTERVAL_MS)
            .setMinUpdateDistanceMeters(MIN_DISTANCE_M)
            .setQuality(if (settings.highAccuracy) LocationRequest.QUALITY_HIGH_ACCURACY else LocationRequest.QUALITY_BALANCED_POWER_ACCURACY)
            .build()
        try {
            manager.requestLocationUpdates(provider, request, executor, listener)
            listening = true
        } catch (_: SecurityException) {
            settings.serviceProblem = "缺少位置權限，記錄已暫停。"
            LocationTracking.notifyChanged()
            stopSelf()
        }
    }

    /** Runs on [executor]. */
    private fun record(location: Location) {
        val fix = LocationFix(
            timeMs = location.time,
            lat = location.latitude,
            lng = location.longitude,
            accuracy = location.takeIf { it.hasAccuracy() }?.accuracy?.toDouble(),
            altitude = location.takeIf { it.hasAltitude() }?.altitude,
            speed = location.takeIf { it.hasSpeed() }?.speed?.toDouble(),
        )
        if (!LocationJson.valid(fix)) return
        queue.add(fix)
        settings.lastFix = fix
        LocationTracking.notifyChanged()
        if (queue.size() >= UPLOAD_AFTER_FIXES) LocationUploadScheduler.uploadSoon(this)
    }

    override fun onDestroy() {
        if (listening) {
            getSystemService(LocationManager::class.java)?.removeUpdates(listener)
            listening = false
        }
        executor.shutdown()
        LocationTracking.notifyChanged()
        super.onDestroy()
    }

    private fun notification(): Notification {
        val manager = getSystemService(NotificationManager::class.java)
        manager.createNotificationChannel(NotificationChannel(
            CHANNEL_ID, getString(R.string.location_channel_name), NotificationManager.IMPORTANCE_LOW,
        ).apply { description = getString(R.string.location_channel_description) })
        val open = PendingIntent.getActivity(
            this, 0,
            Intent(this, MainActivity::class.java).putExtra(MainActivity.EXTRA_OPEN_LOCATION, true)
                .addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_CLEAR_TOP),
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
        )
        return NotificationCompat.Builder(this, CHANNEL_ID)
            .setSmallIcon(R.drawable.ic_stat_location)
            .setContentTitle(getString(R.string.location_notification_title))
            .setContentText(getString(R.string.location_notification_text))
            .setContentIntent(open)
            .setOngoing(true)
            .setShowWhen(false)
            .setPriority(NotificationCompat.PRIORITY_LOW)
            .setForegroundServiceBehavior(NotificationCompat.FOREGROUND_SERVICE_IMMEDIATE)
            .build()
    }

    companion object {
        const val CHANNEL_ID = "location_recording"
        const val NOTIFICATION_ID = 2001
        const val INTERVAL_MS = 60_000L
        const val MIN_INTERVAL_MS = 30_000L
        const val MIN_DISTANCE_M = 15f
        /** About two hours of steady movement: upload sooner than the 15-minute period. */
        const val UPLOAD_AFTER_FIXES = 120
    }
}
