package tw.skyhong.infovore.health.location

import android.content.Context
import android.net.Uri
import android.provider.OpenableColumns
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.launch
import tw.skyhong.infovore.health.InfovoreApi
import tw.skyhong.infovore.health.ui.ErrorText
import java.io.FilterInputStream
import java.io.InputStream
import java.io.InputStreamReader
import java.nio.charset.StandardCharsets
import java.text.NumberFormat
import java.time.Instant
import kotlin.coroutines.coroutineContext

/**
 * Imports a Google Maps Timeline export the user picked: parses it as a stream
 * ([TimelineParser]) and uploads it in batches while reading, so memory stays flat however large
 * the file is. Runs in a process-wide scope: leaving the screen or rotating does not stop it.
 * Importing the same file again is harmless; the server keeps one copy of each record.
 */
object TimelineImporter {
    data class State(
        val running: Boolean = false,
        /** 0–100 while the file size is known, else null. */
        val percent: Int? = null,
        val sent: Int = 0,
        val message: String? = null,
        val failed: Boolean = false,
    )

    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    private val _state = MutableStateFlow(State())
    val state: StateFlow<State> = _state
    private var job: Job? = null

    /** Starts importing [uri]; false when an import is already running. */
    @Synchronized
    fun start(context: Context, uri: Uri): Boolean {
        if (job?.isActive == true) return false
        val app = context.applicationContext
        _state.value = State(running = true, percent = 0, message = "正在讀取時間軸…")
        job = scope.launch { run(app, uri) }
        return true
    }

    @Synchronized
    fun cancel() {
        job?.cancel()
    }

    private suspend fun run(context: Context, uri: Uri) {
        val settings = LocationSettings(context)
        val number = NumberFormat.getIntegerInstance()
        val outcome = try {
            val counts = import(context, uri)
            val text = "匯入完成：${number.format(counts.visits)} 次停留、${number.format(counts.trips)} 段移動、" +
                "${number.format(counts.points)} 個定位點" + if (counts.skipped > 0) "（略過 ${number.format(counts.skipped)} 筆無法辨識的紀錄）" else ""
            State(message = text, sent = counts.total)
        } catch (cancelled: CancellationException) {
            State(message = "已取消匯入；已上傳的部分會保留，重新匯入同一個檔案不會重複。", sent = _state.value.sent)
        } catch (error: Exception) {
            val reason = if (error is IllegalArgumentException) error.message ?: "無法讀取這個檔案。" else ErrorText.describe(error)
            State(message = "匯入失敗：$reason 已上傳的部分會保留，重新匯入同一個檔案不會重複。", sent = _state.value.sent, failed = true)
        }
        settings.lastImportStatus = "${Instant.now()}：${outcome.message}"
        _state.value = outcome
        LocationTracking.notifyChanged()
    }

    private suspend fun import(context: Context, uri: Uri): TimelineParser.Counts {
        val (api, settings) = LocationUploader.api(context)
        val size = context.contentResolver.query(uri, arrayOf(OpenableColumns.SIZE), null, null, null)?.use { cursor ->
            if (cursor.moveToFirst() && !cursor.isNull(0)) cursor.getLong(0) else null
        }?.takeIf { it > 0 }
        val input = context.contentResolver.openInputStream(uri) ?: throw IllegalArgumentException("無法開啟這個檔案。")
        val counting = CountingInputStream(input)
        val uploader = BatchingSink(api, settings.token, settings.deviceId)
        val parser = TimelineParser(uploader)
        val coroutine = coroutineContext
        uploader.onBatch = { sent ->
            // Cancelling stops between batches.
            coroutine.ensureActive()
            _state.value = _state.value.copy(
                sent = sent,
                percent = size?.let { ((counting.count * 100) / it).toInt().coerceIn(0, 99) },
                message = "正在上傳時間軸… 已送出 ${NumberFormat.getIntegerInstance().format(sent)} 筆",
            )
        }
        InputStreamReader(counting, StandardCharsets.UTF_8).use { reader -> parser.parse(reader) }
        uploader.flush()
        if (parser.counts.total == 0) throw IllegalArgumentException("檔案裡沒有可匯入的位置紀錄。")
        return parser.counts
    }

    /** Collects parsed records and uploads a batch whenever one is full. */
    private class BatchingSink(private val api: InfovoreApi, private val token: String, private val deviceId: String) : TimelineParser.Sink {
        private val points = ArrayList<LocationFix>()
        private val visits = ArrayList<TimelineVisit>()
        private val trips = ArrayList<TimelineTrip>()
        private var sent = 0
        var onBatch: (Int) -> Unit = {}

        override fun point(fix: LocationFix) {
            points += fix
            if (points.size >= LocationJson.MAX_POINTS_PER_BATCH) flush()
        }

        override fun visit(visit: TimelineVisit) {
            visits += visit
            if (visits.size + trips.size >= LocationJson.MAX_SEGMENTS_PER_BATCH) flush()
        }

        override fun trip(trip: TimelineTrip) {
            trips += trip
            if (visits.size + trips.size >= LocationJson.MAX_SEGMENTS_PER_BATCH) flush()
        }

        fun flush() {
            if (points.isEmpty() && visits.isEmpty() && trips.isEmpty()) return
            LocationUploader.send(api, token, LocationJson.batch(deviceId, LocationJson.SOURCE_TIMELINE, points, visits, trips))
            sent += points.size + visits.size + trips.size
            points.clear()
            visits.clear()
            trips.clear()
            onBatch(sent)
        }
    }

    private class CountingInputStream(input: InputStream) : FilterInputStream(input) {
        @Volatile
        var count = 0L
            private set

        override fun read(): Int = super.read().also { if (it >= 0) count++ }

        override fun read(b: ByteArray, off: Int, len: Int): Int = super.read(b, off, len).also { if (it > 0) count += it }

        override fun skip(n: Long): Long = super.skip(n).also { count += it }
    }
}
