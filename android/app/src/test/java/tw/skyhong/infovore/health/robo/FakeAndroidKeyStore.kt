package tw.skyhong.infovore.health.robo

import android.security.keystore.KeyGenParameterSpec
import java.io.InputStream
import java.io.OutputStream
import java.security.Key
import java.security.KeyStoreSpi
import java.security.Provider
import java.security.SecureRandom
import java.security.Security
import java.security.cert.Certificate
import java.security.spec.AlgorithmParameterSpec
import java.util.Collections
import java.util.Date
import java.util.Enumeration
import java.util.concurrent.ConcurrentHashMap
import javax.crypto.KeyGeneratorSpi
import javax.crypto.SecretKey
import javax.crypto.spec.SecretKeySpec

/**
 * Robolectric has no "AndroidKeyStore" provider, so [tw.skyhong.infovore.health.KeystoreCipher]
 * could not save a token. This stand-in keeps AES keys in memory under the same provider and
 * algorithm names; the app's code (AES-GCM through the alias) runs unchanged on top of it.
 */
object FakeAndroidKeyStore {
    private const val NAME = "AndroidKeyStore"
    private val keys = ConcurrentHashMap<String, Key>()

    fun install() {
        if (Security.getProvider(NAME) != null) return
        Security.addProvider(Stand())
    }

    @Suppress("DEPRECATION")
    private class Stand : Provider(NAME, 1.0, "Robolectric stand-in for the Android Keystore") {
        init {
            putService(object : Service(this, "KeyStore", NAME, Store::class.java.name, null, null) {
                override fun newInstance(constructorParameter: Any?): Any = Store()
            })
            putService(object : Service(this, "KeyGenerator", "AES", Generator::class.java.name, null, null) {
                override fun newInstance(constructorParameter: Any?): Any = Generator()
            })
        }
    }

    class Generator : KeyGeneratorSpi() {
        private var alias: String? = null
        private val random = SecureRandom()

        override fun engineInit(random: SecureRandom?) = Unit

        override fun engineInit(params: AlgorithmParameterSpec?, random: SecureRandom?) {
            alias = (params as KeyGenParameterSpec).keystoreAlias
        }

        override fun engineInit(keysize: Int, random: SecureRandom?) = Unit

        override fun engineGenerateKey(): SecretKey {
            val key = SecretKeySpec(ByteArray(32).also(random::nextBytes), "AES")
            keys[requireNotNull(alias)] = key
            return key
        }
    }

    class Store : KeyStoreSpi() {
        override fun engineGetKey(alias: String, password: CharArray?): Key? = keys[alias]
        override fun engineGetCertificateChain(alias: String?): Array<Certificate>? = null
        override fun engineGetCertificate(alias: String?): Certificate? = null
        override fun engineGetCreationDate(alias: String?): Date? = null
        override fun engineSetKeyEntry(alias: String, key: Key, password: CharArray?, chain: Array<out Certificate>?) {
            keys[alias] = key
        }
        override fun engineSetKeyEntry(alias: String?, key: ByteArray?, chain: Array<out Certificate>?) = throw UnsupportedOperationException()
        override fun engineSetCertificateEntry(alias: String?, cert: Certificate?) = throw UnsupportedOperationException()
        override fun engineDeleteEntry(alias: String) {
            keys.remove(alias)
        }
        override fun engineAliases(): Enumeration<String> = Collections.enumeration(keys.keys)
        override fun engineContainsAlias(alias: String): Boolean = keys.containsKey(alias)
        override fun engineSize(): Int = keys.size
        override fun engineIsKeyEntry(alias: String): Boolean = keys.containsKey(alias)
        override fun engineIsCertificateEntry(alias: String?): Boolean = false
        override fun engineGetCertificateAlias(cert: Certificate?): String? = null
        override fun engineStore(stream: OutputStream?, password: CharArray?) = Unit
        override fun engineLoad(stream: InputStream?, password: CharArray?) = Unit
    }
}
