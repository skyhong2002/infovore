package tw.skyhong.infovore.health.ui

import androidx.health.connect.client.HealthConnectClient
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import tw.skyhong.infovore.health.InfovoreApi
import java.io.IOException
import java.net.SocketTimeoutException
import java.net.UnknownHostException

class StatusMappingTest {
    private val sleep = "perm.SLEEP"
    private val required = setOf(sleep, "perm.STEPS", "perm.HEART_RATE")

    private fun health(
        availability: HealthConnectAvailability? = HealthConnectAvailability.AVAILABLE,
        granted: Set<String>? = required,
        connectionProblem: String? = null,
        syncing: Boolean = false,
        backgroundSync: Boolean = false,
        noEffect: Boolean = false,
        permissionError: String? = null,
        backgroundSupported: Boolean? = null,
    ) = HealthStatus.map(
        HealthInputs(
            availability = availability,
            granted = granted,
            requiredRead = required,
            sleepPermission = sleep,
            backgroundPermission = "perm.BACKGROUND",
            historyPermission = "perm.HISTORY",
            connectionProblem = connectionProblem,
            syncing = syncing,
            backgroundSyncRunning = backgroundSync,
            permissionRequestHadNoEffect = noEffect,
            permissionError = permissionError,
            backgroundSupported = backgroundSupported,
        ),
    )

    @Test
    fun sdkStatusMapping() {
        assertEquals(HealthConnectAvailability.AVAILABLE, HealthConnectAvailability.fromSdkStatus(HealthConnectClient.SDK_AVAILABLE))
        assertEquals(
            HealthConnectAvailability.UPDATE_REQUIRED,
            HealthConnectAvailability.fromSdkStatus(HealthConnectClient.SDK_UNAVAILABLE_PROVIDER_UPDATE_REQUIRED),
        )
        assertEquals(HealthConnectAvailability.UNAVAILABLE, HealthConnectAvailability.fromSdkStatus(HealthConnectClient.SDK_UNAVAILABLE))
    }

    @Test
    fun updateRequiredOffersInstallAndBlocksSync() {
        val ui = health(availability = HealthConnectAvailability.UPDATE_REQUIRED, granted = null)
        assertEquals(HealthAction.INSTALL_OR_UPDATE, ui.action)
        assertEquals("安裝或更新 Health Connect", ui.actionLabel)
        assertFalse(ui.syncEnabled)
        assertFalse(ui.sleepEnabled)
        assertEquals(Tone.WARNING, ui.tone)
    }

    @Test
    fun unavailableHasNoActionAndExplainsWhy() {
        val ui = health(availability = HealthConnectAvailability.UNAVAILABLE, granted = null)
        assertEquals(HealthAction.NONE, ui.action)
        assertNull(ui.actionLabel)
        assertEquals("此裝置不支援 Health Connect", ui.syncHint)
        assertEquals(Tone.ERROR, ui.tone)
    }

    @Test
    fun stillCheckingDisablesEverything() {
        val ui = health(availability = null, granted = null)
        assertFalse(ui.syncEnabled || ui.sleepEnabled)
        assertEquals(HealthAction.NONE, ui.action)
    }

    @Test
    fun noPermissionsAsksToGrant() {
        val ui = health(granted = emptySet())
        assertEquals(HealthAction.GRANT, ui.action)
        assertFalse(ui.sleepEnabled)
        assertFalse(ui.syncEnabled)
    }

    @Test
    fun sleepOnlyRequiresJustTheSleepPermission() {
        val ui = health(granted = setOf(sleep))
        assertTrue(ui.sleepEnabled)
        assertFalse(ui.syncEnabled)
        assertTrue(ui.headline.contains("尚缺 2 項"))
        assertTrue(ui.syncHint!!.contains("只同步睡眠"))
    }

    @Test
    fun partialPermissionsWithoutSleepBlockSleepSync() {
        val ui = health(granted = setOf("perm.STEPS"))
        assertFalse(ui.sleepEnabled)
        assertFalse(ui.syncEnabled)
    }

    @Test
    fun allGrantedEnablesBothAndReportsOptionalPermissions() {
        val ui = health(granted = required + "perm.HISTORY")
        assertTrue(ui.syncEnabled && ui.sleepEnabled)
        assertEquals(HealthAction.MANAGE, ui.action)
        assertEquals(Tone.OK, ui.tone)
        assertTrue(ui.detail!!.contains("未允許背景讀取"))
        assertTrue(ui.detail!!.contains("可讀取完整歷史"))
        assertNull(ui.syncHint)
    }

    @Test
    fun backgroundReadingThatCouldBeAllowedButIsNotWarns() {
        val missing = health(granted = required, backgroundSupported = true)
        assertEquals(Tone.WARNING, missing.tone)
        assertEquals("未允許背景讀取", missing.headline)
        assertEquals("允許背景讀取", missing.actionLabel)
        assertTrue(missing.syncEnabled)
        val granted = health(granted = required + "perm.BACKGROUND", backgroundSupported = true)
        assertEquals(Tone.OK, granted.tone)
        assertTrue(granted.detail!!.contains("背景約每 6 小時同步"))
        val unsupported = health(granted = required, backgroundSupported = false)
        assertEquals(Tone.OK, unsupported.tone)
        assertTrue(unsupported.detail!!.contains("不支援背景讀取"))
    }

