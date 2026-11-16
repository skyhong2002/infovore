package tw.skyhong.infovore.health.update

import androidx.annotation.VisibleForTesting
import org.json.JSONArray
import java.io.IOException
import java.net.HttpURLConnection
import java.net.URL

/** A published app version: a GitHub release `android-v<name>` with the asset `infovore-<name>-<code>.apk`. */
data class AppRelease(
    val versionName: String,
    val versionCode: Int,
    val notes: String,
    val apkUrl: String,
    val sizeBytes: Long,
    /** Lower-case hex SHA-256 GitHub reports for the asset; null when it reports none. */
    val sha256: String?,
)

/**
 * Finds newer versions in the public repository's GitHub releases (no credentials; GitHub allows
 * 60 anonymous requests an hour per address, and the app asks at most every few hours).
 * Drafts, pre-releases, other tags and assets not downloaded from this repository's releases are
 * ignored. Android itself only installs an update signed with the same key, so a release asset
 * cannot replace the app with something signed by anyone else.
 */
object UpdateChecker {
    private const val REPOSITORY = "skyhong2002/infovore"
    private const val TAG_PREFIX = "android-v"
    private val ASSET = Regex("""^infovore-(\d+(?:\.\d+)*)-(\d+)\.apk$""")

    /** Test only: a local server standing in for both the API and the download host. */
    @VisibleForTesting
    @Volatile
    internal var testBase: String? = null

    private val apiUrl: String get() = testBase?.let { "$it/releases" } ?: "https://api.github.com/repos/$REPOSITORY/releases?per_page=20"
    private val downloadPrefix: String get() = testBase?.let { "$it/download/" } ?: "https://github.com/$REPOSITORY/releases/download/"

    fun parse(json: String): List<AppRelease> {
        val releases = JSONArray(json)
        return (0 until releases.length()).mapNotNull { index ->
            val release = releases.optJSONObject(index) ?: return@mapNotNull null
            if (release.optBoolean("draft") || release.optBoolean("prerelease")) return@mapNotNull null
            val tag = release.optString("tag_name")
            if (!tag.startsWith(TAG_PREFIX)) return@mapNotNull null
            val assets = release.optJSONArray("assets") ?: return@mapNotNull null
            (0 until assets.length()).asSequence().mapNotNull { assets.optJSONObject(it) }.firstNotNullOfOrNull { asset ->
                val match = ASSET.matchEntire(asset.optString("name")) ?: return@firstNotNullOfOrNull null
                val url = asset.optString("browser_download_url")
                if (!url.startsWith(downloadPrefix)) return@firstNotNullOfOrNull null
                AppRelease(
                    versionName = match.groupValues[1],
                    versionCode = match.groupValues[2].toIntOrNull() ?: return@firstNotNullOfOrNull null,
                    notes = release.optString("body").trim(),
                    apkUrl = url,
                    sizeBytes = asset.optLong("size", -1),
                    sha256 = asset.optString("digest").removePrefix("sha256:").lowercase().takeIf { Regex("[0-9a-f]{64}").matches(it) },
                )
            }
        }
    }

    /** The newest release above [currentCode], or null when this is the newest. */
    fun newest(releases: List<AppRelease>, currentCode: Int): AppRelease? =
        releases.filter { it.versionCode > currentCode }.maxByOrNull { it.versionCode }

    /** Blocking; call off the main thread. */
    fun fetch(): List<AppRelease> {
        val connection = URL(apiUrl).openConnection() as HttpURLConnection
        return try {
            connection.connectTimeout = 15_000
            connection.readTimeout = 15_000
            connection.setRequestProperty("Accept", "application/vnd.github+json")
            connection.setRequestProperty("User-Agent", "infovore-android")
            val status = connection.responseCode
            if (status !in 200..299) throw IOException("GitHub HTTP $status")
            parse(connection.inputStream.bufferedReader().use { it.readText() })
        } finally {
            connection.disconnect()
        }
    }
}
