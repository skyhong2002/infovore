package tw.skyhong.infovore.health.screen

/** Pure (Android-free) rules for phone Dayflow capture, kept separate so they can be unit tested. */
object ScreenText {
    const val MAX_CHARS = 4000
    private val whitespace = Regex("\\s+")

    /** Collapses whitespace, drops blank and consecutive duplicate lines, and caps the result. */
    fun normalize(lines: Iterable<CharSequence?>, maxChars: Int = MAX_CHARS): String {
        val out = StringBuilder()
        var previous: String? = null
        for (raw in lines) {
            val line = raw?.toString()?.replace(whitespace, " ")?.trim().orEmpty()
            if (line.isEmpty() || line == previous) continue
            previous = line
            if (out.isNotEmpty()) out.append('\n')
            out.append(line)
            if (out.length >= maxChars) break
        }
        return cap(out.toString(), maxChars)
    }

    /** Truncates to [maxChars] without leaving a dangling high surrogate. */
    fun cap(text: String, maxChars: Int = MAX_CHARS): String {
        if (text.length <= maxChars) return text
        var end = maxChars
        if (end > 0 && Character.isHighSurrogate(text[end - 1])) end--
        return text.substring(0, end)
    }
}

object Exclusions {
    /** Sensitive apps that are always recorded as blocked (package + label only). */
    val DEFAULT_PACKAGES: Set<String> = setOf(
        "com.x8bit.bitwarden",
        "com.onepassword.android",
        "com.agilebits.onepassword",
        "com.lastpass.lpandroid",
        "com.dashlane",
        "keepass2android.keepass2android",
        "com.kunzisoft.keepass.free",
        "com.google.android.apps.authenticator2",
        "com.azure.authenticator",
        "com.authy.authy",
    )

    private val packagePattern = Regex("^[A-Za-z][A-Za-z0-9_]*(\\.[A-Za-z0-9_]+)+$")

    /** Parses a comma / whitespace / newline separated list, keeping only valid package names. */
    fun parse(text: String): Set<String> = text.split(',', ';', '\n', '\r', '\t', ' ')
        .map { it.trim() }
        .filter { it.isNotEmpty() && packagePattern.matches(it) }
        .toCollection(LinkedHashSet())

    fun isExcluded(packageName: String, userPackages: Set<String>): Boolean =
        packageName in DEFAULT_PACKAGES || packageName in userPackages
}

object Batching {
    /**
     * Splits items (in order) into consecutive batches of at most [maxCount] items and at most
     * [maxBytes] summed size (plus [separatorBytes] per item). A single oversized item still
     * forms its own batch so the queue can never stall on it.
     */
    fun <T> split(
        items: List<T>,
        maxCount: Int,
        maxBytes: Long,
        separatorBytes: Long = 1,
        sizeOf: (T) -> Long,
    ): List<List<T>> {
        val batches = mutableListOf<List<T>>()
        var current = mutableListOf<T>()
        var currentBytes = 0L
        for (item in items) {
            val size = sizeOf(item) + separatorBytes
            if (current.isNotEmpty() && (current.size >= maxCount || currentBytes + size > maxBytes)) {
                batches += current
                current = mutableListOf()
                currentBytes = 0L
            }
            current += item
            currentBytes += size
        }
        if (current.isNotEmpty()) batches += current
        return batches
    }
}

/**
 * Decides whether a screenshot is worth attaching: only when the visible text changed since the
 * last image of that package, or the last image is at least [refreshMs] old.
 */
class ImageAttachPolicy(private val refreshMs: Long = 5 * 60_000L) {
    private data class LastImage(val textHash: Int, val atMs: Long)

    private val lastByPackage = HashMap<String, LastImage>()

    fun shouldAttach(packageName: String, text: String, nowMs: Long): Boolean {
        val last = lastByPackage[packageName] ?: return true
        return last.textHash != text.hashCode() || nowMs - last.atMs >= refreshMs
    }

    fun recordAttached(packageName: String, text: String, nowMs: Long) {
        lastByPackage[packageName] = LastImage(text.hashCode(), nowMs)
    }
}

object Frames {
    /** True when nearly all sampled ARGB pixels are black (dark or loading screen); such frames get no image. */
    fun isMostlyBlack(pixels: IntArray, blackShare: Double = 0.985, maxLuma: Int = 16): Boolean {
        if (pixels.isEmpty()) return true
        var black = 0
        for (pixel in pixels) {
            val r = (pixel shr 16) and 0xff
            val g = (pixel shr 8) and 0xff
            val b = pixel and 0xff
            val luma = (r * 299 + g * 587 + b * 114) / 1000
            if (luma < maxLuma) black++
        }
        return black >= pixels.size * blackShare
    }
}
