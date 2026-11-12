package tw.skyhong.infovore.health

/**
 * Which endpoints the app may talk to: HTTPS anywhere, plain HTTP only to the private Tailscale
 * host that network_security_config.xml also allows. Shared by the form validator and [InfovoreApi]
 * so both layers accept exactly the same range. The host comes from the Gradle property
 * `infovore.tailscaleHttpHost` (see android/README.md); EndpointPolicyTest checks that it matches
 * the network security config.
 */
object EndpointPolicy {
    const val TAILSCALE_HTTP_HOST: String = BuildConfig.TAILSCALE_HTTP_HOST

    fun isAllowed(scheme: String, host: String): Boolean =
        scheme == "https" || (scheme == "http" && host == TAILSCALE_HTTP_HOST)
}
