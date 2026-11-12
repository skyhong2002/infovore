package tw.skyhong.infovore.health.screen

import android.content.Context
import androidx.core.content.edit
import tw.skyhong.infovore.health.KeystoreCipher

/** Phone Dayflow settings. Endpoint and device id are shared with [tw.skyhong.infovore.health.SecureSettings]. */
class ScreenSettings(context: Context) {
    private val preferences = context.getSharedPreferences("infovore_screen", Context.MODE_PRIVATE)
    private val cipher = KeystoreCipher(KEY_ALIAS)

    val token: String
        get() = cipher.decrypt(preferences.getString(KEY_TOKEN, null))

    /**
     * The normalised sync destination the token was saved for; uploads refuse to send the token
     * anywhere else. Null when no token is saved.
     */
    val tokenDestination: String?
        get() = preferences.getString(KEY_TOKEN_DESTINATION, null)

    /** Saves [value] (Keystore-encrypted) together with the destination it belongs to. */
    fun saveToken(value: String, destination: String) {
        val trimmed = value.trim()
        preferences.edit {
            putString(KEY_TOKEN, cipher.encrypt(trimmed))
            if (trimmed.isEmpty()) remove(KEY_TOKEN_DESTINATION) else putString(KEY_TOKEN_DESTINATION, destination)
        }
    }

    /** Forgets the token, e.g. when the sync destination changes. Recording settings are untouched. */
    fun clearToken() {
        preferences.edit {
            remove(KEY_TOKEN)
            remove(KEY_TOKEN_DESTINATION)
        }
    }

    /**
     * Tokens saved before 0.3.2 carry no destination; they were entered for the endpoint saved at
     * the time, so bind them to [destination] (the current one) once, at upgrade.
     */
    fun bindLegacyToken(destination: String) {
        if (preferences.contains(KEY_TOKEN) && !preferences.contains(KEY_TOKEN_DESTINATION) && token.isNotEmpty()) {
            preferences.edit { putString(KEY_TOKEN_DESTINATION, destination) }
        }
    }

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

    /**
     * Epoch millis before which automatic uploads (the worker and the recording service) do not
     * contact the server, because its last answer carried `Retry-After`; 0 when there is none.
     * A manual upload ignores it.
     */
    var retryNotBefore: Long
        get() = preferences.getLong(KEY_RETRY_NOT_BEFORE, 0L)
        set(value) { preferences.edit { putLong(KEY_RETRY_NOT_BEFORE, value) } }

    /**
     * The quarantine level last notified by [tw.skyhong.infovore.health.QuarantineNotifier], so
     * each warning shows once (see [QuarantineAlerts.Decision.notified]). A new key in 0.4.4: the
     * old one held the level last seen, even while notifications were off.
     */
    var quarantineAlertLevel: QuarantineAlerts.Level
        get() = preferences.getString(KEY_QUARANTINE_ALERT, null)
            ?.let { name -> QuarantineAlerts.Level.entries.firstOrNull { it.name == name } }
            ?: QuarantineAlerts.Level.NONE
        set(value) { preferences.edit { putString(KEY_QUARANTINE_ALERT, value.name) } }

    fun isPaused(nowMs: Long = System.currentTimeMillis()) = pausedUntil > nowMs

    fun isRecording(nowMs: Long = System.currentTimeMillis()) = enabled && !isPaused(nowMs)

    private companion object {
        const val KEY_ALIAS = "infovore-dayflow-phone-token"
        const val KEY_TOKEN = "token"
        const val KEY_TOKEN_DESTINATION = "token_destination"
        const val KEY_ENABLED = "enabled"
        const val KEY_PAUSED_UNTIL = "paused_until"
        const val KEY_EXCLUSIONS = "exclusions"
        const val KEY_LAST_CAPTURE_AT = "last_capture_at"
        const val KEY_LAST_UPLOAD_STATUS = "last_upload_status"
        const val KEY_RETRY_NOT_BEFORE = "retry_not_before"
        const val KEY_QUARANTINE_ALERT = "quarantine_notified_level"
    }
}
