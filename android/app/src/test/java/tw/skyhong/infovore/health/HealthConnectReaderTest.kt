package tw.skyhong.infovore.health

import androidx.health.connect.client.HealthConnectClient
import androidx.health.connect.client.records.Record
import androidx.health.connect.client.records.SleepSessionRecord
import androidx.health.connect.client.records.StepsRecord
import androidx.health.connect.client.records.WeightRecord
import androidx.health.connect.client.records.metadata.Metadata
import androidx.health.connect.client.request.ChangesTokenRequest
import androidx.health.connect.client.request.ReadRecordsRequest
import androidx.health.connect.client.response.ChangesResponse
import androidx.health.connect.client.response.ReadRecordsResponse
import androidx.health.connect.client.testing.FakeHealthConnectClient
import androidx.health.connect.client.testing.FakePermissionController
import androidx.health.connect.client.time.TimeRangeFilter
import androidx.health.connect.client.units.Mass
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test
import tw.skyhong.infovore.health.Fixture.DAY
import tw.skyhong.infovore.health.Fixture.GARMIN
import tw.skyhong.infovore.health.Fixture.NOW
import tw.skyhong.infovore.health.Fixture.OWN
import java.time.Clock
import java.time.Instant
import java.time.ZoneId
import java.time.ZoneOffset

/**
 * The real [HealthConnectReader] over the official FakeHealthConnectClient, driving the real
 * [HealthSyncEngine]: what the reconcile path (which deletes server rows) actually receives.
 *
 * The fake (connect-testing 1.0.0-alpha03) differs from a device in ways these tests rely on:
 * it returns records in insertion order and ignores ascendingOrder, so records are inserted in
 * the order the engine asks for; page tokens are record offsets; an interval record matches a
 * time range only when it lies fully inside it (start >= range start, end < range end), an
 * instant record when start <= time < end. Synthetic records only.
 */
class HealthConnectReaderTest {
    /** Ticks a millisecond per read so the fake's change log stays ordered. */
    private class TickingClock(private var ms: Long) : Clock() {
        override fun instant(): Instant = Instant.ofEpochMilli(ms++)
        override fun getZone(): ZoneId = ZoneOffset.UTC
        override fun withZone(zone: ZoneId?): Clock = this
    }

    /** Delegates to the fake and keeps every read request the reader built. */
    private class Recording(val fake: FakeHealthConnectClient) : HealthConnectClient by fake {
        val reads = mutableListOf<ReadRecordsRequest<*>>()
        var changePages = 0

        override suspend fun <T : Record> readRecords(request: ReadRecordsRequest<T>): ReadRecordsResponse<T> {
            reads += request
            return fake.readRecords(request)
        }

        override suspend fun getChanges(changesToken: String): ChangesResponse =
            fake.getChanges(changesToken).also { changePages++ }
    }

    private class Fx(
        granted: Set<String> = Fixture.allPermissions + HealthCatalog.HISTORY_PERMISSION,
        reconcileTargetIds: Int = ReconcilePlanner.TARGET_IDS,
    ) {
        val permissions = FakePermissionController(grantAll = false).apply { grantPermissions(granted) }
        val fake = FakeHealthConnectClient(packageName = GARMIN, clock = TickingClock(NOW - 30 * DAY), permissionController = permissions)
        val client = Recording(fake)
        val events = mutableListOf<String>()
        val uploader = FakeUploader(events)
        val store = FakeStore()
        val engine = HealthSyncEngine(
            reader = HealthConnectReader(client),
            uploader = uploader,
            store = store,
            ownPackage = OWN,
            destination = Harness.DESTINATION,
            credentialsReady = true,
            clock = { NOW },
            reconcileTargetIds = reconcileTargetIds,
        )

        /** Inserts as [origin] and returns the ids Health Connect assigned. */
        fun insert(records: List<Record>, origin: String = GARMIN): List<String> = runBlocking {
            fake.setPackageName(origin)
            fake.insertRecords(records).recordIdsList.also { fake.setPackageName(GARMIN) }
        }

        fun readsOf(type: kotlin.reflect.KClass<out Record>) = client.reads.filter { it.recordType == type }

        fun idsIn(dataType: String) = uploader.windowsFor(dataType).flatMap { it.recordIds }
    }

    private val scanStart = NOW - 7 * DAY

    private fun at(ms: Long): Instant = Instant.ofEpochMilli(ms)

    private fun steps(key: String, startMs: Long, endMs: Long = startMs + 60_000) =
        StepsRecord(at(startMs), ZoneOffset.UTC, at(endMs), ZoneOffset.UTC, 10, Metadata.manualEntry(key, 1, null))

    private fun sleep(key: String, startMs: Long, endMs: Long) =
        SleepSessionRecord(at(startMs), ZoneOffset.UTC, at(endMs), ZoneOffset.UTC, Metadata.manualEntry(key, 1, null))

