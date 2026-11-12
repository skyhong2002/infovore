package tw.skyhong.infovore.health.screen

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class ScreenLogicTest {
    @Test
    fun normalizeCollapsesWhitespaceAndDropsBlankAndRepeatedLines() {
        val text = ScreenText.normalize(listOf("  Hello\t  world ", "", null, "Hello world", "Next\nline", "Hello world"))
        assertEquals("Hello world\nNext line\nHello world", text)
    }

    @Test
    fun normalizeCapsLength() {
        val text = ScreenText.normalize(List(500) { "line $it with some words" })
        assertEquals(ScreenText.MAX_CHARS, text.length)
    }

    @Test
    fun capDoesNotSplitSurrogatePairs() {
        val emoji = "😀"
        val capped = ScreenText.cap("ab$emoji", 3)
        assertEquals("ab", capped)
    }

    @Test
    fun exclusionParsingAcceptsCommasNewlinesAndRejectsJunk() {
        val parsed = Exclusions.parse("com.bank.app, tw.example.pay\n\n not a package ;org.x_y.z\ncom.bank.app")
        assertEquals(setOf("com.bank.app", "tw.example.pay", "org.x_y.z"), parsed)
        assertTrue(Exclusions.isExcluded("com.x8bit.bitwarden", emptySet()))
        assertTrue(Exclusions.isExcluded("tw.example.pay", parsed))
        assertFalse(Exclusions.isExcluded("com.android.chrome", parsed))
    }

    @Test
    fun batchingRespectsCountAndBytes() {
        val byCount = Batching.split((1..95).toList(), maxCount = 40, maxBytes = Long.MAX_VALUE) { 10L }
        assertEquals(listOf(40, 40, 15), byCount.map { it.size })

        val sizes = listOf(3_000L, 3_000L, 3_000L, 500L, 10_000L, 1L)
        val byBytes = Batching.split(sizes, maxCount = 40, maxBytes = 6_500L, separatorBytes = 1) { it }
        assertEquals(listOf(listOf(3_000L, 3_000L), listOf(3_000L, 500L), listOf(10_000L), listOf(1L)), byBytes)
    }

    @Test
    fun imageAttachedOnTextChangeOrAfterRefreshInterval() {
        val policy = ImageAttachPolicy(refreshMs = 300_000L)
        assertTrue(policy.shouldAttach("a", "text", 0L))
        policy.recordAttached("a", "text", 0L)
        assertFalse(policy.shouldAttach("a", "text", 60_000L))
        assertTrue(policy.shouldAttach("a", "changed", 60_000L))
        assertTrue(policy.shouldAttach("a", "text", 300_000L))
        assertTrue(policy.shouldAttach("b", "text", 60_000L))
    }

    @Test
    fun mostlyBlackDetection() {
        val black = IntArray(1000) { 0xFF000000.toInt() }
        assertTrue(Frames.isMostlyBlack(black))
        val withText = black.copyOf().also { for (i in 0 until 100) it[i] = 0xFFFFFFFF.toInt() }
        assertFalse(Frames.isMostlyBlack(withText))
    }
}
