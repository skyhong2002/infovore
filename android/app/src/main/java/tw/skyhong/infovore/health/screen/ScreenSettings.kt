package tw.skyhong.infovore.health.screen

import android.content.Context
import androidx.core.content.edit
import tw.skyhong.infovore.health.KeystoreCipher

/** Phone Dayflow settings. Endpoint and device id are shared with [tw.skyhong.infovore.health.SecureSettings]. */
class ScreenSettings(context: Context) {
    private val preferences = context.getSharedPreferences("infovore_screen", Context.MODE_PRIVATE)
    private val cipher = KeystoreCipher(KEY_ALIAS)

    var token: String
        get() = cipher.decrypt(preferences.getString(KEY_TOKEN, null))
        set(value) { preferences.edit { putString(KEY_TOKEN, cipher.encrypt(value.trim())) } }

    var enabled: Boolean
        get() = preferences.getBoolean(KEY_ENABLED, false)
        set(value) { preferences.edit { putBoolean(KEY_ENABLED, value) } }

    /** Epoch millis until which capture is paused; 0 when not paused. */
    var pausedUntil: Long
        get() = preferences.getLong(KEY_PAUSED_UNTIL, 0L)
        set(value) { preferences.edit { putLong(KEY_PAUSED_UNTIL, value) } }

    var exclusionsText: String
        get() = preferences.getString(KEY_EXCLUSIONS, "").orEmpty()
        set(value) { preferences.edit { putString(KEY_EXCLUSIONS, value.trim()) } }

    val exclusions: Set<String> get() = Exclusions.parse(exclusionsText)

    var lastCaptureAt: Long
        get() = preferences.getLong(KEY_LAST_CAPTURE_AT, 0L)
        set(value) { preferences.edit { putLong(KEY_LAST_CAPTURE_AT, value) } }

    var lastUploadStatus: String
        get() = preferences.getString(KEY_LAST_UPLOAD_STATUS, "尚未上傳") ?: "尚未上傳"
        set(value) { preferences.edit { putString(KEY_LAST_UPLOAD_STATUS, value) } }

    fun isPaused(nowMs: Long = System.currentTimeMillis()) = pausedUntil > nowMs

    fun isRecording(nowMs: Long = System.currentTimeMillis()) = enabled && !isPaused(nowMs)

    private companion object {
        const val KEY_ALIAS = "infovore-dayflow-phone-token"
        const val KEY_TOKEN = "token"
        const val KEY_ENABLED = "enabled"
        const val KEY_PAUSED_UNTIL = "paused_until"
        const val KEY_EXCLUSIONS = "exclusions"
        const val KEY_LAST_CAPTURE_AT = "last_capture_at"
        const val KEY_LAST_UPLOAD_STATUS = "last_upload_status"
    }
}
