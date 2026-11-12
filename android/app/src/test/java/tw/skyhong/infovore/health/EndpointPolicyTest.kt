package tw.skyhong.infovore.health

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

/**
 * The private HTTP host comes from the Gradle property `infovore.tailscaleHttpHost` (BuildConfig);
 * the network layer allows it in res/xml/network_security_config.xml. Both must name the same
 * single host, so overriding one without the other fails here instead of on the phone.
 */
class EndpointPolicyTest {
    private fun networkConfig(): String {
        var dir: File? = File("").absoluteFile
        while (dir != null) {
            for (candidate in listOf("src/main/res/xml", "app/src/main/res/xml", "android/app/src/main/res/xml")) {
                val file = File(dir, "$candidate/network_security_config.xml")
                if (file.isFile) return file.readText()
            }
            dir = dir.parentFile
        }
        error("network_security_config.xml not found above ${File("").absolutePath}")
    }

    @Test
    fun theBuildConfigHostIsTheOnlyCleartextDomain() {
        val domains = Regex("<domain[^>]*>([^<]+)</domain>").findAll(networkConfig()).map { it.groupValues[1].trim() }.toList()
        assertEquals(listOf(BuildConfig.TAILSCALE_HTTP_HOST), domains)
        assertEquals(BuildConfig.TAILSCALE_HTTP_HOST, EndpointPolicy.TAILSCALE_HTTP_HOST)
    }

    @Test
    fun onlyThatHostMayUsePlainHttp() {
        assertTrue(EndpointPolicy.isAllowed("https", "infovore.example"))
        assertTrue(EndpointPolicy.isAllowed("http", EndpointPolicy.TAILSCALE_HTTP_HOST))
        assertFalse(EndpointPolicy.isAllowed("http", "infovore.example"))
        assertFalse(EndpointPolicy.isAllowed("http", "100.85.214.26"))
    }
}
