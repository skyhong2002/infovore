package tw.skyhong.infovore.health.robo

import android.content.Context
import android.view.View
import android.widget.Button
import androidx.appcompat.app.AlertDialog
import androidx.core.content.edit
import androidx.health.connect.client.permission.HealthPermission
import androidx.health.connect.client.records.BodyFatRecord
import androidx.health.connect.client.records.DistanceRecord
import androidx.health.connect.client.records.ExerciseSessionRecord
import androidx.health.connect.client.records.HeartRateRecord
import androidx.health.connect.client.records.Record
import androidx.health.connect.client.records.SleepSessionRecord
import androidx.health.connect.client.records.StepsRecord
import androidx.health.connect.client.records.TotalCaloriesBurnedRecord
import androidx.health.connect.client.records.WeightRecord
import androidx.health.connect.client.records.metadata.Metadata
import androidx.health.connect.client.testing.FakeHealthConnectClient
import androidx.health.connect.client.testing.FakePermissionController
import androidx.health.connect.client.units.Energy
import androidx.health.connect.client.units.Length
import androidx.health.connect.client.units.Mass
import androidx.health.connect.client.units.Percentage
import kotlinx.coroutines.runBlocking
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.Robolectric
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import org.robolectric.shadows.ShadowDialog
import tw.skyhong.infovore.health.CanonicalJson
import tw.skyhong.infovore.health.EndpointPolicy
import tw.skyhong.infovore.health.FakeIngestServer
import tw.skyhong.infovore.health.HealthCatalog
import tw.skyhong.infovore.health.HealthConnectAccess
import tw.skyhong.infovore.health.HealthConnectSync
import tw.skyhong.infovore.health.MainActivity
import tw.skyhong.infovore.health.MiniJson
import tw.skyhong.infovore.health.R
import tw.skyhong.infovore.health.ReconcileGaps
import tw.skyhong.infovore.health.SyncEnvironment
import tw.skyhong.infovore.health.SyncRunner
import tw.skyhong.infovore.health.repoFile
import tw.skyhong.infovore.health.robo.Robo.descendants
import tw.skyhong.infovore.health.robo.Robo.hasVisibleText
import java.time.Clock
import java.time.Instant
import java.time.ZoneId
import java.time.ZoneOffset
import java.util.concurrent.atomic.AtomicInteger

/**
 * The two main flows of the health section, end to end inside the app: the real MainActivity,
 * SyncRunner, HealthSyncEngine, HealthConnectReader (over FakeHealthConnectClient with synthetic
 * records) and InfovoreApi, talking HTTP to a local [FakeIngestServer].
 *
 * The successful first sync is also the Android half of the cross-language chain test: the exact
 * requests it sends are compared with tests/fixtures/android-sync-golden.json, and the server's
 * tests/android-chain.test.ts replays that same file into the real ingest service and checks the
 * public pages. Regenerate the file after an intended wire change with
 * `INFOVORE_UPDATE_GOLDEN=1 ./gradlew testDebugUnitTest --tests '*SyncFlowUiTest*'` and commit it
 * together with a passing server test.
 */
@RunWith(RobolectricTestRunner::class)
@Config(qualifiers = "w411dp-h891dp-xxhdpi")
class SyncFlowUiTest {
    /** Ticks a millisecond per call so the fake's change log stays ordered; deterministic. */
    private class TickingClock(private var ms: Long) : Clock() {
        override fun instant(): Instant = Instant.ofEpochMilli(ms++)
        override fun getZone(): ZoneId = ZoneOffset.UTC
        override fun withZone(zone: ZoneId?): Clock = this
    }

    private val server = FakeIngestServer()
    private val syncIds = AtomicInteger()

    @Before
    fun setUp() {
        EndpointPolicy.testHttpHost = "127.0.0.1"
        SyncEnvironment.testClock = { NOW.toEpochMilli() }
        SyncEnvironment.testSyncIds = { "android-golden-sync-%04d".format(syncIds.incrementAndGet()) }
        val settings = Robo.settings()
        settings.endpoint = server.endpoint
        settings.token = TOKEN
        Robo.app.getSharedPreferences("infovore_health", Context.MODE_PRIVATE).edit { putString("device_id", DEVICE_ID) }
    }

