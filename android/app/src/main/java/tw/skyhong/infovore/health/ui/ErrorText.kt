package tw.skyhong.infovore.health.ui

import tw.skyhong.infovore.health.InfovoreApi
import tw.skyhong.infovore.health.RetryAfter
import java.io.IOException
import java.net.ConnectException
import java.net.NoRouteToHostException
import java.net.SocketTimeoutException
import java.net.UnknownHostException
import javax.net.ssl.SSLException

/** Turns sync and upload failures into a short explanation with a next step. */
object ErrorText {
    fun describe(error: Throwable): String {
        val raw = error.message?.takeIf(String::isNotBlank)
        return when (error) {
            is InfovoreApi.HttpStatusException -> http(error.status, raw)
            is UnknownHostException -> "找不到伺服器，請確認網址與網路（使用私網位址時需連上 Tailscale）。"
            is SocketTimeoutException -> "連線逾時，伺服器沒有回應；請確認網路後重試。"
            is ConnectException, is NoRouteToHostException -> "無法連線到伺服器，請確認網址、網路與 Tailscale 連線。"
            is SSLException -> "安全連線（HTTPS）失敗，請確認網址與憑證。"
            is InfovoreApi.RetryableHttpException -> transient(raw, error.retryAfterMs)
            is IOException -> transient(raw, null)
            is SecurityException -> "Health Connect 拒絕讀取，請重新授權後再試。"
            // require() failures in the sync code already carry a user-facing message.
            is IllegalArgumentException, is IllegalStateException -> raw ?: "設定不完整，請檢查後重試。"
            else -> raw ?: error.javaClass.simpleName
        }
    }

    private fun transient(raw: String?, retryAfterMs: Long?): String {
        val status = raw?.let { Regex("HTTP (\\d{3})").find(it)?.groupValues?.get(1)?.toIntOrNull() }
        val wait = retryAfterMs?.let { RetryAfter.describe(it) }
        return when {
            status == 429 && wait != null -> "伺服器暫時忙碌（HTTP 429），要求約 ${wait}後再試。"
            status != null && status >= 500 && wait != null -> "伺服器暫時無法處理（HTTP $status），要求約 ${wait}後再試。"
            status == 429 -> "伺服器暫時忙碌（HTTP 429），已自動重試數次；請稍後再試。"
            status != null && status >= 500 -> "伺服器暫時無法處理（HTTP $status），已自動重試數次；請稍後再試。"
            raw != null -> "網路連線中斷：$raw"
            else -> "網路連線中斷，請稍後重試。"
        }
    }

    private fun http(status: Int, raw: String?): String = when (status) {
        401, 403 -> "伺服器拒絕了 token（HTTP $status），請確認填入的 token 與伺服器設定相同。"
        404 -> "伺服器上找不到同步服務（HTTP 404），請確認網址是否正確。"
        413 -> "單次上傳資料過大（HTTP 413），請縮小初始同步天數後重試。"
        503 -> "伺服器尚未啟用此功能（HTTP 503），請確認伺服器已設定對應的 token。"
        else -> "伺服器回應錯誤（HTTP $status）" + (raw?.let { "：${it.removePrefix("Infovore HTTP $status: ").take(160)}" } ?: "")
    }
}
