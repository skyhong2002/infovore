package tw.skyhong.infovore.health

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import tw.skyhong.infovore.health.DestinationChange.Action

class DestinationChangeTest {
    private val saved = "https://infovore.skyhong.tw"

    @Test
    fun sameDestinationWrittenDifferentlyKeepsTheCursor() {
        for (same in listOf(
            "https://infovore.skyhong.tw/",
            "  https://infovore.skyhong.tw//  ",
            "HTTPS://Infovore.SkyHong.tw",
            "https://infovore.skyhong.tw:443",
        )) {
            assertFalse(same, DestinationChange.isNewDestination(saved, same))
            assertEquals(same, Action.KEEP, DestinationChange.decide(saved, same, hasSyncProgress = true))
        }
    }

    @Test
    fun aDifferentHostPortSchemeOrPathIsANewDestination() {
        for (other in listOf(
            "https://other.example.com",
            "https://infovore.skyhong.tw:8443",
            "http://infovore.skyhong.tw",
            "https://infovore.skyhong.tw/ingest",
        )) {
            assertTrue(other, DestinationChange.isNewDestination(saved, other))
        }
        assertFalse(DestinationChange.isNewDestination("https://h.example/Path", "https://h.example/Path/"))
        assertTrue(DestinationChange.isNewDestination("https://h.example/Path", "https://h.example/path"))
    }

    @Test
    fun aNewDestinationAfterASyncAsksFirst() {
        assertEquals(Action.CONFIRM_RESET, DestinationChange.decide(saved, "https://new.example", hasSyncProgress = true))
        assertEquals(Action.RESET, DestinationChange.decide(saved, "https://new.example", hasSyncProgress = false))
    }

    @Test
    fun theFieldNoteAppearsOnlyWhenTheResetNeedsConfirmation() {
        assertNotNull(DestinationChange.fieldNote(saved, "https://new.example", hasSyncProgress = true))
        assertNull(DestinationChange.fieldNote(saved, "https://new.example", hasSyncProgress = false))
        assertNull(DestinationChange.fieldNote(saved, "$saved/", hasSyncProgress = true))
    }

    @Test
    fun reimportDaysFollowTheHistoryPermissionCap() {
        assertEquals(7, DestinationChange.reimportDays(7, historyPermissionGranted = false))
        assertEquals(30, DestinationChange.reimportDays(365, historyPermissionGranted = false))
        assertEquals(365, DestinationChange.reimportDays(365, historyPermissionGranted = true))
        assertTrue(DestinationChange.resetStatus(30).contains("最近 30 天"))
    }

    @Test
    fun unparseableValuesFallBackToTrimmedText() {
        assertEquals("not a url", DestinationChange.normalize(" not a url/ "))
    }
}
