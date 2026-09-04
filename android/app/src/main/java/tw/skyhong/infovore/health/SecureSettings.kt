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

    var endpoint: String
        get() = preferences.getString(KEY_ENDPOINT, DEFAULT_ENDPOINT) ?: DEFAULT_ENDPOINT
        set(value) { preferences.edit { putString(KEY_ENDPOINT, value.trim().trimEnd('/')) } }

    var token: String
        get() = decrypt(preferences.getString(KEY_TOKEN, null))
        set(value) { preferences.edit { putString(KEY_TOKEN, encrypt(value.trim())) } }

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

    var lastStatus: String
        get() = preferences.getString(KEY_LAST_STATUS, "尚未同步") ?: "尚未同步"
        set(value) { preferences.edit { putString(KEY_LAST_STATUS, value) } }

    private fun secretKey(): SecretKey {
        val keyStore = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
        (keyStore.getKey(KEY_ALIAS, null) as? SecretKey)?.let { return it }
        return KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore").run {
            init(
                KeyGenParameterSpec.Builder(
                    KEY_ALIAS,
                    KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT,
                ).setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                    .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                    .build()
            )
            generateKey()
        }
    }

    private fun encrypt(value: String): String {
        if (value.isEmpty()) return ""
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.ENCRYPT_MODE, secretKey())
        val iv = Base64.encodeToString(cipher.iv, Base64.NO_WRAP)
        val encrypted = Base64.encodeToString(cipher.doFinal(value.toByteArray()), Base64.NO_WRAP)
        return "$iv:$encrypted"
    }

    private fun decrypt(value: String?): String {
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

    companion object {
        const val DEFAULT_ENDPOINT = "https://infovore.skyhong.tw"
        private const val KEY_ENDPOINT = "endpoint"
        private const val KEY_TOKEN = "token"
        private const val KEY_DEVICE_ID = "device_id"
        private const val KEY_CHANGES_TOKEN = "changes_token"
        private const val KEY_LAST_STATUS = "last_status"
        private const val KEY_ALIAS = "infovore-health-ingest-token"
    }
}