    @After
    fun tearDown() {
        server.close()
        EndpointPolicy.testHttpHost = null
        SyncEnvironment.testClock = null
        SyncEnvironment.testSyncIds = null
    }

    private fun healthConnect(records: List<Record>) {
        val permissions = FakePermissionController(grantAll = false).apply {
            grantPermissions(HealthConnectSync.readPermissions + HealthCatalog.HISTORY_PERMISSION + HealthPermission.PERMISSION_READ_HEALTH_DATA_IN_BACKGROUND)
        }
        val fake = FakeHealthConnectClient(packageName = ORIGIN, clock = TickingClock(NOW.toEpochMilli() - 3_600_000L), permissionController = permissions)
        runBlocking { fake.insertRecords(records) }
        HealthConnectAccess.testClient = fake
    }

    private fun launch(): MainActivity {
        val controller = Robolectric.buildActivity(MainActivity::class.java).setup()
        Robo.waitFor { true }
        return controller.get()
    }

    private val MainActivity.root: View get() = window.decorView

    /** The health section's own "立即同步" (the setup card's next-step button has the same label and comes first). */
    private fun syncButton(activity: MainActivity): Button =
        descendants(activity.root).filterIsInstance<Button>().last { it.text.toString() == activity.getString(R.string.action_sync_all) && it.isShown }

    private fun waitForSyncToFinish() {
        Robo.waitFor(timeoutMs = 30_000) { SyncRunner.state.value.running == null && !SyncRunner.coordinator.state.value.busy }
        Robo.idle()
    }

    @Suppress("UNCHECKED_CAST")
    private fun json(text: String) = MiniJson.parse(text) as Map<String, Any?>

    private fun intOf(value: Any?): Int = (value as Double).toInt()

    // ---- Successful first sync, recorded as the golden chain file ----

    /**
     * Answers like the real ingest service does for a fresh database: every uploaded record is
     * new (201, inserted = records), and each reconcile window is confirmed with nothing to delete.
     * tests/android-chain.test.ts checks these answers against the real server.
     */
    private fun freshServerAnswer(request: FakeIngestServer.Request): FakeIngestServer.Response {
        val body = json(request.body)
        val records = (body["records"] as List<*>).size
        val reconcile = body["reconcile"] as Map<*, *>?
        val reconciled = reconcile?.let {
            ""","reconciled":{"dataType":"${it["dataType"]}","start":"${it["start"]}","end":"${it["end"]}","checked":${(it["recordIds"] as List<*>).size},"deleted":0}"""
        } ?: ""
        return FakeIngestServer.Response(
            if (records > 0) 201 else 200,
            """{"ok":true,"inserted":$records,"updated":0,"deleted":0$reconciled}""",
        )
    }

