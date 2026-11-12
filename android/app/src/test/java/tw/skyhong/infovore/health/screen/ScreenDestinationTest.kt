package tw.skyhong.infovore.health.screen

import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.async
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.yield
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import tw.skyhong.infovore.health.DestinationChange
import tw.skyhong.infovore.health.InfovoreApi
import java.io.File
import java.io.IOException

/**
 * Two fake receivers, A and B. Records captured for A and A's phone token must never reach B,
 * whether the destination changes while records are queued or in the middle of an upload run.
 */
class ScreenDestinationTest {
    @get:Rule
    val folder = TemporaryFolder()

    private val endpointA = "https://a.example"
    private val endpointB = "https://B.example/"
    private val destA = DestinationChange.normalize(endpointA)
    private val destB = DestinationChange.normalize(endpointB)
    private val tokenA = "a".repeat(40)
    private val tokenB = "b".repeat(40)

    /** The "saved settings" the app would read; the engine must only use its start-of-run snapshot. */
    private var savedEndpoint = endpointA
    private var savedToken = tokenA
    private var savedTokenDestination: String? = destA

    private fun target() = ScreenTarget(savedEndpoint, savedToken, savedTokenDestination, "device-fixture-1")

    private data class Post(val endpoint: String, val token: String, val body: String)

    /** Fake HTTP: records every request by the endpoint and token it was actually sent with. */
    private class FakeServers(private val onPost: (Int) -> Unit = {}) : ObservationTransport {
        val posts = mutableListOf<Post>()
        var failWith: Exception? = null

        override fun post(target: ScreenTarget, body: ByteArray): ObservationTransport.Response {
            failWith?.let { throw it }
            posts += Post(DestinationChange.normalize(target.endpoint), target.token, String(body))
            onPost(posts.size)
            return ObservationTransport.Response(accepted = body.size, duplicates = 0)
        }

        fun to(destination: String) = posts.filter { it.endpoint == destination }
    }

    private fun queue(root: File = folder.root) = ObservationQueue(root) { it.startsWith("{") }

    private fun ObservationQueue.capture(destination: String, id: String, at: Long = System.currentTimeMillis()) =
        enqueueJson(destination, at, id, "{\"id\":\"$id\",\"text\":\"secret screen text for $id\"}")

    @Test
    fun recordsQueuedForAAreNotSentAfterSwitchingToB() {
        val queue = queue()
        val now = System.currentTimeMillis()
        queue.capture(destA, "a-1", now - 3)
        queue.capture(destA, "a-2", now - 2)

        // The user switches to B (the app clears A's token; here B's token is entered right away).
        savedEndpoint = endpointB
        savedToken = tokenB
        savedTokenDestination = destB
        queue.capture(destB, "b-1", now - 1)

        val servers = FakeServers()
        val outcome = ScreenUploadEngine(queue, servers).upload(target())

        assertNull(outcome.error)
        assertEquals(1, outcome.sent)
        assertTrue(servers.to(destA).isEmpty())
        val toB = servers.to(destB).joinToString { it.body }
        assertTrue(toB.contains("b-1"))
        assertFalse("A's screen text never reaches B", toB.contains("a-1") || toB.contains("a-2"))
        assertTrue(servers.posts.all { it.token == tokenB })
        // A's records stay on the phone, reported as belonging to another destination.
        assertEquals(0, queue.count(destB))
        assertEquals(2, queue.countOtherDestinations(destB))
    }

    @Test
    fun aSwitchInTheMiddleOfAnUploadRunCannotRedirectItsLaterBatches() {
        val queue = queue()
        val now = System.currentTimeMillis()
        repeat(5) { queue.capture(destA, "a-$it", now - 10 + it) }
        val servers = FakeServers { posted ->
            if (posted == 1) {
                // After the first batch, the saved settings switch to B and B gets its own records.
                savedEndpoint = endpointB
                savedToken = tokenB
                savedTokenDestination = destB
                queue.capture(destB, "b-late", now)
            }
        }

        val outcome = ScreenUploadEngine(queue, servers, maxBatchCount = 2).upload(target())

        assertNull(outcome.error)
        assertEquals(5, outcome.sent)
        assertEquals(3, servers.posts.size)
        assertTrue("every batch of the run went to A with A's token", servers.posts.all { it.endpoint == destA && it.token == tokenA })
        assertFalse(servers.posts.any { it.body.contains("b-late") })
        assertTrue(servers.to(destB).isEmpty())
        assertEquals(1, queue.count(destB))
    }

