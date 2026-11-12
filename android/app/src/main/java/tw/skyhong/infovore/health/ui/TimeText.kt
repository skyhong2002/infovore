package tw.skyhong.infovore.health.ui

import java.time.Duration
import java.time.Instant
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import java.time.format.DateTimeParseException
import java.time.temporal.ChronoUnit
import java.util.Locale

/** Friendly zh-TW time text: a relative phrase plus the local date and time. Pure, so it is unit tested. */
object TimeText {
    private val locale: Locale = Locale.TAIWAN

    // Status strings saved by older and current builds start with Instant.toString() and a full-width colon.
    private val leadingInstant = Regex("^(\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}(?:\\.\\d{1,9})?Z)：")

    fun relative(then: Instant, now: Instant): String {
        val seconds = Duration.between(then, now).seconds
        if (seconds < 0) return future(-seconds)
        return when {
            seconds < 60 -> "剛剛"
            seconds < 3_600 -> "${seconds / 60} 分鐘前"
            seconds < 86_400 -> "${seconds / 3_600} 小時前"
            seconds < 30 * 86_400 -> "${seconds / 86_400} 天前"
            else -> "超過一個月前"
        }
    }

    private fun future(seconds: Long): String = when {
        seconds < 60 -> "不到 1 分鐘後"
        seconds < 3_600 -> "${(seconds + 59) / 60} 分鐘後"
        else -> "${seconds / 3_600} 小時後"
    }

    /** "今天 14:03", "昨天 23:10", "11月2日 09:15", or "2025年11月2日 09:15" for another year. */
    fun absolute(then: Instant, now: Instant, zone: ZoneId, use24Hour: Boolean = true): String {
        val time = then.atZone(zone)
        val today = now.atZone(zone).toLocalDate()
        val clock = DateTimeFormatter.ofPattern(if (use24Hour) "HH:mm" else "a h:mm", locale).format(time)
        val day = time.toLocalDate()
        val date = when {
            day == today -> "今天"
            day == today.minus(1, ChronoUnit.DAYS) -> "昨天"
            day == today.plus(1, ChronoUnit.DAYS) -> "明天"
            day.year == today.year -> DateTimeFormatter.ofPattern("M月d日", locale).format(time)
            else -> DateTimeFormatter.ofPattern("yyyy年M月d日", locale).format(time)
        }
        return "$date $clock"
    }

    /** "3 分鐘前（今天 14:03）". */
    fun friendly(then: Instant, now: Instant, zone: ZoneId, use24Hour: Boolean = true): String =
        "${relative(then, now)}（${absolute(then, now, zone, use24Hour)}）"

    fun clock(then: Instant, zone: ZoneId, use24Hour: Boolean = true): String =
        DateTimeFormatter.ofPattern(if (use24Hour) "HH:mm" else "a h:mm", locale).format(then.atZone(zone))

    /** Splits a saved "2026-11-12T06:03:00Z：message" status into its time and message. */
    fun splitStatus(status: String): Pair<Instant?, String> {
        val match = leadingInstant.find(status) ?: return null to status
        val instant = try {
            Instant.parse(match.groupValues[1])
        } catch (_: DateTimeParseException) {
            return null to status
        }
        return instant to status.substring(match.range.last + 1)
    }

    /** Rewrites a saved status so its leading ISO timestamp reads as friendly local time. */
    fun humanizeStatus(status: String, now: Instant, zone: ZoneId, use24Hour: Boolean = true): String {
        val (instant, message) = splitStatus(status)
        return if (instant == null) status else "${friendly(instant, now, zone, use24Hour)}：$message"
    }

    /** Parses a server timestamp (ISO-8601 with offset or Z); null when it is absent or unreadable. */
    fun parseServerTime(value: String?): Instant? {
        if (value.isNullOrBlank() || value == "null") return null
        return try {
            Instant.parse(value)
        } catch (_: DateTimeParseException) {
            try {
                java.time.OffsetDateTime.parse(value).toInstant()
            } catch (_: DateTimeParseException) {
                null
            }
        }
    }
}
