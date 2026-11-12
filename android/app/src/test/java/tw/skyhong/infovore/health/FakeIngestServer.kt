package tw.skyhong.infovore.health

import java.io.BufferedInputStream
import java.io.ByteArrayOutputStream
import java.io.IOException
import java.io.InputStream
import java.net.InetAddress
import java.net.ServerSocket
import java.net.Socket
import java.net.SocketException
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.ExecutorService
import java.util.concurrent.Executors

/**
 * A real HTTP/1.1 server on the loopback interface standing in for Infovore's ingest service in
 * JVM tests. The app's real [InfovoreApi] connects to it over a socket; every request is
 * recorded, and [responder] decides each answer. Tests allow plain HTTP to 127.0.0.1 through
 * [EndpointPolicy.testHttpHost].
 *
 * Built on java.net.ServerSocket rather than the JDK's com.sun.net.httpserver, which the Android
 * unit-test compile classpath (android.jar) does not expose. It speaks just what
 * HttpURLConnection sends: one request per connection, a Content-Length body, `Connection: close`.
 */
class FakeIngestServer(
    @Volatile var responder: (Request) -> Response = { Response(200, "{}") },
) : AutoCloseable {
    data class Request(
        val method: String,
        /** The path and query, as sent. */
        val path: String,
        val authorization: String?,
        val contentType: String?,
        val body: String,
    )

    /** [delayMs]: wait before answering (to run into the client's read timeout). */
    data class Response(val status: Int, val body: String, val delayMs: Long = 0)

    val requests: MutableList<Request> = CopyOnWriteArrayList()

    private val socket = ServerSocket(0, 50, InetAddress.getLoopbackAddress())
    private val executor: ExecutorService = Executors.newCachedThreadPool()

    init {
        executor.execute {
            while (!socket.isClosed) {
                val client = try {
                    socket.accept()
                } catch (_: SocketException) {
                    break
                }
                executor.execute { serve(client) }
            }
        }
    }

    val port: Int get() = socket.localPort

    /** The endpoint to save in the app: plain HTTP on 127.0.0.1. */
    val endpoint: String get() = "http://127.0.0.1:$port"

    private fun serve(client: Socket) {
        client.use {
            try {
                val input = BufferedInputStream(client.getInputStream())
                val requestLine = readLine(input) ?: return
                val (method, target) = requestLine.split(' ').let { it[0] to it[1] }
                val headers = mutableMapOf<String, String>()
                while (true) {
                    val line = readLine(input) ?: return
                    if (line.isEmpty()) break
                    val colon = line.indexOf(':')
                    if (colon > 0) headers[line.substring(0, colon).trim().lowercase()] = line.substring(colon + 1).trim()
                }
                val length = headers["content-length"]?.toInt() ?: 0
                val body = ByteArray(length)
                var read = 0
                while (read < length) {
                    val n = input.read(body, read, length - read)
                    if (n < 0) return
                    read += n
                }
                val request = Request(method, target, headers["authorization"], headers["content-type"], body.toString(Charsets.UTF_8))
                requests += request
                val response = try {
                    responder(request)
                } catch (error: Throwable) {
                    // A broken test responder shows up as a non-retryable answer, never as a hang.
                    Response(418, "{\"error\":\"fake responder failed: ${error.javaClass.simpleName}\"}")
                }
                if (response.delayMs > 0) Thread.sleep(response.delayMs)
                val bytes = response.body.toByteArray(Charsets.UTF_8)
                val head = "HTTP/1.1 ${response.status} Fake\r\nContent-Type: application/json\r\n" +
                    "Content-Length: ${bytes.size}\r\nConnection: close\r\n\r\n"
                client.getOutputStream().apply {
                    write(head.toByteArray(Charsets.US_ASCII))
                    write(bytes)
                    flush()
                }
            } catch (_: IOException) {
                // The client gave up (timeout) before the answer was written.
            } catch (_: InterruptedException) {
                // close() while a delayed answer was waiting.
            }
        }
    }

    private fun readLine(input: InputStream): String? {
        val line = ByteArrayOutputStream()
        while (true) {
            val b = input.read()
            if (b < 0) return null
            if (b == '\n'.code) break
            if (b != '\r'.code) line.write(b)
        }
        return line.toString(Charsets.US_ASCII.name())
    }

    override fun close() {
        socket.close()
        executor.shutdownNow()
    }
}

/**
 * Writes a value parsed by [MiniJson] back as JSON in one canonical form: object keys sorted,
 * two-space indentation, arrays of plain values on one line, integral numbers without a fraction.
 * Two documents with the same content always give the same text, whichever JSON library (and so
 * key order) produced them; the golden file is compared in this form.
 */
internal object CanonicalJson {
    fun write(value: Any?): String = StringBuilder().also { write(it, value, 0) }.append('\n').toString()

    private fun write(out: StringBuilder, value: Any?, depth: Int) {
        when (value) {
            null -> out.append("null")
            is Boolean -> out.append(value)
            is Double -> out.append(number(value))
            is Number -> out.append(number(value.toDouble()))
            is String -> out.append(JsonText.quote(value))
            is Map<*, *> -> {
                if (value.isEmpty()) return run { out.append("{}") }
                out.append("{\n")
                val keys = value.keys.map { it as String }.sorted()
                keys.forEachIndexed { index, key ->
                    indent(out, depth + 1)
                    out.append(JsonText.quote(key)).append(": ")
                    write(out, value[key], depth + 1)
                    if (index < keys.size - 1) out.append(',')
                    out.append('\n')
                }
                indent(out, depth)
                out.append('}')
            }
            is List<*> -> {
                if (value.isEmpty()) return run { out.append("[]") }
                if (value.none { it is Map<*, *> || it is List<*> }) {
                    out.append('[')
                    value.forEachIndexed { index, item ->
                        if (index > 0) out.append(", ")
                        write(out, item, depth)
                    }
                    out.append(']')
                    return
                }
                out.append("[\n")
                value.forEachIndexed { index, item ->
                    indent(out, depth + 1)
                    write(out, item, depth + 1)
                    if (index < value.size - 1) out.append(',')
                    out.append('\n')
                }
                indent(out, depth)
                out.append(']')
            }
            else -> error("not a JSON value: ${value.javaClass}")
        }
    }

    private fun number(value: Double): String {
        require(value.isFinite()) { "JSON numbers are finite" }
        return if (value == Math.rint(value) && kotlin.math.abs(value) < 1e15) value.toLong().toString() else value.toString()
    }

    private fun indent(out: StringBuilder, depth: Int) {
        repeat(depth) { out.append("  ") }
    }
}

/** Finds a file of the repository (e.g. a shared fixture) by walking up from Gradle's working directory. */
internal fun repoFile(relative: String): java.io.File {
    var dir: java.io.File? = java.io.File("").absoluteFile
    while (dir != null) {
        if (java.io.File(dir, "android/settings.gradle.kts").isFile) return java.io.File(dir, relative)
        dir = dir.parentFile
    }
    error("repository root (with android/settings.gradle.kts) not found above ${java.io.File("").absolutePath}")
}
