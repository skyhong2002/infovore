package tw.skyhong.infovore.health

import java.time.Instant

/**
 * The body of `POST /api/ingest/health-connect` (the server's healthConnectBatchSchema), built
 * without org.json so the exact wire format is unit tested against the shared contract fixture
 * `tests/fixtures/health-reconcile-contract.json`. [recordJson] are already encoded records
 * ([HealthRecordJson.encode]) and are embedded as they are.
 */
object HealthBatchJson {
    fun body(
        syncId: String,
        deviceId: String,
        observedAt: Instant,
        recordJson: List<String>,
        deletedRecordIds: List<String>,
        reconcile: ReconcileWindow?,
    ): String = buildString {
        append("{\"syncId\":").append(JsonText.quote(syncId))
        append(",\"deviceId\":").append(JsonText.quote(deviceId))
        append(",\"observedAt\":").append(JsonText.quote(observedAt.toString()))
        append(",\"records\":[")
        recordJson.forEachIndexed { index, json ->
            if (index > 0) append(',')
            append(json)
        }
        append("],\"deletedRecordIds\":[")
        deletedRecordIds.forEachIndexed { index, id ->
            if (index > 0) append(',')
            append(JsonText.quote(id))
        }
        append(']')
        if (reconcile != null) append(",\"reconcile\":").append(reconcile.toJson())
        append('}')
    }
}
