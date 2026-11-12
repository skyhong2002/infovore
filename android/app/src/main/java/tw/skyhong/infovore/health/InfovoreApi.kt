package tw.skyhong.infovore.health

import org.json.JSONObject
import java.io.IOException
import java.net.HttpURLConnection
import java.net.URL
import java.nio.charset.StandardCharsets
import java.util.UUID

/**
 * HTTP client for one fixed destination. [endpoint] is captured when the instance is created and
 * never re-read from settings, so every request of one sync or upload run goes to the same
 * server even if the saved endpoint changes meanwhile.
 */
class InfovoreApi(endpoint: String) {
    val endpoint: String = endpoint.trim().trimEnd('/')

    /** [records] are encoded records ([HealthRecordJson.encode]); the body is built by [HealthBatchJson]. */
    fun upload(
        token: String,
        deviceId: String,
        records: List<String>,
        deletedRecordIds: List<String>,
        reconcile: ReconcileWindow? = null,
        onRetry: (attempt: Int, message: String) -> Unit = { _, _ -> },
    ): UploadResult {
        require(token.length >= 32) { "請先輸入至少 32 字元的 HEALTH_CONNECT_TOKEN" }
        validateEndpoint()
        val body = HealthBatchJson.body(
            syncId = UUID.randomUUID().toString(),
            deviceId = deviceId,
            observedAt = java.time.Instant.now(),
            recordJson = records,
            deletedRecordIds = deletedRecordIds,
            reconcile = reconcile,
        ).toByteArray(StandardCharsets.UTF_8)

        val response = postJson("/api/ingest/health-connect", token, body, onRetry)
        return UploadResult(
            inserted = response.optInt("inserted"),
            updated = response.optInt("updated"),
            deleted = response.optInt("deleted"),
            reconciled = response.optJSONObject("reconciled") != null,
        )
    }

    /**
     * POSTs [body] to [path] on the configured endpoint. Transient failures (IOException,
     * HTTP 408/429/5xx) are retried with backoff; other non-2xx responses throw [HttpStatusException].
     */
    fun postJson(
        path: String,
        token: String,
        body: ByteArray,
        onRetry: (attempt: Int, message: String) -> Unit = { _, _ -> },
    ): JSONObject {
        validateEndpoint()
        return withRetry(onRetry) { requestOnce("POST", path, token, body) }
    }

    fun getJson(
        path: String,
        token: String,
        onRetry: (attempt: Int, message: String) -> Unit = { _, _ -> },
    ): JSONObject {
        validateEndpoint()
        return withRetry(onRetry) { requestOnce("GET", path, token, null) }
    }

    private fun validateEndpoint() {
        require(endpoint.startsWith("http://") || endpoint.startsWith("https://")) {
            "Endpoint 必須以 http:// 或 https:// 開頭"
        }
        val endpointUrl = URL(endpoint)
        require(endpointUrl.protocol == "https" || endpointUrl.host == EndpointPolicy.TAILSCALE_HTTP_HOST) {
            "自訂 endpoint 必須使用 HTTPS；HTTP 僅允許預設 Tailscale IP"
        }
    }

    private fun withRetry(
        onRetry: (attempt: Int, message: String) -> Unit,
        block: () -> JSONObject,
    ): JSONObject {
        var lastError: IOException? = null
        for (attempt in 1..MAX_ATTEMPTS) {
            try {
                return block()
            } catch (error: IOException) {
                lastError = error
                if (attempt == MAX_ATTEMPTS) throw error
                val nextAttempt = attempt + 1
                onRetry(nextAttempt, error.message ?: error.javaClass.simpleName)
                Thread.sleep(RETRY_DELAYS_MS[attempt - 1])
            }
        }
        throw checkNotNull(lastError)
    }

    private fun requestOnce(method: String, path: String, token: String, body: ByteArray?): JSONObject {
        val connection = URL("$endpoint$path").openConnection() as HttpURLConnection
        return try {
            connection.requestMethod = method
            connection.connectTimeout = 15_000
            connection.readTimeout = 30_000
            connection.setRequestProperty("Authorization", "Bearer $token")
            if (body != null) {
                connection.doOutput = true
                connection.setRequestProperty("Content-Type", "application/json")
                connection.setFixedLengthStreamingMode(body.size)
                connection.outputStream.use { it.write(body) }
            }
            val status = connection.responseCode
            val stream = if (status in 200..299) connection.inputStream else connection.errorStream
            val responseText = stream?.bufferedReader()?.use { it.readText() }.orEmpty()
            if (status == 408 || status == 429 || status >= 500) {
                throw IOException("Infovore HTTP $status: ${responseText.take(300)}")
            }
            if (status !in 200..299) {
                throw HttpStatusException(status, "Infovore HTTP $status: ${responseText.take(300)}", refusalOf(status, responseText))
            }
            JSONObject(responseText)
        } finally {
            connection.disconnect()
        }
    }

    /** [reconciled]: the server confirmed the batch's reconcile window (false when none was sent). */
    data class UploadResult(val inserted: Int, val updated: Int, val deleted: Int, val reconciled: Boolean = false)

    /**
     * A non-retryable HTTP failure (e.g. 400, 401, 409, 413). [refusal] holds the counts of a
     * reconcile window the server refused (HTTP 409 with `reconcile.status == "rejected"`).
     */
    class HttpStatusException(
        val status: Int,
        message: String,
        val refusal: ReconcileRefusal? = null,
    ) : IllegalStateException(message)

    private companion object {
        fun refusalOf(status: Int, responseText: String): ReconcileRefusal? {
            if (status != 409) return null
            val reconcile = runCatching { JSONObject(responseText).optJSONObject("reconcile") }.getOrNull() ?: return null
            if (reconcile.optString("status") != "rejected") return null
            val wouldDelete = reconcile.optInt("wouldDelete", -1)
            val checked = reconcile.optInt("checked", -1)
            return if (wouldDelete >= 0 && checked >= 0) ReconcileRefusal(wouldDelete, checked) else null
        }

        const val MAX_ATTEMPTS = 4
        val RETRY_DELAYS_MS = longArrayOf(1_000L, 2_000L, 4_000L)
    }
}
