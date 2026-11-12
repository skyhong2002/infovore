package tw.skyhong.infovore.health

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import tw.skyhong.infovore.health.ReconcilePlanner.Item
import kotlin.random.Random

class ReconcilePlannerTest {
    private val start = 1_000L
    private val end = 2_000L

    private fun item(id: String, at: Long, until: Long = at) = Item(id, at, until)

    @Test
    fun aSmallCompleteReadBecomesOneWindowOverTheWholeRange() {
        val planner = ReconcilePlanner("steps", start, end, ascending = true)
        assertEquals(emptyList<ReconcileWindow>(), planner.add(listOf(item("a", 1_000), item("b", 1_500))))
        assertEquals(emptyList<ReconcileWindow>(), planner.add(listOf(item("c", 1_999))))
        assertEquals(ReconcileWindow("steps", start, end, listOf("a", "b", "c")), planner.finish())
        assertNull(planner.failure)
    }

    @Test
    fun anEmptyReadStillReconcilesTheWindow() {
        val planner = ReconcilePlanner("weight", start, end, ascending = true)
        assertEquals(ReconcileWindow("weight", start, end, emptyList()), planner.finish())
    }

    @Test
    fun recordsStartingOutsideTheWindowAreNeverListed() {
        val planner = ReconcilePlanner("sleep_session", start, end, ascending = true)
        planner.add(listOf(item("before", 999), item("inside", 1_200), item("at-end", 2_000)))
        assertEquals(listOf("inside"), planner.finish()?.recordIds)
    }

    @Test
    fun longReadsAreCutOnlyBetweenDistinctStartTimes() {
        val planner = ReconcilePlanner("steps", start, end, ascending = true, targetIds = 2, maxIds = 5)
        val windows = planner.add(listOf(item("a", 1_100), item("b", 1_100), item("c", 1_100), item("d", 1_200), item("e", 1_300)))
        // a, b and c share a start time, so the first cut waits for d; it is placed right after
        // the earlier side (just after its start, these being instants), not at d's start.
        assertEquals(listOf(ReconcileWindow("steps", 1_000, 1_101, listOf("a", "b", "c"))), windows)
        assertEquals(ReconcileWindow("steps", 1_101, 2_000, listOf("d", "e")), planner.finish())
    }

    @Test
    fun descendingReadsProduceTheSameKindOfWindows() {
        val planner = ReconcilePlanner("sleep_session", start, end, ascending = false, targetIds = 2, maxIds = 5)
        val windows = planner.add(listOf(item("z", 1_900), item("y", 1_800), item("x", 1_700)))
        // The cut follows the earlier side's latest record (x), so the gap up to y is in the later window.
        assertEquals(listOf(ReconcileWindow("sleep_session", 1_701, 2_000, listOf("z", "y"))), windows)
        assertEquals(ReconcileWindow("sleep_session", 1_000, 1_701, listOf("x")), planner.finish())
    }

    @Test
    fun everyWindowListsExactlyTheRecordsStartingInsideIt() {
        val random = Random(42)
        for (ascending in listOf(true, false)) {
            repeat(50) { round ->
                val starts = List(random.nextInt(0, 400)) { random.nextLong(900, 2_100) }.sorted()
                // Mostly short records, some long ones overlapping their neighbours.
                val items = starts.mapIndexed { index, at ->
                    item("r$round-$index", at, at + if (random.nextInt(10) == 0) random.nextLong(0, 80) else random.nextLong(0, 4))
                }
                val ordered = if (ascending) items else items.reversed()
                val planner = ReconcilePlanner("heart_rate", start, end, ascending, targetIds = 7, maxIds = 400)
                val windows = ordered.chunked(random.nextInt(1, 60)).flatMap(planner::add) + listOfNotNull(planner.finish())
                assertNull(planner.failure)

                val sorted = windows.sortedBy { it.startMs }
                assertEquals(start, sorted.first().startMs)
                assertEquals(end, sorted.last().endMs)
                sorted.zipWithNext().forEach { (a, b) -> assertEquals("windows are contiguous", a.endMs, b.startMs) }
                for (window in windows) {
                    assertTrue(window.recordIds.size <= 400)
                    val expected = items.filter { it.startMs >= window.startMs && it.startMs < window.endMs }.map { it.id }.toSet()
                    assertEquals(expected, window.recordIds.toSet())
                }
                if (ascending) {
                    // No record of the window's read lies across an internal cut.
                    val inside = items.filter { it.startMs in start until end }
                    for (cut in sorted.dropLast(1).map { it.endMs }) {
                        assertTrue("record across $cut", inside.none { it.startMs < cut && it.endMs > cut })
                    }
                }
            }
        }
    }

