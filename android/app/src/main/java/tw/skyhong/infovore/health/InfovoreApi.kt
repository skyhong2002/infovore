package tw.skyhong.infovore.health

import androidx.health.connect.client.records.Record
import org.json.JSONArray
import org.json.JSONObject
import java.io.IOException
import java.net.HttpURLConnection
import java.net.URL
import java.nio.charset.StandardCharsets
import java.util.UUID

class InfovoreApi(private val settings: SecureSettings) {
    fun upload(
        records: List<Record>,
        deletedRecordIds: List<String>,
        onRetry: (attempt: Int, message: String) -> Unit = { _, _ -> },
    ): UploadResult {
        require(settings.token.length >= 32) { "請先輸入至少 32 字元的 HEALTH_CONNECT_TOKEN" }
        validateEndpoint()
        val body = JSONObject()
            .put("syncId", UUID.randomUUID().toString())
            .put("deviceId", settings.deviceId)
            .put("observedAt", java.time.Instant.now().toString())
            .put("records", JSONArray(records.map(HealthRecordJson::encode)))
            .put("deletedRecordIds", JSONArray(deletedRecordIds))
            .toString()
            .toByteArray(StandardCharsets.UTF_8)

        val response = postJson("/api/ingest/health-connect", settings.token, body, onRetry)
        return UploadResult(
            inserted = response.optInt("inserted"),
            updated = response.optInt("updated"),
            deleted = response.optInt("deleted"),
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
        require(settings.endpoint.startsWith("http://") || settings.endpoint.startsWith("https://")) {
            "Endpoint 必須以 http:// 或 https:// 開頭"
        }
        val endpointUrl = URL(settings.endpoint)
        require(endpointUrl.protocol == "https" || endpointUrl.host == "100.85.214.25") {
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
        val connection = URL("${settings.endpoint}$path").openConnection() as HttpURLConnection
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
            if (status !in 200..299) throw HttpStatusException(status, "Infovore HTTP $status: ${responseText.take(300)}")
            JSONObject(responseText)
        } finally {
            connection.disconnect()
        }
    }

    data class UploadResult(val inserted: Int, val updated: Int, val deleted: Int)

    /** A non-retryable HTTP failure (e.g. 400, 401, 413). */
    class HttpStatusException(val status: Int, message: String) : IllegalStateException(message)

    private companion object {
        const val MAX_ATTEMPTS = 4
        val RETRY_DELAYS_MS = longArrayOf(1_000L, 2_000L, 4_000L)
    }
}
