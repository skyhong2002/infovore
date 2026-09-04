package tw.skyhong.infovore.health

import androidx.health.connect.client.records.Record
import org.json.JSONArray
import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URL
import java.nio.charset.StandardCharsets
import java.util.UUID

class InfovoreApi(private val settings: SecureSettings) {
    fun upload(records: List<Record>, deletedRecordIds: List<String>): UploadResult {
        require(settings.token.length >= 32) { "請先輸入至少 32 字元的 HEALTH_CONNECT_TOKEN" }
        require(settings.endpoint.startsWith("http://") || settings.endpoint.startsWith("https://")) {
            "Endpoint 必須以 http:// 或 https:// 開頭"
        }
        val endpointUrl = URL(settings.endpoint)
        require(endpointUrl.protocol == "https" || endpointUrl.host == "100.85.214.25") {
            "自訂 endpoint 必須使用 HTTPS；HTTP 僅允許預設 Tailscale IP"
        }
        val body = JSONObject()
            .put("syncId", UUID.randomUUID().toString())
            .put("deviceId", settings.deviceId)
            .put("observedAt", java.time.Instant.now().toString())
            .put("records", JSONArray(records.map(HealthRecordJson::encode)))
            .put("deletedRecordIds", JSONArray(deletedRecordIds))
            .toString()
            .toByteArray(StandardCharsets.UTF_8)

        val connection = URL("${settings.endpoint}/api/ingest/health-connect")
            .openConnection() as HttpURLConnection
        return try {
            connection.requestMethod = "POST"
            connection.connectTimeout = 15_000
            connection.readTimeout = 30_000
            connection.doOutput = true
            connection.setRequestProperty("Authorization", "Bearer ${settings.token}")
            connection.setRequestProperty("Content-Type", "application/json")
            connection.setFixedLengthStreamingMode(body.size)
            connection.outputStream.use { it.write(body) }
            val status = connection.responseCode
            val stream = if (status in 200..299) connection.inputStream else connection.errorStream
            val responseText = stream?.bufferedReader()?.use { it.readText() }.orEmpty()
            if (status !in 200..299) error("Infovore HTTP $status: ${responseText.take(300)}")
            val response = JSONObject(responseText)
            UploadResult(
                inserted = response.optInt("inserted"),
                updated = response.optInt("updated"),
                deleted = response.optInt("deleted"),
            )
        } finally {
            connection.disconnect()
        }
    }

    data class UploadResult(val inserted: Int, val updated: Int, val deleted: Int)
}
