package tw.skyhong.infovore.health

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import androidx.core.content.edit
import java.security.KeyStore
import java.util.UUID
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

class SecureSettings(context: Context) {
    private val preferences = context.getSharedPreferences("infovore_health", Context.MODE_PRIVATE)
    private val cipher = KeystoreCipher(KEY_ALIAS)

    var endpoint: String
        get() = preferences.getString(KEY_ENDPOINT, DEFAULT_ENDPOINT) ?: DEFAULT_ENDPOINT
        set(value) { preferences.edit { putString(KEY_ENDPOINT, value.trim().trimEnd('/')) } }

    var token: String
        get() = cipher.decrypt(preferences.getString(KEY_TOKEN, null))
        set(value) { preferences.edit { putString(KEY_TOKEN, cipher.encrypt(value.trim())) } }

    val deviceId: String
        get() {
            val current = preferences.getString(KEY_DEVICE_ID, null)
            if (current != null) return current
            val created = UUID.randomUUID().toString()
            preferences.edit { putString(KEY_DEVICE_ID, created) }
            return created
        }

    var changesToken: String?
        get() = preferences.getString(KEY_CHANGES_TOKEN, null)
        set(value) { preferences.edit { putString(KEY_CHANGES_TOKEN, value) } }

    /** Days of history read during the initial scan and each sleep refresh. */
    var historyDays: Int
        get() = preferences.getInt(KEY_HISTORY_DAYS, DEFAULT_HISTORY_DAYS).coerceIn(1, MAX_HISTORY_DAYS)
        set(value) { preferences.edit { putInt(KEY_HISTORY_DAYS, value.coerceIn(1, MAX_HISTORY_DAYS)) } }

    var lastStatus: String
        get() = preferences.getString(KEY_LAST_STATUS, "尚未同步") ?: "尚未同步"
        set(value) { preferences.edit { putString(KEY_LAST_STATUS, value) } }

    /** Whether the most recent finished full sync (manual or background) failed. */
    var lastSyncFailed: Boolean
        get() = preferences.getBoolean(KEY_LAST_SYNC_FAILED, false)
        set(value) { preferences.edit { putBoolean(KEY_LAST_SYNC_FAILED, value) } }

    /**
     * True once a full sync (initial history plus the follow-up incremental pass) finished
     * successfully. A saved cursor alone is not enough: it is stored after the history scan,
     * before the incremental pass that can still fail. Installs from before this flag existed
     * fall back to "has a cursor and the last sync did not fail".
     */
    var initialImportDone: Boolean
        get() = if (preferences.contains(KEY_FIRST_SYNC_DONE)) preferences.getBoolean(KEY_FIRST_SYNC_DONE, false)
            else changesToken != null && !lastSyncFailed
        set(value) { preferences.edit { putBoolean(KEY_FIRST_SYNC_DONE, value) } }

    /** A change token exists or a full sync has finished, i.e. there is sync state tied to the endpoint. */
    val hasSyncProgress: Boolean get() = changesToken != null || initialImportDone

    /**
     * Saves [newEndpoint] and forgets the sync state of the previous destination in one write: the
     * change token is cleared so the next full sync re-imports history, and the first-sync and
     * failure flags start over. [status] becomes the last full-sync status shown on screen
     * (null shows "尚未同步").
     */
    fun changeEndpointAndResetSync(newEndpoint: String, status: String?) {
        preferences.edit {
            putString(KEY_ENDPOINT, newEndpoint.trim().trimEnd('/'))
            remove(KEY_CHANGES_TOKEN)
            removeHistoryScan()
            putBoolean(KEY_FIRST_SYNC_DONE, false)
            putBoolean(KEY_LAST_SYNC_FAILED, false)
            if (status == null) remove(KEY_LAST_STATUS) else putString(KEY_LAST_STATUS, status)
        }
    }

    /** An interrupted history scan to resume, or null. See [HistoryScan]. */
    val historyScan: HistoryScan?
        get() {
            val token = preferences.getString(KEY_SCAN_TOKEN, null) ?: return null
            return HistoryScan(
                changesToken = token,
                startMs = preferences.getLong(KEY_SCAN_START, 0L),
                endMs = preferences.getLong(KEY_SCAN_END, 0L),
                destination = preferences.getString(KEY_SCAN_DESTINATION, null) ?: return null,
                completed = preferences.getStringSet(KEY_SCAN_COMPLETED, null).orEmpty().toSet(),
            )
        }

