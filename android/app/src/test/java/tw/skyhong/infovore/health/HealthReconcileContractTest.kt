package tw.skyhong.infovore.health

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File
import java.time.Instant

/**
 * The reconcile wire contract shared with the server: the app's own planner and batch serializer
 * must produce `request` of `tests/fixtures/health-reconcile-contract.json` field by field, and the
 * server's tests/health-reconcile-contract.test.ts parses and ingests the same file.
 */
class HealthReconcileContractTest {
    private val fixture: Map<String, Any?> by lazy {
        @Suppress("UNCHECKED_CAST")
        MiniJson.parse(fixtureFile().readText()) as Map<String, Any?>
    }

    /** Walks up from the module directory (Gradle's working directory) to the repo root. */
    private fun fixtureFile(): File {
        var dir: File? = File("").absoluteFile
        while (dir != null) {
            val candidate = File(dir, "tests/fixtures/health-reconcile-contract.json")
            if (candidate.isFile) return candidate
            dir = dir.parentFile
        }
        error("tests/fixtures/health-reconcile-contract.json not found above ${File("").absolutePath}")
    }

    @Suppress("UNCHECKED_CAST")
    private fun Any?.obj() = this as Map<String, Any?>

    @Test
    fun theAppSerializesTheSharedReconcileBatchExactly() {
        val planner = fixture["planner"].obj()
        val request = fixture["request"].obj()
        val reconcilePlanner = ReconcilePlanner(
            dataType = planner["dataType"] as String,
            startMs = Instant.parse(planner["start"] as String).toEpochMilli(),
            endMs = Instant.parse(planner["end"] as String).toEpochMilli(),
            ascending = true,
        )
        @Suppress("UNCHECKED_CAST")
        val items = (planner["items"] as List<Map<String, Any?>>).map {
            ReconcilePlanner.Item(it["id"] as String, Instant.parse(it["start"] as String).toEpochMilli())
        }
        assertTrue(reconcilePlanner.add(items).isEmpty())
        val window = requireNotNull(reconcilePlanner.finish())

        val body = HealthBatchJson.body(
            syncId = request["syncId"] as String,
            deviceId = request["deviceId"] as String,
            observedAt = Instant.parse(request["observedAt"] as String),
            recordJson = emptyList(),
            deletedRecordIds = emptyList(),
            reconcile = window,
        )
        val produced = MiniJson.parse(body).obj()

        // Same keys at every level, same values: any rename, addition or format change fails here.
        assertEquals(request.keys, produced.keys)
        for (key in request.keys) assertEquals("field $key", request[key], produced[key])
        val expectedWindow = request["reconcile"].obj()
        val producedWindow = produced["reconcile"].obj()
        assertEquals(expectedWindow.keys.toList(), producedWindow.keys.toList())
        for (key in expectedWindow.keys) assertEquals("reconcile.$key", expectedWindow[key], producedWindow[key])
    }

    @Test
    fun theAppSerializesTheSharedConfirmedDeletionExactly() {
        val case = fixture["confirmedDeleteCase"].obj()
        val planner = case["planner"].obj()
        val request = case["request"].obj()
        val reconcilePlanner = ReconcilePlanner(
            dataType = planner["dataType"] as String,
            startMs = Instant.parse(planner["start"] as String).toEpochMilli(),
            endMs = Instant.parse(planner["end"] as String).toEpochMilli(),
            ascending = true,
        )
        @Suppress("UNCHECKED_CAST")
        val items = (planner["items"] as List<Map<String, Any?>>).map {
            ReconcilePlanner.Item(it["id"] as String, Instant.parse(it["start"] as String).toEpochMilli())
        }
        assertTrue(reconcilePlanner.add(items).isEmpty())
        val window = requireNotNull(reconcilePlanner.finish())
            .copy(confirmDeleteExpected = (planner["confirmDeleteExpected"] as Double).toInt())

        val produced = MiniJson.parse(
            HealthBatchJson.body(
                syncId = request["syncId"] as String,
                deviceId = request["deviceId"] as String,
                observedAt = Instant.parse(request["observedAt"] as String),
                recordJson = emptyList(),
                deletedRecordIds = emptyList(),
                reconcile = window,
            ),
        ).obj()
        assertEquals(request.keys, produced.keys)
        for (key in request.keys) assertEquals("field $key", request[key], produced[key])
        val expectedWindow = request["reconcile"].obj()
        val producedWindow = produced["reconcile"].obj()
        assertEquals(expectedWindow.keys.toList(), producedWindow.keys.toList())
        assertEquals(expectedWindow["confirmDelete"], producedWindow["confirmDelete"])
        // The confirmed number is also what the server's expected response reports as deleted.
        val expectedResponse = case["expectedResponse"].obj()
        assertEquals(expectedResponse["deleted"], (producedWindow["confirmDelete"].obj())["expected"])
    }

    @Test
    fun recordsAndDeletionsAreEmbeddedAsGiven() {
        val body = HealthBatchJson.body(
            "fixture-sync-0001", "fixture-device-01", Instant.parse("2026-09-10T00:00:00.123Z"),
            listOf("{\"id\":\"a\"}", "{\"id\":\"b\\\"q\"}"), listOf("gone-1", "gone\"2"), null,
        )
        val parsed = MiniJson.parse(body).obj()
        assertEquals(listOf(mapOf("id" to "a"), mapOf("id" to "b\"q")), parsed["records"])
        assertEquals(listOf("gone-1", "gone\"2"), parsed["deletedRecordIds"])
        assertEquals("2026-09-10T00:00:00.123Z", parsed["observedAt"])
        assertTrue("reconcile" !in parsed)
    }
}