    @Test
    fun aFirstSyncFromTheButtonUploadsEverythingAndCompletesSetup() {
        healthConnect(goldenRecords())
        server.responder = ::freshServerAnswer
        val activity = launch()
        val root = activity.root
        // Connection saved and Health Connect granted; only the first sync is left.
        assertTrue(hasVisibleText(root, "已完成 2 / 3 步"))
        val button = syncButton(activity)
        assertTrue(button.isEnabled)

        button.performClick()
        waitForSyncToFinish()

        val settings = Robo.settings()
        assertTrue(settings.lastStatus, settings.lastStatus.contains("同步完成，新增 9、更新 0、刪除 0"))
        assertFalse(settings.lastSyncFailed)
        assertTrue(settings.initialImportDone)
        assertEquals("every rescanned type was verified", emptyList<Any>(), ReconcileGaps.decode(settings.reconcileGapsText))
        // On screen: the sync result, the completed setup, and no error or reminder.
        assertTrue(hasVisibleText(root, "同步完成"))
        assertTrue(hasVisibleText(root, "設定完成"))
        assertTrue(hasVisibleText(root, "已完成首次匯入"))
        assertFalse(hasVisibleText(root, "歷史尚未完整核實"))
        assertFalse(hasVisibleText(root, activity.getString(R.string.action_retry)))

        // Every request is a Health Connect batch with the saved token.
        assertTrue(server.requests.all { it.method == "POST" && it.path == "/api/ingest/health-connect" })
        assertTrue(server.requests.all { it.authorization == "Bearer $TOKEN" && it.contentType == "application/json" })
        assertGolden(server.requests.map { request ->
            val answer = freshServerAnswer(request)
            val answered = json(answer.body)
            mapOf(
                "method" to request.method,
                "path" to request.path,
                "authorization" to request.authorization,
                "contentType" to request.contentType,
                "body" to json(request.body),
                "response" to mapOf(
                    "status" to answer.status,
                    "inserted" to answered["inserted"],
                    "updated" to answered["updated"],
                    "deleted" to answered["deleted"],
                    "reconciled" to (answered["reconciled"] != null),
                ),
            )
        })
    }

    private fun assertGolden(requests: List<Map<String, Any?>>) {
        val produced = CanonicalJson.write(
            mapOf(
                "description" to GOLDEN_DESCRIPTION,
                "phoneClock" to NOW.toString(),
                "requests" to requests,
            ),
        )
        val file = repoFile(GOLDEN)
        val update = System.getProperty("infovore.updateGolden") == "1" || System.getenv("INFOVORE_UPDATE_GOLDEN") == "1"
        if (update) {
            file.writeText(produced)
            println("Rewrote $GOLDEN (${requests.size} requests)")
            return
        }
        check(file.isFile) { "$GOLDEN is missing; create it with INFOVORE_UPDATE_GOLDEN=1 (see the class comment)" }
        assertEquals(
            "The recorded first sync differs from $GOLDEN. If the change is intended, regenerate it with " +
                "INFOVORE_UPDATE_GOLDEN=1 and make tests/android-chain.test.ts pass with it.",
            file.readText(),
            produced,
        )
    }

    // ---- A refused reconcile window, confirmed on screen ----