    fun saveHistoryScan(scan: HistoryScan) {
        preferences.edit {
            putString(KEY_SCAN_TOKEN, scan.changesToken)
            putLong(KEY_SCAN_START, scan.startMs)
            putLong(KEY_SCAN_END, scan.endMs)
            putString(KEY_SCAN_DESTINATION, scan.destination)
            putStringSet(KEY_SCAN_COMPLETED, scan.completed.toSet())
        }
    }

    /** Ends a scan: its token becomes the sync cursor and the saved progress goes, in one write. */
    fun finishHistoryScan(changesToken: String) {
        preferences.edit {
            putString(KEY_CHANGES_TOKEN, changesToken)
            removeHistoryScan()
        }
    }

    /** Forgets the cursor and any interrupted scan, e.g. after Health Connect expired the token. */
    fun resetChangesToken() {
        preferences.edit {
            remove(KEY_CHANGES_TOKEN)
            removeHistoryScan()
        }
    }

    private fun android.content.SharedPreferences.Editor.removeHistoryScan() {
        remove(KEY_SCAN_TOKEN)
        remove(KEY_SCAN_START)
        remove(KEY_SCAN_END)
        remove(KEY_SCAN_DESTINATION)
        remove(KEY_SCAN_COMPLETED)
    }

    /** History is uploaded and a cursor exists, but the first full sync has not finished yet. */
    val initialImportPartial: Boolean get() = !initialImportDone && changesToken != null

    var lastSleepStatus: String
        get() = preferences.getString("last_sleep_status", "睡眠尚未檢查") ?: "睡眠尚未檢查"
        set(value) { preferences.edit { putString("last_sleep_status", value) } }

    companion object {
        const val DEFAULT_ENDPOINT = "https://infovore.skyhong.tw"
        const val DEFAULT_HISTORY_DAYS = 7
        const val MAX_HISTORY_DAYS = 3650
        private const val KEY_HISTORY_DAYS = "history_days"
        private const val KEY_ENDPOINT = "endpoint"
        private const val KEY_TOKEN = "token"
        private const val KEY_DEVICE_ID = "device_id"
        private const val KEY_CHANGES_TOKEN = "changes_token"
        private const val KEY_LAST_STATUS = "last_status"
        private const val KEY_LAST_SYNC_FAILED = "last_sync_failed"
        private const val KEY_FIRST_SYNC_DONE = "first_full_sync_done"
        private const val KEY_ALIAS = "infovore-health-ingest-token"
        private const val KEY_SCAN_TOKEN = "history_scan_token"
        private const val KEY_SCAN_START = "history_scan_start"
        private const val KEY_SCAN_END = "history_scan_end"
        private const val KEY_SCAN_DESTINATION = "history_scan_destination"
        private const val KEY_SCAN_COMPLETED = "history_scan_completed"
    }
}

/** AES-GCM encryption with a non-exportable Android Keystore key under [alias]. */
class KeystoreCipher(private val alias: String) {
    private fun secretKey(): SecretKey {
        val keyStore = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
        (keyStore.getKey(alias, null) as? SecretKey)?.let { return it }
        return KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore").run {
            init(
                KeyGenParameterSpec.Builder(
                    alias,
                    KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT,
                ).setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                    .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                    .build()
            )
            generateKey()
        }
    }

    fun encrypt(value: String): String {
        if (value.isEmpty()) return ""
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.ENCRYPT_MODE, secretKey())
        val iv = Base64.encodeToString(cipher.iv, Base64.NO_WRAP)
        val encrypted = Base64.encodeToString(cipher.doFinal(value.toByteArray()), Base64.NO_WRAP)
        return "$iv:$encrypted"
    }

    fun decrypt(value: String?): String {
        if (value.isNullOrEmpty()) return ""
        return runCatching {
            val (iv, encrypted) = value.split(':', limit = 2)
            val cipher = Cipher.getInstance("AES/GCM/NoPadding")
            cipher.init(
                Cipher.DECRYPT_MODE,
                secretKey(),
                GCMParameterSpec(128, Base64.decode(iv, Base64.NO_WRAP)),
            )
            String(cipher.doFinal(Base64.decode(encrypted, Base64.NO_WRAP)))
        }.getOrDefault("")
    }
}
