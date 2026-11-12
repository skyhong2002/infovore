package tw.skyhong.infovore.health

import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.cancel
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.launch
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.yield
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.util.concurrent.atomic.AtomicInteger

class SyncCoordinatorTest {
    private fun CoroutineScope.coordinator() = SyncCoordinator(this) { "described: ${it.message}" }

    @Test
    fun secondManualRequestIsRefusedWhileOneRuns() = runBlocking<Unit> {
        val sync = coordinator()
        val gate = CompletableDeferred<Unit>()
        var runs = 0
        assertTrue(sync.startManual(SyncKind.FULL) { progress -> runs++; progress("步數：已處理 500 筆"); gate.await() })
        yield()
        assertFalse(sync.startManual(SyncKind.SLEEP) { runs++ })
        assertEquals(SyncKind.FULL, sync.state.value.running)
        assertEquals("步數：已處理 500 筆", sync.state.value.progress)
        gate.complete(Unit)
        sync.state.first { it.running == null }
        assertEquals(1, runs)
        assertNull(sync.state.value.failed)
        assertNull(sync.state.value.progress)
    }

    @Test
    fun failureIsKeptForRetryAndClearedByTheNextStart() = runBlocking<Unit> {
        val sync = coordinator()
        sync.startManual(SyncKind.SLEEP) { throw IllegalStateException("boom") }
        val failed = sync.state.first { it.running == null && it.failed != null }
        assertEquals(SyncKind.SLEEP, failed.failed)
        assertEquals("described: boom", failed.error)

        val gate = CompletableDeferred<Unit>()
        sync.startManual(SyncKind.SLEEP) { gate.await() }
        assertNull(sync.state.value.failed)
        assertNull(sync.state.value.error)
        gate.complete(Unit)
        sync.state.first { it.running == null }
    }

    @Test
    fun backgroundSyncIsSkippedWhileAManualSyncRuns() = runBlocking<Unit> {
        val sync = coordinator()
        val gate = CompletableDeferred<Unit>()
        sync.startManual(SyncKind.FULL) { gate.await() }
        yield()
        var ran = false
        assertNull(sync.runBackground { ran = true })
        assertFalse(ran)
        gate.complete(Unit)
        sync.state.first { it.running == null }
        assertEquals("ok", sync.runBackground { "ok" })
        assertFalse(sync.state.value.backgroundRunning)
    }

    @Test
    fun manualSyncWaitsForTheBackgroundSyncAndNeverOverlaps() = runBlocking<Unit> {
        val sync = coordinator()
        val active = AtomicInteger()
        var maxActive = 0
        val track: suspend (suspend () -> Unit) -> Unit = { body ->
            maxActive = maxOf(maxActive, active.incrementAndGet())
            body()
            active.decrementAndGet()
        }
        val backgroundGate = CompletableDeferred<Unit>()
        val background = launch { sync.runBackground { track { backgroundGate.await() } } }
        yield()
        assertTrue(sync.state.value.backgroundRunning)
        assertTrue(sync.state.value.busy)

        var manualRan = false
        assertTrue(sync.startManual(SyncKind.FULL) { track { manualRan = true } })
        yield()
        assertFalse(manualRan)
        assertEquals(SyncCoordinator.WAITING_FOR_BACKGROUND, sync.state.value.progress)

        backgroundGate.complete(Unit)
        background.join()
        sync.state.first { it.running == null }
        assertTrue(manualRan)
        assertEquals(1, maxActive)
    }

    @Test
    fun destinationResetOnlyRunsWhenNoSyncIsActive() = runBlocking<Unit> {
        val sync = coordinator()
        var resets = 0
        assertTrue(sync.tryExclusive { resets++ })

        val gate = CompletableDeferred<Unit>()
        sync.startManual(SyncKind.SLEEP) { gate.await() }
        assertFalse(sync.tryExclusive { resets++ })
        gate.complete(Unit)
        sync.state.first { it.running == null }

        val backgroundGate = CompletableDeferred<Unit>()
        val background = launch { sync.runBackground { backgroundGate.await() } }
        yield()
        assertFalse(sync.tryExclusive { resets++ })
        backgroundGate.complete(Unit)
        background.join()
        assertTrue(sync.tryExclusive { resets++ })
        assertEquals(2, resets)
    }

    @Test
    fun aLaterBackgroundSuccessClearsOnlyAStaleFullFailure() = runBlocking<Unit> {
        val sync = coordinator()
        sync.startManual(SyncKind.SLEEP) { throw IllegalStateException("sleep") }
        sync.state.first { it.failed != null }
        sync.clearFailure(SyncKind.FULL)
        assertEquals(SyncKind.SLEEP, sync.state.value.failed)

        sync.startManual(SyncKind.FULL) { throw IllegalStateException("full") }
        sync.state.first { it.failed == SyncKind.FULL }
        sync.clearFailure(SyncKind.FULL)
        assertNull(sync.state.value.failed)
        assertNull(sync.state.value.error)
    }

    @Test
    fun aManualSyncOutlivesTheCallerThatStartedIt() = runBlocking<Unit> {
        // The runner's scope is independent of whoever called startManual (e.g. a finished activity).
        val runnerScope = CoroutineScope(Job())
        val sync = SyncCoordinator(runnerScope) { it.message.orEmpty() }
        val gate = CompletableDeferred<Unit>()
        val finished = CompletableDeferred<Unit>()
        val caller = launch {
            sync.startManual(SyncKind.FULL) { gate.await(); finished.complete(Unit) }
        }
        caller.join()
        caller.cancel()
        gate.complete(Unit)
        finished.await()
        sync.state.first { it.running == null }
        assertNull(sync.state.value.failed)
        runnerScope.cancel()
    }
}
