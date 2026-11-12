package tw.skyhong.infovore.health.screen

import android.accessibilityservice.AccessibilityService
import android.app.KeyguardManager
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.graphics.Bitmap
import android.net.ConnectivityManager
import android.net.NetworkCapabilities
import android.os.PowerManager
import android.os.SystemClock
import android.util.Base64
import android.util.Log
import android.view.Display
import android.view.accessibility.AccessibilityEvent
import android.view.accessibility.AccessibilityNodeInfo
import android.view.accessibility.AccessibilityWindowInfo
import androidx.core.graphics.get
import androidx.core.graphics.scale
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeoutOrNull
import java.io.ByteArrayOutputStream
import java.util.concurrent.ExecutorService
import java.util.concurrent.Executors
import kotlin.coroutines.resume
import kotlin.math.max
import kotlin.math.roundToInt

/**
 * Passive phone Dayflow recorder. While recording is enabled, not paused, and the screen is on and
 * unlocked, it records the foreground app, its visible text and (when useful) a small screenshot
 * every minute and on app switches, queues them on disk, and uploads them to the user's infovore.
 */
class ScreenActivityService : AccessibilityService() {
    private var scope: CoroutineScope? = null
    private var captureJob: Job? = null
    private var uploadJob: Job? = null
    private var screenshotExecutor: ExecutorService? = null
    private var receiverRegistered = false
    private val triggers = Channel<Unit>(Channel.CONFLATED)
    private val imagePolicy = ImageAttachPolicy(IMAGE_REFRESH_MS)
    private val labelCache = HashMap<String, String>()
    private var lastCaptureMs = 0L
    private var lastCapturedPackage: String? = null
    private var lastEventPackage: String? = null
    private var lastScreenshotElapsed = 0L

    private lateinit var settings: ScreenSettings
    private lateinit var queue: ObservationQueue

    private val screenReceiver = object : BroadcastReceiver() {
        override fun onReceive(context: Context, intent: Intent) {
            when (intent.action) {
                Intent.ACTION_SCREEN_OFF -> stopCapture()
                Intent.ACTION_SCREEN_ON, Intent.ACTION_USER_PRESENT -> startCaptureIfReady()
            }
        }
    }