    private fun weight(key: String, timeMs: Long) =
        WeightRecord(at(timeMs), ZoneOffset.UTC, Mass.kilograms(70.0), Metadata.manualEntry(key, 1, null))

    @Test
    fun aMultiPageHistoryReadUploadsAndReconcilesEveryRecord() = runBlocking {
        val fx = Fx()
        val stepIds = fx.insert((0 until 1201).map { steps("steps-$it", scanStart + it * 60_000L) })
        // Sleep is read newest first.
        val sleepIds = fx.insert((0 until 3).reversed().map { sleep("sleep-$it", scanStart + it * DAY, scanStart + it * DAY + 3_600_000) })

        fx.engine.run()

        val stepReads = fx.readsOf(StepsRecord::class)
        assertEquals(listOf(null, "500", "1000"), stepReads.map { it.pageToken })
        for (request in stepReads + fx.readsOf(SleepSessionRecord::class)) {
            assertEquals(HealthConnectReader.PAGE_SIZE, request.pageSize)
            assertEquals(TimeRangeFilter.between(at(scanStart), at(NOW)), request.timeRangeFilter)
        }
        assertTrue(stepReads.all { it.ascendingOrder })
        assertTrue(fx.readsOf(SleepSessionRecord::class).none { it.ascendingOrder })
        assertEquals((stepIds + sleepIds).toSet(), fx.uploader.uploadedIds.toSet())
        assertEquals(stepIds.size + sleepIds.size, fx.uploader.uploadedIds.size)
        // Every id of the complete read is listed, so the server deletes nothing it still has.
        assertEquals(stepIds.toSet(), fx.idsIn("steps").toSet())
        assertEquals(sleepIds.toSet(), fx.idsIn("sleep_session").toSet())
        assertEquals("", fx.store.reconcileGapsText)
        assertTrue(fx.store.changesToken != null)
    }

    @Test
    fun recordsCrossingTheWindowStartAreNeitherUploadedNorListed() = runBlocking {
        val fx = Fx()
        val inside = fx.insert(listOf(steps("at-start", scanStart), steps("inside", scanStart + DAY)))
        fx.insert(listOf(steps("crosses-start", scanStart - 1_800_000, scanStart + 1_800_000)))
        val weightInside = fx.insert(listOf(weight("weight-last", NOW - 1)))
        fx.insert(listOf(weight("weight-at-end", NOW), weight("weight-before", scanStart - 1)))

        fx.engine.run()

        assertEquals((inside + weightInside).toSet(), fx.uploader.uploadedIds.toSet())
        assertEquals(inside.toSet(), fx.idsIn("steps").toSet())
        assertEquals(weightInside, fx.idsIn("weight"))
        assertTrue(fx.uploader.windows.all { it.startMs >= scanStart && it.endMs <= NOW })
    }

    /**
     * Pinned so a change is deliberate: under the fake's containment rule a record that starts
     * inside the window but ends at or after its end is not read, so the reconcile window omits
     * its id although the server stores it inside the window (by start_at). That does not delete
     * it: the server's reconcileHealthWindow only deletes rows that also end before the window end
     * (tests/health-reconcile.test.ts, "A reader that misses a record crossing or reaching the
     * window end never gets it deleted"). The cost runs the other way: such a record deleted at
     * the source stays on the server until a later reconcile window contains it entirely, e.g.
     * the next history scan (which ends at that scan's "now"). Whether a device returns these
     * records the way the fake does is not known.
     */
    @Test
    fun aRecordEndingAtOrAfterTheWindowEndIsNotListedInItsReconcileWindow() = runBlocking {
        val fx = Fx()
        val listed = fx.insert(listOf(steps("inside", NOW - 2 * 3_600_000)))
        val crossing = fx.insert(listOf(steps("crosses-end", NOW - 1_800_000, NOW + 1_800_000)))
        val atEnd = fx.insert(listOf(steps("ends-at-end", NOW - 600_000, NOW)))

        fx.engine.run()

        assertEquals(listed, fx.idsIn("steps"))
        assertFalse(crossing.single() in fx.idsIn("steps"))
        assertFalse(atEnd.single() in fx.idsIn("steps"))
        assertTrue(fx.uploader.windowsFor("steps").all { it.endMs == NOW })
        assertEquals("", fx.store.reconcileGapsText)
    }

