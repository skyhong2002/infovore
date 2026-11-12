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
import java.time.Instant
import java.time.ZoneId

class StatusMappingTest {
    private val sleep = "perm.SLEEP"
    private val required = setOf(sleep, "perm.STEPS", "perm.HEART_RATE")

    private fun health(
        availability: HealthConnectAvailability? = HealthConnectAvailability.AVAILABLE,
        granted: Set<String>? = required,
        connectionProblem: String? = null,
        syncing: Boolean = false,
        noEffect: Boolean = false,
        permissionError: String? = null,
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
            permissionRequestHadNoEffect = noEffect,
            permissionError = permissionError,
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
        assertTrue(ui.detail!!.contains("背景讀取：未允許"))
        assertTrue(ui.detail!!.contains("完整歷史：已允許"))
        assertNull(ui.syncHint)
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
    fun setupMarksEarliestMissingStepEvenIfLaterOnesAreDone() {
        // Token removed after a completed import: step 1 is the next step, step 3 stays done.
        val steps = SetupProgress.compute(connectionSaved = false, permissionsGranted = true, firstSyncDone = true)
        assertEquals(listOf(StepState.CURRENT, StepState.DONE, StepState.DONE), steps.map { it.state })
    }

    private val zone = ZoneId.of("Asia/Taipei")
    private val nowMs = Instant.parse("2026-11-12T06:00:00Z").toEpochMilli()

    private fun screen(
        enabled: Boolean = false,
        pausedUntil: Long = 0,
        service: Boolean = false,
        token: Boolean = true,
        pending: Int = 0,
    ) = ScreenStatus.map(
        ScreenInputs(
            recordingEnabled = enabled,
            pausedUntilMs = pausedUntil,
            serviceEnabled = service,
            tokenConfigured = token,
            pending = pending,
            lastCaptureAtMs = 0,
            lastUploadStatus = "尚未上傳",
            nowMs = nowMs,
            zone = zone,
        ),
    )

    @Test
    fun screenRecordingStates() {
        assertEquals(ScreenState.OFF, screen().state)
        assertEquals(ScreenState.NEEDS_SERVICE, screen(enabled = true).state)
        assertEquals(ScreenState.RECORDING, screen(enabled = true, service = true).state)
        val paused = screen(enabled = true, service = true, pausedUntil = nowMs + 42 * 60_000)
        assertEquals(ScreenState.PAUSED, paused.state)
        assertEquals("已暫停至 14:42（42 分鐘後恢復）", paused.headline)
        assertEquals("恢復記錄", paused.pauseLabel)
    }

    @Test
    fun screenOffNeverSuggestsItIsRecordingAndPauseIsDisabled() {
        val ui = screen()
        assertEquals("關閉", ui.summary)
        assertFalse(ui.pauseEnabled)
        assertTrue(ui.nextStep!!.startsWith("如要使用"))
    }

    @Test
    fun screenWarnsWhenRecordingWithoutToken() {
        val ui = screen(enabled = true, service = true, token = false, pending = 3)
        assertEquals(Tone.WARNING, ui.tone)
        assertTrue(ui.nextStep!!.contains("DAYFLOW_PHONE_TOKEN"))
        assertFalse(ui.uploadEnabled)
        assertEquals("記錄中 · 佇列 3 筆", ui.summary)
        assertTrue(ui.details.contains("最後擷取：尚未擷取"))
    }

    @Test
    fun uploadNeedsTokenAndPendingItems() {
        assertTrue(screen(pending = 2).uploadEnabled)
        assertFalse(screen(pending = 0).uploadEnabled)
        assertEquals("佇列中沒有待上傳的紀錄", screen(pending = 0).uploadHint)
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
