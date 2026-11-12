package tw.skyhong.infovore.health.ui

import tw.skyhong.infovore.health.EndpointPolicy
import tw.skyhong.infovore.health.SecureSettings
import tw.skyhong.infovore.health.screen.Exclusions
import java.net.URI
import java.net.URISyntaxException

/** Outcome of validating one form field. [Valid.note] is a non-blocking hint shown under the field. */
sealed interface FieldResult<out T> {
    data class Valid<T>(val value: T, val note: String? = null) : FieldResult<T>
    data class Invalid(val message: String) : FieldResult<Nothing>
}

val FieldResult<*>.isValid: Boolean get() = this is FieldResult.Valid<*>
val FieldResult<*>.errorOrNull: String? get() = (this as? FieldResult.Invalid)?.message
fun <T> FieldResult<T>.valueOrNull(): T? = (this as? FieldResult.Valid<T>)?.value

/**
 * Pure (Android-free) validation for the settings form. The accepted endpoint range matches
 * [EndpointPolicy] exactly, so anything saved here is also accepted by the network layer; the
 * UI simply reports problems earlier and in plainer language.
 */
object InputValidation {
    const val MIN_TOKEN_LENGTH = 32

    fun endpoint(raw: String): FieldResult<String> {
        val text = raw.trim().trimEnd('/')
        if (text.isEmpty()) return FieldResult.Invalid("請輸入 Infovore 的網址，例如 ${SecureSettings.DEFAULT_ENDPOINT}")
        if (text.any(Char::isWhitespace)) return FieldResult.Invalid("網址不可包含空白")
        val schemeEnd = text.indexOf("://")
        if (schemeEnd <= 0) return FieldResult.Invalid("網址需以 https:// 開頭")
        val scheme = text.substring(0, schemeEnd).lowercase()
        if (scheme != "https" && scheme != "http") return FieldResult.Invalid("網址需以 https:// 開頭")
        val normalized = scheme + text.substring(schemeEnd)
        val uri = try {
            URI(normalized)
        } catch (_: URISyntaxException) {
            return FieldResult.Invalid("網址格式不正確")
        }
        val host = uri.host
        if (host.isNullOrEmpty()) return FieldResult.Invalid("網址缺少主機名稱")
        if (uri.rawUserInfo != null) return FieldResult.Invalid("網址不可包含帳號或密碼")
        if (uri.rawQuery != null || uri.rawFragment != null) {
            return FieldResult.Invalid("請只填伺服器網址，不要包含 ? 或 # 之後的部分")
        }
        if (uri.port != -1 && uri.port !in 1..65535) return FieldResult.Invalid("連接埠號碼不正確")
        if (!EndpointPolicy.isAllowed(scheme, host)) {
            return FieldResult.Invalid("自訂網址必須使用 HTTPS（HTTP 只允許預設的 Tailscale 私網位址）")
        }
        return FieldResult.Valid(normalized)
    }

    /**
     * Ingest tokens are random strings of at least [MIN_TOKEN_LENGTH] characters. A blank value
     * is only acceptable when the field is optional (the feature then stays unconfigured).
     */
    fun token(raw: String, name: String, required: Boolean): FieldResult<String> {
        val text = raw.trim()
        if (text.isEmpty()) {
            return if (required) FieldResult.Invalid("請輸入 $name") else FieldResult.Valid("", "尚未設定；此功能需要 $name 才能上傳")
        }
        if (text.any(Char::isWhitespace)) return FieldResult.Invalid("Token 中間不可有空白或換行，請重新貼上")
        if (text.length < MIN_TOKEN_LENGTH) {
            return FieldResult.Invalid("目前 ${text.length} 字元，至少需要 $MIN_TOKEN_LENGTH 字元")
        }
        return FieldResult.Valid(text)
    }

    fun historyDays(raw: String): FieldResult<Int> {
        val text = raw.trim()
        val max = SecureSettings.MAX_HISTORY_DAYS
        if (text.isEmpty()) return FieldResult.Invalid("請輸入 1–$max 之間的天數")
        val days = text.toIntOrNull()
            ?: return FieldResult.Invalid(if (text.all(Char::isDigit)) "天數最多 $max" else "請只輸入數字")
        if (days < 1) return FieldResult.Invalid("天數至少為 1")
        if (days > max) return FieldResult.Invalid("天數最多 $max（約十年）")
        val note = if (days > HISTORY_WITHOUT_PERMISSION_DAYS) {
            "未授權「讀取完整歷史」時實際最多讀取 $HISTORY_WITHOUT_PERMISSION_DAYS 天；天數越大，第一次同步越久"
        } else {
            null
        }
        return FieldResult.Valid(days, note)
    }

    /** Valid package names are kept; any other entry is reported instead of being dropped silently. */
    fun exclusions(raw: String): FieldResult<String> {
        val entries = raw.split(',', ';', '\n', '\r', '\t', ' ').map(String::trim).filter(String::isNotEmpty)
        val invalid = entries.filter { Exclusions.parse(it).isEmpty() }.distinct()
        if (invalid.isNotEmpty()) {
            val shown = invalid.take(3).joinToString("、") + if (invalid.size > 3) " 等 ${invalid.size} 項" else ""
            return FieldResult.Invalid("不是有效的 App 套件名稱：$shown（格式如 com.example.bank）")
        }
        val count = entries.distinct().size
        return FieldResult.Valid(raw.trim(), if (count > 0) "將排除 $count 個自訂套件" else null)
    }

    const val HISTORY_WITHOUT_PERMISSION_DAYS = 30
}