    @Test
    fun aRefusedDeletionIsShownWithItsSourcesAndDeletedOnlyAfterTwoConfirmations() {
        healthConnect((1..3).map { i -> steps("refusal-steps-$i", "2026-09-0${i + 5}T01:00:00Z", "2026-09-0${i + 5}T02:00:00Z", 1000L * i) })
        var confirmed = false
        server.responder = { request ->
            val body = json(request.body)
            @Suppress("UNCHECKED_CAST")
            val reconcile = body["reconcile"] as Map<String, Any?>?
            val confirm = reconcile?.get("confirmDelete") as Map<*, *>?
            when {
                reconcile?.get("dataType") != "steps" || confirmed -> freshServerAnswer(request)
                confirm == null -> FakeIngestServer.Response(
                    409,
                    """{"error":"Reconcile would delete 30 of 33 stored records","reconcile":{"status":"rejected","wouldDelete":30,"checked":33,""" +
                        """"byOrigin":[{"origin":"$ORIGIN","count":25},{"origin":"other","count":5}],"confirmToken":"$CONFIRM_TOKEN"}}""",
                )
                confirm["token"] == CONFIRM_TOKEN && intOf(confirm["expected"]) == 30 -> {
                    confirmed = true
                    FakeIngestServer.Response(
                        200,
                        """{"ok":true,"inserted":0,"updated":0,"deleted":30,"reconciled":{"dataType":"steps","start":"${reconcile["start"]}",""" +
                            """"end":"${reconcile["end"]}","checked":33,"deleted":30,"confirmed":true}}""",
                    )
                }
                else -> FakeIngestServer.Response(400, """{"error":"unexpected confirmation"}""")
            }
        }
        val activity = launch()
        val root = activity.root
        syncButton(activity).performClick()
        waitForSyncToFinish()

        // The sync itself succeeded; the refused window became a reminder with the server's counts and sources.
        assertTrue(Robo.settings().initialImportDone)
        assertTrue(hasVisibleText(root, "歷史尚未完整核實：步數"))
        assertTrue(hasVisibleText(root, "伺服器偵測到要刪除 30 筆（窗內共 33 筆）"))
        assertTrue(hasVisibleText(root, "來自：25 筆 $ORIGIN、5 筆其他 App"))
        val gap = ReconcileGaps.decode(Robo.settings().reconcileGapsText).single()
        assertEquals(CONFIRM_TOKEN, gap.refusal?.confirmToken)
        val sentBefore = server.requests.size

        // First dialog: what will be deleted, including the sources.
        Robo.button(root, "我確認來源端已刪除，刪除這 30 筆").performClick()
        Robo.idle()
        val first = ShadowDialog.getLatestDialog() as AlertDialog
        assertTrue(first.isShowing)
        val firstText = Robo.descendants(first.window!!.decorView).filterIsInstance<android.widget.TextView>().joinToString("\n") { it.text.toString() }
        assertTrue(firstText, firstText.contains("刪除伺服器上的 30 筆步數資料？"))
        assertTrue(firstText, firstText.contains("來自：25 筆 $ORIGIN、5 筆其他 App"))
        first.getButton(AlertDialog.BUTTON_POSITIVE).performClick()
        Robo.idle()
        // Second dialog: cannot be undone. Nothing has been sent yet.
        val second = ShadowDialog.getLatestDialog() as AlertDialog
        assertTrue(second !== first && second.isShowing)
        assertEquals("刪除 30 筆", second.getButton(AlertDialog.BUTTON_POSITIVE).text.toString())
        assertEquals(sentBefore, server.requests.size)
        second.getButton(AlertDialog.BUTTON_POSITIVE).performClick()
        waitForSyncToFinish()

        // Exactly one confirmation went out, with the server's token and the confirmed count,
        // listing the three records the phone still has; then the rest of the gap was re-verified.
        val confirmations = server.requests.drop(sentBefore).map { json(it.body) }
            .filter { (it["reconcile"] as Map<*, *>?)?.get("confirmDelete") != null }
        val confirmation = confirmations.single()["reconcile"] as Map<*, *>
        assertEquals(mapOf("expected" to 30.0, "token" to CONFIRM_TOKEN), confirmation["confirmDelete"])
        assertEquals(3, (confirmation["recordIds"] as List<*>).size)
        assertTrue(server.requests.size > sentBefore + 1)
        // The reminder is gone and the result is shown.
        assertEquals(emptyList<Any>(), ReconcileGaps.decode(Robo.settings().reconcileGapsText))
        assertFalse(hasVisibleText(root, "歷史尚未完整核實"))
        assertFalse(hasVisibleText(root, "我確認來源端已刪除"))
        assertTrue(hasVisibleText(root, "已刪除 30 筆已確認的步數資料，其餘範圍核實完成"))
        assertNull(SyncRunner.state.value.error)
    }

    // ---- Synthetic Health Connect records ----

    private fun at(text: String): Instant = Instant.parse(text)

    private fun meta(key: String) = Metadata.manualEntry(key, 1, null)

    private fun steps(key: String, start: String, end: String, count: Long) =
        StepsRecord(startTime = at(start), startZoneOffset = UTC, endTime = at(end), endZoneOffset = UTC, count = count, metadata = meta(key))

