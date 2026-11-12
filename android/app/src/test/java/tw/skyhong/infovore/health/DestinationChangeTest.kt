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

    @Test
    fun queuedScreenRecordsOrAPhoneTokenAskFirstEvenWithoutAHealthSync() {
        val new = "https://new.example"
        assertEquals(Action.RESET, DestinationChange.decide(saved, new, DestinationChange.Ties(hasSyncProgress = false)))
        assertEquals(Action.CONFIRM_RESET, DestinationChange.decide(saved, new, DestinationChange.Ties(false, screenPending = 2)))
        assertEquals(Action.CONFIRM_RESET, DestinationChange.decide(saved, new, DestinationChange.Ties(false, phoneTokenSaved = true)))
        assertEquals(Action.KEEP, DestinationChange.decide(saved, "$saved/", DestinationChange.Ties(true, 9, true)))
        assertNotNull(DestinationChange.fieldNote(saved, new, DestinationChange.Ties(false, screenPending = 2)))
    }

    @Test
    fun theConfirmationNamesEveryAffectedPart() {
        val all = DestinationChange.confirmMessage("new.example", DestinationChange.Ties(true, 12, true), reimportDays = 30)
        assertTrue(all.contains("new.example"))
        assertTrue(all.contains("最近 30 天"))
        assertTrue(all, all.contains("12 筆待傳紀錄屬於舊目的地，不會送到新目的地"))
        assertTrue(all.contains("DAYFLOW_PHONE_TOKEN 會被清除"))

        val screenOnly = DestinationChange.confirmMessage("new.example", DestinationChange.Ties(false, 3, false), reimportDays = null)
        assertTrue(screenOnly.contains("3 筆待傳紀錄"))
        assertFalse(screenOnly.contains("重新匯入"))
        assertFalse(screenOnly.contains("DAYFLOW_PHONE_TOKEN"))
    }
}
