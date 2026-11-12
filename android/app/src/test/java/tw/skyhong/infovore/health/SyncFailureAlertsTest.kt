package tw.skyhong.infovore.health

import androidx.health.connect.client.permission.HealthPermission
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import tw.skyhong.infovore.health.SyncFailureAlerts.Outcome

class SyncFailureAlertsTest {
    private fun runPeriods(outcomes: List<Outcome>, enabled: Boolean = true): List<SyncFailureAlerts.Decision> {
        var failures = 0
        return outcomes.map { outcome ->
            SyncFailureAlerts.next(failures, outcome, enabled).also { failures = it.failures }
        }
    }

    @Test
    fun notifiesOnTheThirdConsecutiveFinalFailure() {
        val decisions = runPeriods(listOf(Outcome.FINAL_FAILURE, Outcome.FINAL_FAILURE, Outcome.FINAL_FAILURE, Outcome.FINAL_FAILURE))
        assertEquals(listOf(false, false, true, true), decisions.map { it.notify })
        assertEquals(listOf(1, 2, 3, 4), decisions.map { it.failures })
        // About 18 hours of six-hourly syncs: earlier than the public page's 36-hour staleness.
        assertTrue(SyncFailureAlerts.THRESHOLD * SyncFailureAlerts.PERIOD_HOURS < 36)
    }

    @Test
    fun retriesWithinAPeriodDoNotCount() {
        val decisions = runPeriods(List(10) { Outcome.RETRY } + Outcome.FINAL_FAILURE)
        assertEquals(1, decisions.last().failures)
        assertTrue(decisions.none { it.notify })
        assertFalse(SyncFailureAlerts.isFinalAttempt(SyncFailureAlerts.MAX_RETRIES - 1))
        assertTrue(SyncFailureAlerts.isFinalAttempt(SyncFailureAlerts.MAX_RETRIES))
    }

    @Test
    fun aSuccessResetsTheCountAndClearsTheNotification() {
        val decisions = runPeriods(
            listOf(Outcome.FINAL_FAILURE, Outcome.FINAL_FAILURE, Outcome.SUCCESS, Outcome.FINAL_FAILURE, Outcome.FINAL_FAILURE),
        )
        assertTrue(decisions[2].clear)
        assertEquals(0, decisions[2].failures)
        assertEquals(2, decisions.last().failures)
        assertTrue(decisions.none { it.notify })
    }

    @Test
    fun nothingIsPostedUnlessTheUserTurnedItOn() {
        val decisions = runPeriods(List(5) { Outcome.FINAL_FAILURE }, enabled = false)
        assertTrue(decisions.none { it.notify })
        assertEquals(5, decisions.last().failures)
    }

    @Test
    fun turningNotificationsOnDeliversAWarningThatAlreadyApplies() {
        // Three failures counted while notifications were off: nothing was posted ...
        val decisions = runPeriods(List(3) { Outcome.FINAL_FAILURE }, enabled = false)
        assertTrue(decisions.none { it.notify })
        // ... and turning them on shows it at once.
        assertTrue(SyncFailureAlerts.catchUp(decisions.last().failures, notificationsEnabled = true))
        assertFalse(SyncFailureAlerts.catchUp(decisions.last().failures, notificationsEnabled = false))
        // Below the threshold there is nothing to catch up on.
        assertFalse(SyncFailureAlerts.catchUp(SyncFailureAlerts.THRESHOLD - 1, notificationsEnabled = true))
        assertFalse(SyncFailureAlerts.catchUp(0, notificationsEnabled = true))
    }

    @Test
    fun theTextHasCountsOnly() {
        val text = SyncFailureAlerts.title() + SyncFailureAlerts.text(3)
        assertTrue(text.contains("連續失敗 3 次"))
        assertFalse(Regex("token|HTTP|bpm|kg|步數|心率|睡眠", RegexOption.IGNORE_CASE).containsMatchIn(text))
    }

    @Test
    fun theCatalogMatchesHealthConnectPermissions() {
        assertEquals(HealthConnectSync.readPermissions, HealthCatalog.readPermissions)
        assertEquals(HealthPermission.PERMISSION_READ_HEALTH_DATA_HISTORY, HealthCatalog.HISTORY_PERMISSION)
        assertEquals(
            HealthConnectSync.recordTypes.map(HealthRecordJson::typeName).toSet(),
            HealthCatalog.all.map { it.key }.toSet(),
        )
    }
}