    @Test
    fun aTokenSavedForANeverGoesToB() {
        val queue = queue()
        queue.capture(destB, "b-1")
        // Endpoint now B, but the stored phone token was saved for A.
        savedEndpoint = endpointB
        savedToken = tokenA
        savedTokenDestination = destA
        val servers = FakeServers()

        val outcome = ScreenUploadEngine(queue, servers).upload(target())

        assertEquals(ScreenTarget.TOKEN_FOR_OTHER_DESTINATION, outcome.error)
        assertTrue(servers.posts.isEmpty())
        assertEquals(1, queue.count(destB))
        // A legacy token without a destination is refused the same way.
        savedTokenDestination = null
        assertEquals(ScreenTarget.TOKEN_FOR_OTHER_DESTINATION, ScreenUploadEngine(queue, servers).upload(target()).error)
        assertTrue(servers.posts.isEmpty())
    }

    @Test
    fun failedBatchesStayQueuedForTheirOwnDestination() {
        val queue = queue()
        queue.capture(destA, "a-1")
        val servers = FakeServers().apply { failWith = IOException("offline") }
        val outcome = ScreenUploadEngine(queue, servers).upload(target())
        assertEquals("offline", outcome.error)
        assertEquals(1, queue.count(destA))

        servers.failWith = InfovoreApi.HttpStatusException(401, "Infovore HTTP 401")
        assertEquals(1, ScreenUploadEngine(queue, servers).upload(target()).remaining)

        servers.failWith = null
        assertEquals(1, ScreenUploadEngine(queue, servers).upload(target()).sent)
        assertTrue(servers.posts.all { it.endpoint == destA && it.token == tokenA })
    }

    @Test
    fun recordsFromBeforeDestinationsWereTrackedAreNeverUploaded() {
        val root = folder.newFolder("legacy-queue")
        val now = System.currentTimeMillis()
        File(root, "${now.toString().padStart(15, '0')}-legacy.json").writeText("{\"id\":\"legacy\"}")
        val queue = queue(root)
        queue.capture(destA, "a-1", now + 1)
        val servers = FakeServers()

        ScreenUploadEngine(queue, servers).upload(target())

        assertEquals(1, servers.posts.size)
        assertFalse(servers.posts.single().body.contains("legacy"))
        assertEquals(1, queue.countOtherDestinations(destA))
    }

    @Test
    fun onlyAnExplicitDeleteRemovesOtherDestinationsRecords() {
        val queue = queue()
        val now = System.currentTimeMillis()
        File(folder.root, "${now.toString().padStart(15, '0')}-legacy.json").writeText("{\"id\":\"legacy\"}")
        queue.capture(destA, "a-1", now)
        queue.capture(destA, "a-2", now)
        queue.capture(destB, "b-1", now)
        queue.prune(now)
        assertEquals(3, queue.countOtherDestinations(destB))

        assertEquals(3, queue.removeOtherDestinations(destB))
        assertEquals(0, queue.countOtherDestinations(destB))
        assertEquals(1, queue.count(destB))
        // Switching back to A later finds nothing of A's left: deletion was the user's choice.
        assertEquals(0, queue.count(destA))
    }

    @Test
    fun theSameDestinationWrittenDifferentlySharesOneQueue() {
        val queue = queue()
        queue.capture(DestinationChange.normalize("HTTPS://A.example:443/"), "a-1")
        assertEquals(1, queue.count(destA))
        assertEquals(0, queue.countOtherDestinations(destA))
    }

    @Test
    fun pruningStillAppliesAcrossDestinations() {
        val queue = queue()
        val now = System.currentTimeMillis()
        queue.capture(destA, "old", now - ObservationQueue.MAX_AGE_MS - 1)
        queue.capture(destB, "new", now)
        queue.prune(now)
        assertEquals(0, queue.count(destA))
        assertEquals(1, queue.count(destB))
    }

    @Test
    fun aDestinationChangeCannotRunWhileAnUploadHoldsTheLock() = runBlocking {
        val lock = UploadLock()
        val uploading = CompletableDeferred<Unit>()
        val release = CompletableDeferred<Unit>()
        val upload = async {
            lock.withLock {
                uploading.complete(Unit)
                release.await()
            }
        }
        uploading.await()
        var changed = false
        assertFalse(lock.tryExclusive { changed = true })
        assertFalse(changed)
        assertTrue(lock.isLocked)

        release.complete(Unit)
        upload.await()
        yield()
        assertTrue(lock.tryExclusive { changed = true })
        assertTrue(changed)
    }
}
