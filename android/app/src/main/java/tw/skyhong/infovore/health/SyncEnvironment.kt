package tw.skyhong.infovore.health

import androidx.annotation.VisibleForTesting
import java.util.UUID

/**
 * The clock and batch ids of Health Connect syncs ([HealthConnectSync]), and the HTTP client's
 * retry timing. Always the system clock
 * and random UUIDs in the app; Robolectric tests replace them (as they replace the Health Connect
 * client, see [HealthConnectAccess]) so that a recorded sync sends byte-for-byte the same requests
 * on every run (tests/fixtures/android-sync-golden.json).
 */
object SyncEnvironment {
    @VisibleForTesting
    @Volatile
    internal var testClock: (() -> Long)? = null

    @VisibleForTesting
    @Volatile
    internal var testSyncIds: (() -> String)? = null

    /** Test only: the HTTP client's timeouts and retry waits (recorded instead of slept). */
    @VisibleForTesting
    @Volatile
    internal var testApiTiming: InfovoreApi.Timing? = null

    fun nowMs(): Long = testClock?.invoke() ?: System.currentTimeMillis()

    /** Timeouts and retry waits of every [InfovoreApi] the app creates. */
    fun apiTiming(): InfovoreApi.Timing = testApiTiming ?: InfovoreApi.Timing()

    fun newSyncId(): String = testSyncIds?.invoke() ?: UUID.randomUUID().toString()
}
