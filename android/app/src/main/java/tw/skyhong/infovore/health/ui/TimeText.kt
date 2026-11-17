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

    /** [text] with no-break spaces, so "下午 8:56" or "新增 128" never wraps at its space. */
    fun keepTogether(text: String): String = text.replace(' ', '\u00A0')

    /** "a · b · c" that wraps only between items; the "·" stays at the end of the line it follows. */
    fun phrases(text: String): String = text.split(" · ").joinToString("\u00A0· ") {
        if (it.length <= SHORT_PHRASE) unbreakable(it) else keepTogether(it)
    }

    /**
     * A saved result as shown: "背景同步完成：新增 128 · 更新 6". When it does not fit one line it
     * breaks after the "：", never inside the counts or with a dangling "·".
     */
    fun result(text: String): String {
        val parts = text.split(" · ")
        if (parts.size < 2 || !parts[0].endsWith("完成")) return phrases(text)
        val counts = parts.drop(1).joinToString(" · ")
        return keepTogether(parts[0]) + "：" + if (counts.length <= SHORT_PHRASE * 2) unbreakable(counts) else phrases(counts)
    }

    /** Items up to this length ("新增 128", "睡眠同步完成") never break inside; longer ones may. */
    private const val SHORT_PHRASE = 12

    /**
     * [friendly] whose "（今天 下午 8:56）" part never breaks inside (word joiners between its
     * characters, which CJK text would otherwise allow): it moves to the next line as a whole.
     */
    fun friendlyWrapped(then: Instant, now: Instant, zone: ZoneId, use24Hour: Boolean = true): String =
        relative(then, now) + "（${keepTogether(absolute(then, now, zone, use24Hour).removePrefix("今天 "))}）".toList().joinToString(WORD_JOINER)

    /** [text] that never breaks inside, e.g. a menu path "設定 › 位置 › 時間軸". */
    fun unbreakable(text: String): String = keepTogether(text).toList().joinToString(WORD_JOINER)

    /** Joins characters without a line break between them; invisible and not spoken. */
    const val WORD_JOINER = "\u2060"

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
