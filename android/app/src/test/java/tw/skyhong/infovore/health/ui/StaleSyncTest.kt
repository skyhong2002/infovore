package tw.skyhong.infovore.health.ui

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.time.Duration
import java.time.Instant

/** The "no successful sync for over a day" box at the top of the health section. */
class StaleSyncTest {
    private val now = Instant.parse("2026-11-12T12:00:00Z")

    private fun map(
        hoursAgo: Long?,
        configured: Boolean = true,
        busy: Boolean = false,
        syncEnabled: Boolean = true,
        notificationsOn: Boolean = false,
    ) = StaleSync.map(
        lastSuccess = hoursAgo?.let { now.minus(Duration.ofHours(it)) },
        now = now,
        configured = configured,
        busy = busy,
        syncEnabled = syncEnabled,
        notificationsOn = notificationsOn,
    )

    @Test
    fun appearsOnlyAfterADayWithoutASuccessfulSync() {
        assertNull(map(hoursAgo = 3))
        assertNull(map(hoursAgo = 24))
        val stale = map(hoursAgo = 25)
        assertNotNull(stale)
        assertTrue(stale!!.text, stale.text.contains("已超過 24 小時沒有成功同步"))
        assertTrue(stale.text.contains("背景同步可能根本沒有執行"))
        assertEquals("超過 24 小時未同步", stale.summary)
        assertEquals("立即同步", stale.syncLabel)
        assertTrue(stale.syncEnabled)
        // Same threshold the server uses to call Health delayed.
        assertEquals(24L, StaleSync.THRESHOLD_HOURS)
    }

    @Test
    fun offersToTurnOnNotificationsOnlyWhenTheyAreOff() {
        val off = map(hoursAgo = 30, notificationsOn = false)!!
        assertEquals("開啟通知", off.notifyLabel)
        // Honest about what notifications cannot do.
        assertTrue(off.text, off.text.contains("App 完全沒有執行時無法發出任何通知"))
        val on = map(hoursAgo = 30, notificationsOn = true)!!
        assertNull(on.notifyLabel)
        assertFalse(on.text.contains("開啟通知後"))
    }

    @Test
    fun staysQuietBeforeSetupWhileSyncingOrWithoutAKnownSuccess() {
        assertNull(map(hoursAgo = 48, configured = false))
        assertNull(map(hoursAgo = 48, busy = true))
        assertNull(map(hoursAgo = null))
        // Sync not possible right now (e.g. a missing permission): the box shows, its button disabled.
        assertFalse(map(hoursAgo = 48, syncEnabled = false)!!.syncEnabled)
    }

    @Test
    fun theLastSuccessComesFromTheSavedTimeOrAnOlderInstallsStatusLine() {
        val saved = now.minus(Duration.ofHours(30)).toEpochMilli()
        assertEquals(Instant.ofEpochMilli(saved), StaleSync.lastSuccess(saved, "2026-11-12T11:00:00Z：同步失敗：x", lastSyncFailed = true))
        // 0.4.3 and earlier saved no time: a successful last status line gives it ...
        assertEquals(Instant.parse("2026-11-10T08:00:00Z"), StaleSync.lastSuccess(null, "2026-11-10T08:00:00Z：背景同步完成，新增 1、更新 0、刪除 0", lastSyncFailed = false))
        // ... a failed one does not, nor a line without a time.
        assertNull(StaleSync.lastSuccess(null, "2026-11-10T08:00:00Z：背景同步失敗：x", lastSyncFailed = true))
        assertNull(StaleSync.lastSuccess(null, "尚未同步", lastSyncFailed = false))
    }
}