    /** One or two records of every synced type, inside the 7-day window before [NOW] (ascending per type). */
    private fun goldenRecords(): List<Record> = listOf(
        SleepSessionRecord(
            startTime = at("2026-09-08T15:30:00Z"), startZoneOffset = UTC, endTime = at("2026-09-08T22:30:00Z"), endZoneOffset = UTC,
            metadata = meta("golden-sleep-1"), title = null, notes = "golden private sleep note",
            stages = listOf(
                SleepSessionRecord.Stage(at("2026-09-08T15:30:00Z"), at("2026-09-08T18:00:00Z"), SleepSessionRecord.STAGE_TYPE_LIGHT),
                SleepSessionRecord.Stage(at("2026-09-08T18:00:00Z"), at("2026-09-08T20:00:00Z"), SleepSessionRecord.STAGE_TYPE_DEEP),
                SleepSessionRecord.Stage(at("2026-09-08T20:00:00Z"), at("2026-09-08T22:30:00Z"), SleepSessionRecord.STAGE_TYPE_REM),
            ),
        ),
        ExerciseSessionRecord(
            startTime = at("2026-09-09T00:10:00Z"), startZoneOffset = UTC, endTime = at("2026-09-09T00:40:00Z"), endZoneOffset = UTC,
            metadata = meta("golden-walk-1"), exerciseType = ExerciseSessionRecord.EXERCISE_TYPE_WALKING,
            title = null, notes = "golden private workout note",
        ),
        steps("golden-steps-1", "2026-09-09T00:00:00Z", "2026-09-09T01:00:00Z", 4000),
        steps("golden-steps-2", "2026-09-09T09:00:00Z", "2026-09-09T10:00:00Z", 2543),
        DistanceRecord(
            startTime = at("2026-09-09T00:00:00Z"), startZoneOffset = UTC, endTime = at("2026-09-09T01:00:00Z"), endZoneOffset = UTC,
            distance = Length.meters(3200.0), metadata = meta("golden-distance-1"),
        ),
        TotalCaloriesBurnedRecord(
            startTime = at("2026-09-09T00:00:00Z"), startZoneOffset = UTC, endTime = at("2026-09-09T01:00:00Z"), endZoneOffset = UTC,
            energy = Energy.kilocalories(250.0), metadata = meta("golden-calories-1"),
        ),
        HeartRateRecord(
            startTime = at("2026-09-09T00:15:00Z"), startZoneOffset = UTC, endTime = at("2026-09-09T00:20:00Z"), endZoneOffset = UTC,
            samples = listOf(
                HeartRateRecord.Sample(at("2026-09-09T00:16:00Z"), 64),
                HeartRateRecord.Sample(at("2026-09-09T00:18:00Z"), 80),
            ),
            metadata = meta("golden-heart-1"),
        ),
        WeightRecord(time = at("2026-09-09T23:00:00Z"), zoneOffset = UTC, weight = Mass.kilograms(68.4), metadata = meta("golden-weight-1")),
        BodyFatRecord(time = at("2026-09-09T23:00:00Z"), zoneOffset = UTC, percentage = Percentage(21.5), metadata = meta("golden-body-fat-1")),
    )

    private companion object {
        val UTC: ZoneOffset = ZoneOffset.UTC

        /** The phone's clock during the recorded sync (noon in Taipei). */
        val NOW: Instant = Instant.parse("2026-09-10T04:00:00Z")

        /** The server tests' INGEST_TOKEN (Health Connect falls back to it), so the golden replays as recorded. */
        const val TOKEN = "test-token-with-at-least-32-characters"
        const val DEVICE_ID = "android-golden-device-01"
        const val ORIGIN = "com.example.goldenwatch"
        val CONFIRM_TOKEN = "c0ffee".repeat(10) + "abcd"
        const val GOLDEN = "tests/fixtures/android-sync-golden.json"
        const val GOLDEN_DESCRIPTION =
            "Recorded by android/app/src/test/java/tw/skyhong/infovore/health/robo/SyncFlowUiTest.kt: every request the " +
                "Android app sends during one successful first sync (button press on MainActivity, real HealthSyncEngine and " +
                "InfovoreApi, synthetic Health Connect records, fixed clock and batch ids), with the answer the test's fake " +
                "server gave. tests/android-chain.test.ts replays the requests in order into the real ingest service, checks " +
                "that the real answers match, and checks the public pages. Regenerate with INFOVORE_UPDATE_GOLDEN=1 (see the " +
                "test); never edit by hand. Synthetic data only."
    }
}
