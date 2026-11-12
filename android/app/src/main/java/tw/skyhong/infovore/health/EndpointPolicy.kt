package tw.skyhong.infovore.health

/**
 * Which endpoints the app may talk to: HTTPS anywhere, plain HTTP only to the private Tailscale
 * host that network_security_config.xml also allows. Shared by the form validator and [InfovoreApi]
 * so both layers accept exactly the same range.
 */
object EndpointPolicy {
    const val TAILSCALE_HTTP_HOST = "100.85.214.25"

    fun isAllowed(scheme: String, host: String): Boolean =
        scheme == "https" || (scheme == "http" && host == TAILSCALE_HTTP_HOST)
}