    override fun onServiceConnected() {
        super.onServiceConnected()
        settings = ScreenSettings(this)
        queue = ObservationQueue.get(this)
        screenshotExecutor = Executors.newSingleThreadExecutor()
        val serviceScope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)
        scope = serviceScope
        registerReceiver(
            screenReceiver,
            IntentFilter().apply {
                addAction(Intent.ACTION_SCREEN_OFF)
                addAction(Intent.ACTION_SCREEN_ON)
                addAction(Intent.ACTION_USER_PRESENT)
            },
            RECEIVER_NOT_EXPORTED,
        )
        receiverRegistered = true
        uploadJob = serviceScope.launch {
            while (currentCoroutineContext().isActive) {
                delay(UPLOAD_INTERVAL_MS)
                if (hasNetwork()) {
                    runCatching { ScreenUploader.uploadPending(this@ScreenActivityService, automatic = true) }
                        .onFailure { Log.w(TAG, "upload failed", it) }
                }
            }
        }
        startCaptureIfReady()
    }

    override fun onAccessibilityEvent(event: AccessibilityEvent?) {
        if (event == null || scope == null) return
        if (event.eventType == AccessibilityEvent.TYPE_WINDOW_STATE_CHANGED) {
            val pkg = event.packageName?.toString() ?: return
            if (pkg == lastEventPackage) return
            lastEventPackage = pkg
        }
        // Either a window-state change in a new package or a window-set change: the capture
        // loop compares the real foreground package and debounces before recording anything.
        if (captureJob?.isActive != true) startCaptureIfReady()
        triggers.trySend(Unit)
    }

    override fun onInterrupt() {
        stopCapture()
    }

    override fun onUnbind(intent: Intent?): Boolean {
        teardown()
        return super.onUnbind(intent)
    }

    override fun onDestroy() {
        teardown()
        super.onDestroy()
    }

    private fun teardown() {
        stopCapture()
        uploadJob?.cancel()
        uploadJob = null
        scope?.cancel()
        scope = null
        if (receiverRegistered) {
            runCatching { unregisterReceiver(screenReceiver) }
            receiverRegistered = false
        }
        screenshotExecutor?.shutdownNow()
        screenshotExecutor = null
    }

    private fun startCaptureIfReady() {
        val serviceScope = scope ?: return
        if (captureJob?.isActive == true || !screenUsable()) return
        captureJob = serviceScope.launch { captureLoop() }
    }

    private fun stopCapture() {
        captureJob?.cancel()
        captureJob = null
    }

    private fun screenUsable(): Boolean {
        val power = getSystemService(PowerManager::class.java)
        val keyguard = getSystemService(KeyguardManager::class.java)
        return power.isInteractive && !keyguard.isKeyguardLocked
    }

    private suspend fun captureLoop() {
        var triggered = false
        while (currentCoroutineContext().isActive) {
            val wait = MIN_CAPTURE_GAP_MS - (System.currentTimeMillis() - lastCaptureMs)
            if (wait > 0) delay(wait)
            if (!screenUsable()) return
            if (settings.isRecording()) {
                val foreground = foreground()
                // Timer ticks always record; triggers only record when the foreground app changed.
                if (foreground != null && (!triggered || foreground.packageName != lastCapturedPackage)) {
                    runCatching { capture(foreground) }.onFailure { Log.w(TAG, "capture failed", it) }
                }
            }
            triggered = withTimeoutOrNull(CAPTURE_INTERVAL_MS) { triggers.receive() } != null
        }
    }

    private class Foreground(val packageName: String, val root: AccessibilityNodeInfo)

    private fun foreground(): Foreground? {
        val windows = runCatching { windowsOnAllDisplays.get(Display.DEFAULT_DISPLAY) }.getOrNull()
            .orEmpty()
            .filter { it.type == AccessibilityWindowInfo.TYPE_APPLICATION }
        val window = windows.firstOrNull { it.isFocused } ?: windows.firstOrNull { it.isActive } ?: windows.firstOrNull()
        val root = window?.root ?: rootInActiveWindow ?: return null
        val pkg = root.packageName?.toString()?.takeIf { it.isNotBlank() } ?: return null
        return Foreground(pkg, root)
    }

    private suspend fun capture(foreground: Foreground) {
        val pkg = foreground.packageName
        if (pkg == packageName) return
        if (pkg == SYSTEM_UI && getSystemService(KeyguardManager::class.java).isKeyguardLocked) return
        val now = System.currentTimeMillis()
        lastCaptureMs = now
        lastCapturedPackage = pkg
        settings.lastCaptureAt = now
        val label = appLabel(pkg)

        val observation = if (Exclusions.isExcluded(pkg, settings.exclusions)) {
            Observation(capturedAtMs = now, packageName = pkg, appLabel = label, text = "", blocked = true)
        } else {
            val text = withContext(Dispatchers.Default) { extractText(foreground.root) }
            when (val shot = takeShot()) {
                Shot.Secure -> Observation(capturedAtMs = now, packageName = pkg, appLabel = label, text = "", blocked = true)
                is Shot.Failed -> {
                    Log.w(TAG, "screenshot failed: ${shot.code}")
                    Observation(capturedAtMs = now, packageName = pkg, appLabel = label, text = text, blocked = false)
                }
                is Shot.Ok -> withContext(Dispatchers.Default) {
                    val bitmap = shot.bitmap
                    try {
                        // Android 14+ reports secure windows explicitly (handled above). A black
                        // frame is usually a dark screen or a loading video: keep its text but
                        // don't spend an image on it.
                        if (isMostlyBlack(bitmap)) {
                            Observation(capturedAtMs = now, packageName = pkg, appLabel = label, text = text, blocked = false)
                        } else {
                            val image = if (imagePolicy.shouldAttach(pkg, text, now)) {
                                encodeJpeg(bitmap)?.also { imagePolicy.recordAttached(pkg, text, now) }
                            } else {
                                null
                            }
                            Observation(capturedAtMs = now, packageName = pkg, appLabel = label, text = text, blocked = false, image = image)
                        }
                    } finally {
                        bitmap.recycle()
                    }
                }
            }
        }
        // Filed under the destination saved right now; it is only ever uploaded there.
        withContext(Dispatchers.IO) { queue.enqueue(ScreenUploader.currentDestination(this@ScreenActivityService), observation) }
    }

    private fun appLabel(pkg: String): String = labelCache.getOrPut(pkg) {
        runCatching {
            packageManager.getApplicationLabel(packageManager.getApplicationInfo(pkg, 0)).toString()
        }.getOrDefault(pkg).take(Observation.MAX_NAME_CHARS)
    }

    /** Visible text and content descriptions, skipping password fields; bounded depth and node count. */
    private fun extractText(root: AccessibilityNodeInfo): String {
        val lines = ArrayList<CharSequence>()
        val stack = java.util.ArrayDeque<Pair<AccessibilityNodeInfo, Int>>()
        stack.push(root to 0)
        var visited = 0
        var chars = 0
        while (stack.isNotEmpty() && visited < MAX_NODES && chars < ScreenText.MAX_CHARS * 2) {
            val (node, depth) = stack.pop()
            visited++
            if (!node.isVisibleToUser) continue
            if (!node.isPassword) {
                val text = node.text
                val description = node.contentDescription
                if (!text.isNullOrBlank()) { lines += text; chars += text.length }
                if (!description.isNullOrBlank() && description.toString() != text?.toString()) {
                    lines += description
                    chars += description.length
                }
            }
            if (depth >= MAX_DEPTH) continue
            // Push in reverse so children are visited in screen order.
            for (index in node.childCount - 1 downTo 0) {
                if (visited + stack.size >= MAX_NODES) break
                node.getChild(index)?.let { stack.push(it to depth + 1) }
            }
        }
        return ScreenText.normalize(lines)
    }

    private sealed interface Shot {
        class Ok(val bitmap: Bitmap) : Shot
        data object Secure : Shot
        data class Failed(val code: Int) : Shot
    }

    private suspend fun takeShot(): Shot {
        val sinceLast = SystemClock.elapsedRealtime() - lastScreenshotElapsed
        if (sinceLast < SCREENSHOT_GAP_MS) delay(SCREENSHOT_GAP_MS - sinceLast)
        val first = screenshotOnce()
        if (first !is Shot.Failed || first.code != ERROR_TAKE_SCREENSHOT_INTERVAL_TIME_SHORT) return first
        delay(SCREENSHOT_GAP_MS)
        return screenshotOnce()
    }

    private suspend fun screenshotOnce(): Shot = suspendCancellableCoroutine { cont ->
        val executor = screenshotExecutor
        if (executor == null) {
            cont.resume(Shot.Failed(ERROR_TAKE_SCREENSHOT_INTERNAL_ERROR))
            return@suspendCancellableCoroutine
        }
        lastScreenshotElapsed = SystemClock.elapsedRealtime()
        takeScreenshot(Display.DEFAULT_DISPLAY, executor, object : TakeScreenshotCallback {
            override fun onSuccess(result: ScreenshotResult) {
                val bitmap = runCatching {
                    result.hardwareBuffer.use { buffer ->
                        val hardware = Bitmap.wrapHardwareBuffer(buffer, result.colorSpace) ?: return@use null
                        try {
                            val software = hardware.copy(Bitmap.Config.ARGB_8888, false)
                            scaledToLongEdge(software, MAX_IMAGE_EDGE).also { if (it !== software) software.recycle() }
                        } finally {
                            hardware.recycle()
                        }
                    }
                }.getOrNull()
                val shot = bitmap?.let(Shot::Ok) ?: Shot.Failed(ERROR_TAKE_SCREENSHOT_INTERNAL_ERROR)
                if (cont.isActive) cont.resume(shot) else bitmap?.recycle()
            }

            override fun onFailure(errorCode: Int) {
                val shot = if (errorCode == ERROR_TAKE_SCREENSHOT_SECURE_WINDOW) Shot.Secure else Shot.Failed(errorCode)
                if (cont.isActive) cont.resume(shot)
            }
        })
    }

    /** [source] itself when its long edge is within [maxEdge], otherwise a scaled copy (caller recycles). */
    private fun scaledToLongEdge(source: Bitmap, maxEdge: Int): Bitmap {
        val longEdge = max(source.width, source.height)
        if (longEdge <= maxEdge) return source
        val ratio = maxEdge.toFloat() / longEdge
        return source.scale(
            max(1, (source.width * ratio).roundToInt()),
            max(1, (source.height * ratio).roundToInt()),
        )
    }

    private fun isMostlyBlack(bitmap: Bitmap): Boolean {
        val stepX = max(1, bitmap.width / BLACK_SAMPLE_SIDE)
        val stepY = max(1, bitmap.height / BLACK_SAMPLE_SIDE)
        val samples = ArrayList<Int>()
        for (y in 0 until bitmap.height step stepY) for (x in 0 until bitmap.width step stepX) {
            samples += bitmap[x, y]
        }
        return Frames.isMostlyBlack(samples.toIntArray())
    }

    /** JPEG → base64 within the server's size limit, trying smaller encodings if needed. */
    private fun encodeJpeg(bitmap: Bitmap): String? {
        for ((edge, quality) in ENCODINGS) {
            val sized = scaledToLongEdge(bitmap, edge)
            try {
                val bytes = ByteArrayOutputStream().use { out ->
                    sized.compress(Bitmap.CompressFormat.JPEG, quality, out)
                    out.toByteArray()
                }
                val encoded = Base64.encodeToString(bytes, Base64.NO_WRAP)
                if (encoded.length <= MAX_IMAGE_BASE64_CHARS) return encoded
            } finally {
                if (sized !== bitmap) sized.recycle()
            }
        }
        return null
    }

    private fun hasNetwork(): Boolean {
        val connectivity = getSystemService(ConnectivityManager::class.java) ?: return false
        val capabilities = connectivity.getNetworkCapabilities(connectivity.activeNetwork) ?: return false
        return capabilities.hasCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET)
    }

    private companion object {
        const val TAG = "InfovoreScreen"
        const val SYSTEM_UI = "com.android.systemui"
        const val CAPTURE_INTERVAL_MS = 60_000L
        const val MIN_CAPTURE_GAP_MS = 5_000L
        const val UPLOAD_INTERVAL_MS = 5 * 60_000L
        const val IMAGE_REFRESH_MS = 5 * 60_000L
        const val SCREENSHOT_GAP_MS = 1_100L
        const val MAX_DEPTH = 40
        const val MAX_NODES = 1500
        const val MAX_IMAGE_EDGE = 720
        const val MAX_IMAGE_BASE64_CHARS = 400_000
        const val BLACK_SAMPLE_SIDE = 48
        val ENCODINGS = listOf(720 to 60, 720 to 45, 540 to 45, 400 to 40)
    }
}
