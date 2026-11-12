package tw.skyhong.infovore.health

import android.content.Context
import androidx.annotation.VisibleForTesting
import androidx.health.connect.client.HealthConnectClient

/**
 * How the app reaches Health Connect: its availability and the client. Always the real
 * [HealthConnectClient] in the app; Robolectric tests, where Health Connect does not exist, set
 * [testClient] to a FakeHealthConnectClient (androidx.health.connect:connect-testing), which
 * implements the same interface.
 */
object HealthConnectAccess {
    /** Test only: replaces the client, and makes Health Connect report itself available. */
    @VisibleForTesting
    @Volatile
    internal var testClient: HealthConnectClient? = null

    fun sdkStatus(context: Context): Int =
        if (testClient != null) HealthConnectClient.SDK_AVAILABLE else HealthConnectClient.getSdkStatus(context)

    fun client(context: Context): HealthConnectClient = testClient ?: HealthConnectClient.getOrCreate(context)
}