    @Test
    fun recordsSharingOneStartTimeAcrossAPageBoundaryAreListedOnceEach() = runBlocking {
        // 497 earlier records, then six sharing one start time at offsets 497..502 (pages hold
        // 500, so the tie spans pages one and two), then more after it. Small reconcile windows
        // make the planner want to close a window right inside the tie.
        val fx = Fx(reconcileTargetIds = 499)
        val tie = scanStart + DAY
        val before = fx.insert((0 until 497).map { steps("before-$it", scanStart + 60_000L + it * 60_000L) })
        val tied = fx.insert((0 until 6).map { steps("tied-$it", tie, tie + 60_000L + it) })
        val after = fx.insert((0 until 300).map { steps("after-$it", tie + 120_000L + it * 60_000L) })
        val all = before + tied + after

        fx.engine.run()

        assertEquals(listOf(null, "500"), fx.readsOf(StepsRecord::class).map { it.pageToken })
        assertEquals(all.size, fx.uploader.uploadedIds.size)
        assertEquals(all.toSet(), fx.uploader.uploadedIds.toSet())
        val listedIds = fx.idsIn("steps")
        assertEquals(all.size, listedIds.size) // no id twice
        assertEquals(all.toSet(), listedIds.toSet()) // none missing
        val windows = fx.uploader.windowsFor("steps")
        assertTrue(windows.size > 1)
        // Every tied record is in the one window that contains the tie.
        val holding = windows.filter { it.startMs <= tie && tie < it.endMs }
        assertEquals(1, holding.size)
        assertTrue(holding.single().recordIds.containsAll(tied))
        // Windows are contiguous and cover the scan exactly.
        assertEquals(scanStart, windows.first().startMs)
        assertEquals(NOW, windows.last().endMs)
        windows.zipWithNext().forEach { (a, b) -> assertEquals(a.endMs, b.startMs) }
        assertEquals("", fx.store.reconcileGapsText)
    }

    @Test
    fun anUnsortedReadIsUploadedButNeverReconciled() = runBlocking {
        val fx = Fx()
        val ids = fx.insert(listOf(steps("later", scanStart + 2 * DAY), steps("earlier", scanStart + DAY)))

        val summary = fx.engine.run()

        assertEquals(ids.toSet(), fx.uploader.uploadedIds.toSet())
        assertTrue(fx.uploader.windowsFor("steps").isEmpty())
        assertTrue(summary.unverified.any { it.startsWith(HealthCatalog.label("steps")) })
        assertEquals(listOf("steps"), ReconcileGaps.decode(fx.store.reconcileGapsText).map { it.dataType })
    }

    @Test
    fun aMissingPermissionReadsAndSendsNothing() = runBlocking<Unit> {
        val fx = Fx(granted = Fixture.allPermissions - HealthCatalog.type("steps")!!.readPermission)
        fx.insert(listOf(steps("one", scanStart + DAY)))

        assertThrows(IllegalArgumentException::class.java) { runBlocking { fx.engine.run() } }
        assertTrue(fx.client.reads.isEmpty())
        assertTrue(fx.events.isEmpty())
        assertEquals(null, fx.store.changesToken)

        fx.permissions.revokePermission(HealthCatalog.SLEEP.readPermission)
        assertThrows(IllegalArgumentException::class.java) { runBlocking { fx.engine.runSleep() } }
        assertTrue(fx.client.reads.isEmpty())
    }

    @Test
    fun changesArrivePageByPageWithoutOwnRecords() = runBlocking {
        val fx = Fx()
        val first = fx.insert(listOf(steps("old", scanStart + DAY)))
        fx.engine.run()
        // The fake's nextChangesToken never sees later changes (a fake limitation, not the
        // platform's); continue from a token it issued directly, as after a fresh history scan.
        val token = fx.fake.getChangesToken(ChangesTokenRequest(HealthConnectSync.recordTypes))
        fx.store.changesToken = token
        fx.fake.pageSizeGetChanges = 2
        val added = fx.insert((0 until 5).map { steps("new-$it", NOW - DAY + it * 60_000L) })
        fx.insert(listOf(steps("own", NOW - DAY / 2)), origin = OWN)
        fx.fake.deleteRecords(StepsRecord::class, recordIdsList = first, clientRecordIdsList = emptyList())
        fx.uploader.uploadedIds.clear()
        val reads = fx.client.reads.size
        val pages = fx.client.changePages

        val summary = fx.engine.run()

        assertEquals(reads + 1, fx.client.reads.size) // only the per-run sleep read; no history rescan
        assertEquals(added.toSet(), fx.uploader.uploadedIds.toSet())
        assertEquals(first, fx.uploader.deletedIds)
        assertEquals(1, summary.deleted)
        assertTrue(fx.client.changePages - pages >= 4) // 7 changes, 2 per page, followed while hasMore
        assertNotEquals(token, fx.store.changesToken)
    }

    @Test
    fun anExpiredChangesTokenRestartsTheHistoryScan() = runBlocking {
        val fx = Fx()
        fx.insert(listOf(steps("old", scanStart + DAY)))
        fx.engine.run()
        val expired = requireNotNull(fx.store.changesToken)
        val added = fx.insert(listOf(steps("new", NOW - DAY)))
        fx.fake.expireToken(expired)
        fx.uploader.uploadedIds.clear()
        fx.uploader.windows.clear()

        fx.engine.run()

        assertTrue(added.single() in fx.uploader.uploadedIds)
        assertEquals(2, fx.idsIn("steps").size) // a full rescan reconciled the type again
        assertNotEquals(expired, fx.store.changesToken)
        assertEquals("", fx.store.reconcileGapsText)
    }
}
