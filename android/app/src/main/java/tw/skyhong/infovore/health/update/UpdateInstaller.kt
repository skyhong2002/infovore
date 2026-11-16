package tw.skyhong.infovore.health.update

import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.pm.PackageInstaller
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.launch
import java.io.IOException
import java.net.HttpURLConnection
import java.net.URL
import java.security.MessageDigest
import kotlin.coroutines.coroutineContext

/**
 * Downloads a release straight into a [PackageInstaller] session (checking GitHub's SHA-256 on
 * the way) and commits it. Android asks the user to confirm the first self-update; once
 * Infovore installed itself it may update without asking ([PackageInstaller.SessionParams.setRequireUserAction]).
 * Runs in a process-wide scope so rotating or switching screens does not stop a download.
 */
object UpdateInstaller {
    sealed interface State {
        data object Idle : State
        /** [percent] is null while the size is unknown. */
        data class Downloading(val release: AppRelease, val percent: Int?) : State
        /** Handed to Android: its confirmation (or the install itself) is showing. */
        data class Installing(val release: AppRelease) : State
        data class Failed(val message: String) : State
    }

    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    private val _state = MutableStateFlow<State>(State.Idle)
    val state: StateFlow<State> = _state
    private var job: Job? = null

    fun canInstall(context: Context): Boolean = context.packageManager.canRequestPackageInstalls()

    @Synchronized
    fun start(context: Context, release: AppRelease): Boolean {
        if (job?.isActive == true) return false
        val app = context.applicationContext
        _state.value = State.Downloading(release, 0)
        job = scope.launch {
            _state.value = try {
                install(app, release)
                State.Installing(release)
            } catch (cancelled: CancellationException) {
                State.Idle
            } catch (error: Exception) {
                State.Failed(error.message ?: error.javaClass.simpleName)
            }
        }
        return true
    }

    @Synchronized
    fun cancel() {
        job?.cancel()
    }

    fun reset() {
        _state.value = State.Idle
    }

    /** Called by [UpdateInstallReceiver] when Android reports a failed install. */
    internal fun failed(message: String) {
        _state.value = State.Failed(message)
    }

    private suspend fun install(context: Context, release: AppRelease) {
        val installer = context.packageManager.packageInstaller
        val params = PackageInstaller.SessionParams(PackageInstaller.SessionParams.MODE_FULL_INSTALL).apply {
            setAppPackageName(context.packageName)
            if (release.sizeBytes > 0) setSize(release.sizeBytes)
            setRequireUserAction(PackageInstaller.SessionParams.USER_ACTION_NOT_REQUIRED)
        }
        val sessionId = installer.createSession(params)
        val session = installer.openSession(sessionId)
        var committed = false
        try {
            download(release, session)
            val callback = PendingIntent.getBroadcast(
                context, sessionId,
                Intent(context, UpdateInstallReceiver::class.java),
                // Mutable: Android adds the install status to it.
                PendingIntent.FLAG_MUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
            )
            session.commit(callback.intentSender)
            committed = true
        } finally {
            if (!committed) session.abandon()
            session.close()
        }
    }

    private suspend fun download(release: AppRelease, session: PackageInstaller.Session) {
        val connection = URL(release.apkUrl).openConnection() as HttpURLConnection
        try {
            connection.connectTimeout = 15_000
            connection.readTimeout = 30_000
            connection.setRequestProperty("User-Agent", "infovore-android")
            val status = connection.responseCode
            if (status !in 200..299) throw IOException("下載失敗（HTTP $status），請稍後再試。")
            val total = connection.contentLengthLong.takeIf { it > 0 } ?: release.sizeBytes.takeIf { it > 0 }
            val digest = MessageDigest.getInstance("SHA-256")
            var written = 0L
            val context = coroutineContext
            connection.inputStream.use { input ->
                session.openWrite("base.apk", 0, total ?: -1).use { output ->
                    val buffer = ByteArray(64 * 1024)
                    while (true) {
                        context.ensureActive()
                        val read = input.read(buffer)
                        if (read < 0) break
                        output.write(buffer, 0, read)
                        digest.update(buffer, 0, read)
                        written += read
                        _state.value = State.Downloading(release, total?.let { ((written * 100) / it).toInt().coerceIn(0, 100) })
                    }
                    session.fsync(output)
                }
            }
            val actual = digest.digest().joinToString("") { "%02x".format(it) }
            if (release.sha256 != null && actual != release.sha256) {
                throw IOException("下載的檔案與 GitHub 公布的 SHA-256 不符，已取消安裝。")
            }
        } finally {
            connection.disconnect()
        }
    }
}

/** Android's answer to a committed update: shows its confirmation, or reports why the install failed. */
class UpdateInstallReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        // Android always reports a status; anything else did not come from the installer.
        if (!intent.hasExtra(PackageInstaller.EXTRA_STATUS)) return
        when (val status = intent.getIntExtra(PackageInstaller.EXTRA_STATUS, PackageInstaller.STATUS_FAILURE)) {
            PackageInstaller.STATUS_PENDING_USER_ACTION -> {
                val confirm = intent.getParcelableExtra(Intent.EXTRA_INTENT, Intent::class.java) ?: return
                context.startActivity(confirm.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
            }
            PackageInstaller.STATUS_SUCCESS -> Unit // Android restarts the updated app's process.
            else -> UpdateInstaller.failed(describe(status, intent.getStringExtra(PackageInstaller.EXTRA_STATUS_MESSAGE)))
        }
    }

    private fun describe(status: Int, message: String?): String = when (status) {
        PackageInstaller.STATUS_FAILURE_ABORTED -> "已取消更新。"
        PackageInstaller.STATUS_FAILURE_CONFLICT, PackageInstaller.STATUS_FAILURE_INCOMPATIBLE ->
            "無法安裝這個版本（簽章或版本不相容）。${message.orEmpty()}"
        PackageInstaller.STATUS_FAILURE_STORAGE -> "手機空間不足，無法安裝更新。"
        PackageInstaller.STATUS_FAILURE_BLOCKED -> "安裝被系統封鎖。${message.orEmpty()}"
        else -> "更新失敗：${message ?: "未知原因"}"
    }
}