    @Test
    fun aCutFallsWhereTheEarlierRecordsEndSoAGapLandsInTheLaterWindow() {
        // Contiguous 10 ms records, one of which (r4, 1_040..1_050) was deleted at the source and
        // so is not read. The earlier side ends at 1_040: the cut goes there, not at r5's start
        // (1_050), so r4 starts inside the later window and ends before its end; the server can
        // delete it. A cut at 1_050 would have left r4 in no window's deletable range.
        val planner = ReconcilePlanner("steps", start, end, ascending = true, targetIds = 4, maxIds = 10)
        val read = (0 until 8).filter { it != 4 }.map { item("r$it", 1_000L + it * 10, 1_010L + it * 10) }
        val windows = planner.add(read) + listOfNotNull(planner.finish())
        assertEquals(
            listOf(
                ReconcileWindow("steps", 1_000, 1_040, listOf("r0", "r1", "r2", "r3")),
                ReconcileWindow("steps", 1_040, 2_000, listOf("r5", "r6", "r7")),
            ),
            windows,
        )
    }

    @Test
    fun aLongRecordDelaysTheCutUntilNothingReadLiesAcrossIt() {
        val planner = ReconcilePlanner("exercise_session", start, end, ascending = true, targetIds = 2, maxIds = 10)
        val windows = planner.add(
            listOf(
                item("long", 1_000, 1_500),
                item("b", 1_100, 1_110),
                item("c", 1_200, 1_210),
                item("d", 1_300, 1_310),
                item("e", 1_600, 1_610),
            ),
        )
        assertEquals(listOf(ReconcileWindow("exercise_session", 1_000, 1_500, listOf("long", "b", "c", "d"))), windows)
        assertEquals(ReconcileWindow("exercise_session", 1_500, 2_000, listOf("e")), planner.finish())
    }

    @Test
    fun aDescendingCutAvoidsTheRecordItFollows() {
        val planner = ReconcilePlanner("sleep_session", start, end, ascending = false, targetIds = 1, maxIds = 10)
        // y (1_700..1_850) overlaps z's start: no cut between them; x ends at 1_650, so the cut is there.
        val windows = planner.add(listOf(item("z", 1_800, 1_900), item("y", 1_700, 1_850), item("x", 1_600, 1_650)))
        assertEquals(listOf(ReconcileWindow("sleep_session", 1_650, 2_000, listOf("z", "y"))), windows)
        assertEquals(ReconcileWindow("sleep_session", 1_000, 1_650, listOf("x")), planner.finish())
    }

    @Test
    fun overlapsThatLeaveNoSafeCutWithinTheLimitStayUnverified() {
        val planner = ReconcilePlanner("heart_rate", start, end, ascending = true, targetIds = 2, maxIds = 3)
        planner.add(listOf(item("long", 1_000, 1_900), item("b", 1_100), item("c", 1_200), item("d", 1_300)))
        assertEquals(ReconcilePlanner.NO_SAFE_CUT, planner.failure)
        assertNull(planner.finish())
    }

    @Test
    fun anOutOfOrderReadStopsReconcilingThatType() {
        val planner = ReconcilePlanner("steps", start, end, ascending = true)
        planner.add(listOf(item("a", 1_500), item("b", 1_400)))
        assertEquals(ReconcilePlanner.OUT_OF_ORDER, planner.failure)
        assertEquals(emptyList<ReconcileWindow>(), planner.add(listOf(item("c", 1_600))))
        assertNull(planner.finish())
    }

    @Test
    fun tooManyRecordsAtOneInstantStopsReconcilingInsteadOfExceedingTheServerLimit() {
        val planner = ReconcilePlanner("steps", start, end, ascending = true, targetIds = 2, maxIds = 3)
        planner.add(List(4) { item("same-$it", 1_500) })
        assertEquals(ReconcilePlanner.TOO_MANY_AT_ONCE, planner.failure)
        assertNull(planner.finish())
    }

    @Test
    fun theDefaultsStayWithinTheServerLimit() {
        assertTrue(ReconcilePlanner.TARGET_IDS < ReconcilePlanner.MAX_IDS)
        assertEquals(5000, ReconcilePlanner.MAX_IDS)
    }

    @Test
    fun windowsEncodeAsTheServerReconcileObject() {
        val json = ReconcileWindow("steps", 1_788_220_800_000, 1_788_825_600_123, listOf("a-1", "q\"uote")).toJson()
        assertEquals(
            "{\"dataType\":\"steps\",\"start\":\"2026-09-01T00:00:00Z\",\"end\":\"2026-09-08T00:00:00.123Z\"," +
                "\"recordIds\":[\"a-1\",\"q\\\"uote\"]}",
            json,
        )
    }

    @Test
    fun jsonStringsEscapeControlAndSeparatorCharacters() {
        assertEquals("\"a\\\\b\\n\\u0001\\u2028\"", JsonText.quote("a\\b\n\u0001 "))
    }

    @Test
    fun theStatusNoteNamesUnverifiedTypesOnly() {
        assertEquals("", ReconcileText.note(emptyList()))
        val note = ReconcileText.note(listOf("步數（${ReconcileText.serverRejected(409)}）", "睡眠（${ReconcileText.NOT_REPORTED}）"))
        assertTrue(note, note.contains("未重新核實"))
        assertTrue(note.contains("步數") && note.contains("睡眠"))
        assertNotNull(ReconcileText.serverRejected(400))
    }
}
