package tw.skyhong.infovore.health.robo

import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import tw.skyhong.infovore.health.FakeIngestServer
import tw.skyhong.infovore.health.update.AppRelease
import tw.skyhong.infovore.health.update.UpdateChecker
import tw.skyhong.infovore.health.update.UpdateInstaller
import java.security.MessageDigest

/** Finding a newer GitHub release and installing it, against a local server standing in for GitHub. */
@RunWith(RobolectricTestRunner::class)
class UpdateTest {
    private val server = FakeIngestServer()
    private val apk = "pretend this is an APK"
    private val apkSha = MessageDigest.getInstance("SHA-256").digest(apk.toByteArray()).joinToString("") { "%02x".format(it) }

    @Before
    fun setUp() {
        UpdateChecker.testBase = server.endpoint
        UpdateInstaller.reset()
    }

    @After
    fun tearDown() {
        server.close()
    }

    private fun release(tag: String, asset: String, draft: Boolean = false, prerelease: Boolean = false, url: String = "${server.endpoint}/download/$tag/$asset", digest: String = "sha256:$apkSha") = """
        {"tag_name":"$tag","draft":$draft,"prerelease":$prerelease,"body":"Notes for $tag",
         "assets":[{"name":"notes.txt","browser_download_url":"$url.txt","size":3},
                   {"name":"$asset","browser_download_url":"$url","size":${apk.length},"digest":"$digest"}]}
    """

    @Test
    fun onlyPublishedAndroidReleasesFromThisRepositoryCount() {
        val json = "[" + listOf(
            release("android-v0.9.0", "infovore-0.9.0-30.apk"),
            release("android-v1.0.0", "infovore-1.0.0-40.apk", draft = true),
            release("android-v1.1.0", "infovore-1.1.0-41.apk", prerelease = true),
            release("v2.0.0", "infovore-2.0.0-50.apk"),
            release("android-v3.0.0", "infovore-3.0.0-60.apk", url = "https://evil.example/infovore-3.0.0-60.apk"),
            release("android-v0.8.1", "infovore-0.8.1-26.apk", digest = "md5:abc"),
        ).joinToString(",") + "]"
        val releases = UpdateChecker.parse(json)
        assertEquals(listOf(30, 26), releases.map { it.versionCode })
        assertEquals(apkSha, releases[0].sha256)
        assertNull(releases[1].sha256)
        assertEquals("Notes for android-v0.9.0", releases[0].notes)

        assertEquals(30, UpdateChecker.newest(releases, currentCode = 25)?.versionCode)
        assertNull(UpdateChecker.newest(releases, currentCode = 30))
    }

    @Test
    fun fetchReadsTheReleaseListWithoutCredentials() {
        server.responder = { FakeIngestServer.Response(200, "[" + release("android-v0.9.0", "infovore-0.9.0-30.apk") + "]") }
        assertEquals("0.9.0", UpdateChecker.fetch().single().versionName)
        assertNull(server.requests.single().authorization)
    }

    private fun installAndWait(release: AppRelease): UpdateInstaller.State {
        assertTrue(UpdateInstaller.start(Robo.app, release))
        Robo.waitFor(10_000) { UpdateInstaller.state.value.let { it is UpdateInstaller.State.Installing || it is UpdateInstaller.State.Failed } }
        return UpdateInstaller.state.value
    }

    @Test
    fun aVerifiedDownloadIsCommittedToThePackageInstaller() {
        server.responder = { FakeIngestServer.Response(200, apk) }
        val release = AppRelease("0.9.0", 30, "", "${server.endpoint}/download/a/infovore-0.9.0-30.apk", apk.length.toLong(), apkSha)

        val state = installAndWait(release)
        assertTrue(state.toString(), state is UpdateInstaller.State.Installing)
        val sessions = Robo.app.packageManager.packageInstaller.allSessions
        assertEquals(1, sessions.size)
        assertEquals(Robo.app.packageName, sessions.single().appPackageName)
    }

    @Test
    fun aDownloadThatDoesNotMatchGithubsDigestIsNotInstalled() {
        server.responder = { FakeIngestServer.Response(200, "something else entirely") }
        val release = AppRelease("0.9.0", 30, "", "${server.endpoint}/download/a/infovore-0.9.0-30.apk", -1, apkSha)

        val state = installAndWait(release)
        assertTrue(state is UpdateInstaller.State.Failed)
        assertTrue((state as UpdateInstaller.State.Failed).message.contains("SHA-256"))
        assertTrue("the session is abandoned", Robo.app.packageManager.packageInstaller.allSessions.isEmpty())
    }
}
