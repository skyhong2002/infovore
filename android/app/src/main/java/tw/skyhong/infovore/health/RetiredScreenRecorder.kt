package tw.skyhong.infovore.health

import android.content.Context
import androidx.core.app.NotificationManagerCompat
import androidx.core.content.edit
import androidx.work.WorkManager
import java.io.File
import java.security.KeyStore

/**
 * The phone screen recorder (手機足跡, up to 0.5.1) moved to PocketLog. An upgraded install may
 * still hold its periodic upload work, queued screen captures (text and thumbnails), its settings
 * and its Keystore key; this removes all of them once. Idempotent and cheap after the first run.
 */
object RetiredScreenRecorder {
    internal const val WORK_NAME = "infovore-dayflow-phone-upload"
    internal const val QUEUE_DIR = "screen-queue"
    internal const val PREFERENCES = "infovore_screen"
    internal const val KEY_ALIAS = "infovore-dayflow-phone-token"
    /** The recorder's quarantine warning on the "同步問題" channel. */
    internal const val QUARANTINE_NOTIFICATION_ID = 1002
    private const val DONE = "retired_screen_recorder_cleaned"

    fun cleanUp(context: Context) {
        val app = context.applicationContext
        val marker = app.getSharedPreferences("infovore_migrations", Context.MODE_PRIVATE)
        if (marker.getBoolean(DONE, false)) return
        runCatching { WorkManager.getInstance(app).cancelUniqueWork(WORK_NAME) }
        NotificationManagerCompat.from(app).cancel(QUARANTINE_NOTIFICATION_ID)
        File(app.noBackupFilesDir, QUEUE_DIR).deleteRecursively()
        app.deleteSharedPreferences(PREFERENCES)
        runCatching { KeyStore.getInstance("AndroidKeyStore").apply { load(null) }.deleteEntry(KEY_ALIAS) }
        marker.edit { putBoolean(DONE, true) }
    }
}