    @Test
    fun connectionProblemAndSyncingGateTheButtons() {
        val bad = health(connectionProblem = "請先儲存")
        assertFalse(bad.syncEnabled || bad.sleepEnabled)
        assertEquals("請先儲存", bad.syncHint)

        val busy = health(syncing = true)
        assertFalse(busy.syncEnabled || busy.sleepEnabled)
    }

    @Test
    fun syncingHintSaysWhetherLeavingTheScreenIsSafe() {
        val foregroundOnly = health(syncing = true)
        assertTrue(foregroundOnly.syncHint!!.contains("請保持此畫面開啟"))
        val withBackground = health(granted = required + "perm.BACKGROUND", syncing = true)
        assertTrue(withBackground.syncHint!!.contains("離開此畫面也會繼續"))
    }

    @Test
    fun aRunningBackgroundSyncBlocksManualSyncWithAReason() {
        val ui = health(backgroundSync = true)
        assertFalse(ui.syncEnabled || ui.sleepEnabled)
        assertEquals("背景同步正在進行，完成後即可手動同步", ui.syncHint)
    }

    @Test
    fun deniedPermissionDialogPointsToSettings() {
        val ui = health(granted = emptySet(), noEffect = true)
        assertEquals(HealthAction.MANAGE, ui.action)
        assertEquals("在 Health Connect 設定中授權", ui.actionLabel)
        assertTrue(ui.detail!!.contains("手動開啟"))
    }

    @Test
    fun permissionReadFailureIsAnError() {
        val ui = health(granted = null, permissionError = "boom")
        assertEquals(Tone.ERROR, ui.tone)
        assertTrue(ui.detail!!.startsWith("boom"))
        assertFalse(ui.syncEnabled)
    }

    @Test
    fun sleepFailurePrefixIsDetected() {
        assertTrue(HealthStatus.sleepStatusFailed("2026-11-12T05:00:00Z：睡眠未完成：timeout"))
        assertFalse(HealthStatus.sleepStatusFailed("2026-11-12T05:00:00Z：睡眠已上傳 3 筆"))
    }

    @Test
    fun setupStepsAdvanceInOrder() {
        val fresh = SetupProgress.compute(connectionSaved = false, permissionsGranted = false, firstSyncDone = false)
        assertEquals(listOf(StepState.CURRENT, StepState.PENDING, StepState.PENDING), fresh.map { it.state })
        assertEquals(SetupStep.CONNECTION, SetupProgress.nextStep(fresh))
        assertEquals("已完成 0 / 3 步", SetupProgress.summary(fresh))

        val granted = SetupProgress.compute(connectionSaved = true, permissionsGranted = true, firstSyncDone = false)
        assertEquals(SetupStep.FIRST_SYNC, SetupProgress.nextStep(granted))
        assertTrue(granted[2].accessibilityText.startsWith("步驟 3，下一步："))

        val done = SetupProgress.compute(connectionSaved = true, permissionsGranted = true, firstSyncDone = true)
        assertNull(SetupProgress.nextStep(done))
        assertEquals("設定完成", SetupProgress.summary(done))
    }

    @Test
    fun firstSyncTextReflectsBackgroundAccessAndPartialImports() {
        fun done(background: BackgroundSync) = SetupProgress.compute(true, true, true, background)[2].text
        assertTrue(done(BackgroundSync.GRANTED).contains("約每 6 小時在背景嘗試"))
        assertTrue(done(BackgroundSync.NOT_GRANTED).contains("尚未允許背景讀取"))
        assertTrue(done(BackgroundSync.UNSUPPORTED).contains("不支援背景讀取"))
        listOf(BackgroundSync.NOT_GRANTED, BackgroundSync.UNSUPPORTED, BackgroundSync.UNKNOWN).forEach {
            assertFalse(done(it).contains("約每 6 小時在背景"))
        }
        val partial = SetupProgress.compute(true, true, firstSyncDone = false, partialImport = true)
        assertEquals(StepState.CURRENT, partial[2].state)
        assertTrue(partial[2].text.contains("還沒完整完成"))
        assertEquals("設定完成", SetupProgress.summary(SetupProgress.compute(true, true, true, BackgroundSync.GRANTED, partialImport = true)))
    }

    @Test
    fun setupMarksEarliestMissingStepEvenIfLaterOnesAreDone() {
        // Token removed after a completed import: step 1 is the next step, step 3 stays done.
        val steps = SetupProgress.compute(connectionSaved = false, permissionsGranted = true, firstSyncDone = true)
        assertEquals(listOf(StepState.CURRENT, StepState.DONE, StepState.DONE), steps.map { it.state })
    }

    @Test
    fun errorTextExplainsCommonFailures() {
        assertTrue(ErrorText.describe(InfovoreApi.HttpStatusException(401, "Infovore HTTP 401: no")).contains("token"))
        assertTrue(ErrorText.describe(InfovoreApi.HttpStatusException(413, "x")).contains("縮小初始同步天數"))
        assertTrue(ErrorText.describe(UnknownHostException("h")).contains("Tailscale"))
        assertTrue(ErrorText.describe(SocketTimeoutException()).contains("逾時"))
        assertTrue(ErrorText.describe(IOException("Infovore HTTP 502: bad gateway")).contains("HTTP 502"))
        assertEquals("請先儲存 endpoint 與 token", ErrorText.describe(IllegalArgumentException("請先儲存 endpoint 與 token")))
        assertEquals(
            "伺服器回應錯誤（HTTP 422）：bad record",
            ErrorText.describe(InfovoreApi.HttpStatusException(422, "Infovore HTTP 422: bad record")),
        )
    }
}
