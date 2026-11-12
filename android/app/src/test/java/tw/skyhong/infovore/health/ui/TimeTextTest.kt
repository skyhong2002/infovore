package tw.skyhong.infovore.health.ui

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test
import java.time.Instant
import java.time.ZoneId

class TimeTextTest {
    private val taipei = ZoneId.of("Asia/Taipei")

    // 2026-11-12 14:00 in Taipei.
    private val now = Instant.parse("2026-11-12T06:00:00Z")

    @Test
    fun relativePhrases() {
        assertEquals("剛剛", TimeText.relative(now.minusSeconds(30), now))
        assertEquals("5 分鐘前", TimeText.relative(now.minusSeconds(5 * 60), now))
        assertEquals("3 小時前", TimeText.relative(now.minusSeconds(3 * 3600 + 59), now))
        assertEquals("1 天前", TimeText.relative(now.minusSeconds(30 * 3600), now))
        assertEquals("6 天前", TimeText.relative(now.minusSeconds(6 * 86_400), now))
        assertEquals("超過一個月前", TimeText.relative(now.minusSeconds(40L * 86_400), now))
        assertEquals("42 分鐘後", TimeText.relative(now.plusSeconds(41 * 60 + 10), now))
    }

    @Test
    fun absoluteUsesLocalCalendarDays() {
        assertEquals("今天 13:05", TimeText.absolute(Instant.parse("2026-11-12T05:05:00Z"), now, taipei))
        // 23:30 local on the 11th is "yesterday" even though it is only 14.5 hours ago.
        assertEquals("昨天 23:30", TimeText.absolute(Instant.parse("2026-11-11T15:30:00Z"), now, taipei))
        assertEquals("11月2日 09:15", TimeText.absolute(Instant.parse("2026-11-02T01:15:00Z"), now, taipei))
        assertEquals("2025年12月31日 08:00", TimeText.absolute(Instant.parse("2025-12-31T00:00:00Z"), now, taipei))
    }

    @Test
    fun twelveHourClockFollowsDeviceSetting() {
        assertEquals("今天 下午 1:05", TimeText.absolute(Instant.parse("2026-11-12T05:05:00Z"), now, taipei, use24Hour = false))
    }

    @Test
    fun friendlyCombinesBoth() {
        assertEquals("55 分鐘前（今天 13:05）", TimeText.friendly(Instant.parse("2026-11-12T05:05:00Z"), now, taipei))
    }

    @Test
    fun humanizesSavedStatusTimestamps() {
        val status = "2026-11-12T05:57:12.345678Z：同步完成，新增 3、更新 0、刪除 0"
        assertEquals("2 分鐘前（今天 13:57）：同步完成，新增 3、更新 0、刪除 0", TimeText.humanizeStatus(status, now, taipei))
        assertEquals("尚未同步", TimeText.humanizeStatus("尚未同步", now, taipei))
        assertEquals("讀取睡眠資料…", TimeText.humanizeStatus("讀取睡眠資料…", now, taipei))
    }

    @Test
    fun splitStatusSeparatesTimeAndMessage() {
        val (instant, message) = TimeText.splitStatus("2026-11-12T05:00:00Z：睡眠未完成：x")
        assertEquals(Instant.parse("2026-11-12T05:00:00Z"), instant)
        assertEquals("睡眠未完成：x", message)
        assertNull(TimeText.splitStatus("no time").first)
    }

    @Test
    fun parsesServerTimes() {
        assertEquals(Instant.parse("2026-11-12T05:00:00Z"), TimeText.parseServerTime("2026-11-12T05:00:00Z"))
        assertEquals(Instant.parse("2026-11-12T05:00:00Z"), TimeText.parseServerTime("2026-11-12T13:00:00+08:00"))
        assertNull(TimeText.parseServerTime("null"))
        assertNull(TimeText.parseServerTime(""))
        assertNull(TimeText.parseServerTime("yesterday"))
    }
}
