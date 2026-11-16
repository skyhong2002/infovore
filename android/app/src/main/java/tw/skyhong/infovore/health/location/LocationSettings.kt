package tw.skyhong.infovore.health.location

import android.content.Context
import androidx.core.content.edit

/** What the location recorder remembers between runs. Coordinates stay on the phone's private storage. */
class LocationSettings(context: Context) {
    private val preferences = context.getSharedPreferences(NAME, Context.MODE_PRIVATE)

    /** The user turned "持續記錄位置" on; the service resumes when the app opens or the phone restarts. */
    var trackingEnabled: Boolean
        get() = preferences.getBoolean(KEY_ENABLED, false)
        set(value) { preferences.edit { putBoolean(KEY_ENABLED, value) } }

    var highAccuracy: Boolean
        get() = preferences.getBoolean(KEY_HIGH_ACCURACY, false)
        set(value) { preferences.edit { putBoolean(KEY_HIGH_ACCURACY, value) } }

    /** The latest fix, for the screen ("最後定位"). */
    var lastFix: LocationFix?
        get() = preferences.getString(KEY_LAST_FIX, null)?.let(LocationJson::decodeLine)
        set(value) { preferences.edit { if (value == null) remove(KEY_LAST_FIX) else putString(KEY_LAST_FIX, LocationJson.encodeLine(value)) } }

    var lastUploadStatus: String?
        get() = preferences.getString(KEY_UPLOAD_STATUS, null)
        set(value) { preferences.edit { putString(KEY_UPLOAD_STATUS, value) } }

    var lastUploadFailed: Boolean
        get() = preferences.getBoolean(KEY_UPLOAD_FAILED, false)
        set(value) { preferences.edit { putBoolean(KEY_UPLOAD_FAILED, value) } }

    /** Why the service stopped on its own (permission withdrawn, background start refused); null while fine. */
    var serviceProblem: String?
        get() = preferences.getString(KEY_SERVICE_PROBLEM, null)
        set(value) { preferences.edit { putString(KEY_SERVICE_PROBLEM, value) } }

    var lastImportStatus: String?
        get() = preferences.getString(KEY_IMPORT_STATUS, null)
        set(value) { preferences.edit { putString(KEY_IMPORT_STATUS, value) } }

    companion object {
        const val NAME = "infovore_location"
        private const val KEY_ENABLED = "tracking_enabled"
        private const val KEY_HIGH_ACCURACY = "high_accuracy"
        private const val KEY_LAST_FIX = "last_fix"
        private const val KEY_UPLOAD_STATUS = "last_upload_status"
        private const val KEY_UPLOAD_FAILED = "last_upload_failed"
        private const val KEY_SERVICE_PROBLEM = "service_problem"
        private const val KEY_IMPORT_STATUS = "last_import_status"
    }
}
