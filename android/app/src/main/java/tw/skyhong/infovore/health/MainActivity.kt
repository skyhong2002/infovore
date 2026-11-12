@file:Suppress("SetTextI18n")

package tw.skyhong.infovore.health

import android.content.ComponentName
import android.content.Intent
import android.os.Bundle
import android.provider.Settings
import android.text.InputType
import android.view.View
import android.view.WindowManager
import android.widget.Button
import android.widget.EditText
import android.widget.ImageView
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView
import androidx.appcompat.app.AppCompatActivity
import androidx.appcompat.widget.SwitchCompat
import androidx.health.connect.client.HealthConnectClient
import androidx.health.connect.client.HealthConnectFeatures
import androidx.health.connect.client.permission.HealthPermission
import androidx.lifecycle.lifecycleScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import tw.skyhong.infovore.health.screen.Exclusions
import tw.skyhong.infovore.health.screen.ObservationQueue
import tw.skyhong.infovore.health.screen.ScreenActivityService
import tw.skyhong.infovore.health.screen.ScreenSettings
import tw.skyhong.infovore.health.screen.ScreenUploader
import java.time.Instant

class MainActivity : AppCompatActivity() {
    private lateinit var settings: SecureSettings
    private lateinit var endpointInput: EditText
    private lateinit var tokenInput: EditText
    private lateinit var historyDaysInput: EditText
    private lateinit var permissionStatus: TextView
    private lateinit var syncStatus: TextView
    private lateinit var syncButton: Button
    private lateinit var sleepButton: Button
    private lateinit var sleepStatus: TextView
    private var syncing = false

    private lateinit var screenSettings: ScreenSettings
    private lateinit var phoneTokenInput: EditText
    private lateinit var recordingSwitch: SwitchCompat
    private lateinit var accessibilityStatus: TextView
    private lateinit var exclusionsInput: EditText
    private lateinit var pauseButton: Button
    private lateinit var screenStatus: TextView
    private lateinit var screenResult: TextView
    private lateinit var uploadButton: Button
    private lateinit var testButton: Button

    private val permissionLauncher = registerForActivityResult(HealthConnectSync.permissionContract()) {
        lifecycleScope.launch { refreshPermissionStatus() }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        settings = SecureSettings(this)
        screenSettings = ScreenSettings(this)
        setContentView(buildContent())
        lifecycleScope.launch { refreshPermissionStatus() }
    }

    override fun onResume() {
        super.onResume()
        if (::permissionStatus.isInitialized) lifecycleScope.launch { refreshPermissionStatus() }
        if (::screenStatus.isInitialized) refreshScreenStatus()
    }

    private fun buildContent(): View {
        val root = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(dp(24), dp(32), dp(24), dp(32))
        }
        root.addView(ImageView(this).apply {
            setImageResource(R.drawable.infovore_logo)
            contentDescription = "infovore"
        }, LinearLayout.LayoutParams(dp(64), dp(64)))
        root.addView(TextView(this).apply {
            text = "Infovore 0.2.0"
            textSize = 28f
        })
        root.addView(TextView(this).apply {
            text = "將 Android Health Connect（包括 Garmin Connect 寫入的資料）私密同步至 Infovore。"
            textSize = 16f
            setPadding(0, dp(8), 0, dp(24))
        })

        root.addView(label("Infovore ingest endpoint"))
        endpointInput = EditText(this).apply {
            setText(settings.endpoint)
            inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_URI
            isSingleLine = true
        }
        root.addView(endpointInput, matchWrap())

        root.addView(label("HEALTH_CONNECT_TOKEN（至少 32 字元）"))
        tokenInput = EditText(this).apply {
            setText(settings.token)
            inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_PASSWORD
            isSingleLine = true
        }
        root.addView(tokenInput, matchWrap())

        root.addView(label("初始同步範圍（最近幾天，1–${SecureSettings.MAX_HISTORY_DAYS}）"))
        historyDaysInput = EditText(this).apply {
            setText(settings.historyDays.toString())
            inputType = InputType.TYPE_CLASS_NUMBER
            isSingleLine = true
        }
        root.addView(historyDaysInput, matchWrap())

        root.addView(Button(this).apply {
            text = "儲存連線設定"
            setOnClickListener {
                saveInputs()
                syncStatus.text = "設定已安全儲存；token 由 Android Keystore 加密。初始同步將讀取最近 ${settings.historyDays} 天。"
            }
        }, matchWrap(dp(12)))

        permissionStatus = TextView(this).apply {
            text = "正在檢查 Health Connect…"
            setPadding(0, dp(20), 0, dp(8))
        }
        root.addView(permissionStatus)
        root.addView(Button(this).apply {
            text = "授權 Health Connect"
            setOnClickListener {
                lifecycleScope.launch {
                    val client = HealthConnectClient.getOrCreate(this@MainActivity)
                    permissionLauncher.launch(permissionsToRequest(client))
                }
            }
        }, matchWrap())

        sleepButton = Button(this).apply {
            text = "只同步睡眠（優先）"
            setOnClickListener { runManualSync(sleepOnly = true) }
        }
        root.addView(sleepButton, matchWrap(dp(12)))
        sleepStatus = TextView(this).apply {
            text = settings.lastSleepStatus
            setPadding(0, dp(12), 0, dp(12))
            setTextIsSelectable(true)
        }
        root.addView(sleepStatus)
        syncButton = Button(this).apply {
            text = "立即同步"
            setOnClickListener { runManualSync() }
        }
        root.addView(syncButton, matchWrap(dp(12)))

        syncStatus = TextView(this).apply {
            text = settings.lastStatus
            setPadding(0, dp(16), 0, dp(16))
            setTextIsSelectable(true)
        }
        root.addView(syncStatus)
        root.addView(TextView(this).apply {
            text = "背景同步每 6 小時執行一次。請保持 Tailscale 連線，並在 Garmin Connect → 設定 → Health Connect 開啟資料分享。第一次同步與睡眠同步只讀取上方設定的天數（預設 ${SecureSettings.DEFAULT_HISTORY_DAYS} 天）；未授權歷史資料時最多 30 天。之後的同步只處理增量變更。"
            textSize = 14f
        })

        buildScreenSection(root)

        return ScrollView(this).apply { addView(root) }
    }

    private fun buildScreenSection(root: LinearLayout) {
        root.addView(TextView(this).apply {
            text = "手機 Dayflow（畫面活動）"
            textSize = 22f
            setPadding(0, dp(32), 0, dp(8))
        })
        root.addView(TextView(this).apply {
            text = "以無障礙服務在螢幕開啟且已解鎖時，約每分鐘及切換 App 時記錄前景 App、畫面文字與小縮圖，" +
                "上傳到上方 endpoint 的 infovore，彙整成時間軸。手機端不呼叫任何 AI。"
            textSize = 14f
        })
        root.addView(TextView(this).apply {
            text = "隱私：畫面文字與縮圖會上傳到你的 infovore 伺服器，由伺服器用 AI 摘要後刪除原始資料；" +
                "密碼欄位、安全畫面與排除的 App 不會擷取。"
            textSize = 14f
            setPadding(0, dp(8), 0, 0)
        })

        root.addView(label("DAYFLOW_PHONE_TOKEN（至少 32 字元，與健康同步 token 不同）"))
        phoneTokenInput = EditText(this).apply {
            setText(screenSettings.token)
            inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_PASSWORD
            isSingleLine = true
        }
        root.addView(phoneTokenInput, matchWrap())

        root.addView(label("排除的 App 套件（以逗號或換行分隔；密碼管理器等已預設排除）"))
        exclusionsInput = EditText(this).apply {
            setText(screenSettings.exclusionsText)
            inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_FLAG_MULTI_LINE or
                InputType.TYPE_TEXT_FLAG_NO_SUGGESTIONS
            isSingleLine = false
            minLines = 2
            hint = "com.example.bank"
        }
        root.addView(exclusionsInput, matchWrap())

        root.addView(Button(this).apply {
            text = "儲存"
            setOnClickListener {
                saveScreenInputs()
                screenResult.text = "手機 Dayflow 設定已儲存；token 由 Android Keystore 加密。" +
                    "排除 ${screenSettings.exclusions.size} 個自訂套件（另有 ${Exclusions.DEFAULT_PACKAGES.size} 個預設）。"
            }
        }, matchWrap(dp(8)))

        recordingSwitch = SwitchCompat(this).apply {
            text = "啟用記錄"
            isChecked = screenSettings.enabled
            setOnCheckedChangeListener { _, checked ->
                screenSettings.enabled = checked
                refreshScreenStatus()
            }
        }
        root.addView(recordingSwitch, matchWrap(dp(12)))

        accessibilityStatus = TextView(this).apply { setPadding(0, dp(12), 0, dp(4)) }
        root.addView(accessibilityStatus)
        root.addView(Button(this).apply {
            text = "開啟無障礙設定"
            setOnClickListener { startActivity(Intent(Settings.ACTION_ACCESSIBILITY_SETTINGS)) }
        }, matchWrap())
        root.addView(TextView(this).apply {
            text = "側載安裝的 App 需先到「應用程式資訊 → ⋮ → 允許受限制的設定」才能開啟無障礙服務。"
            textSize = 13f
        })

        pauseButton = Button(this).apply {
            setOnClickListener {
                screenSettings.pausedUntil = if (screenSettings.isPaused()) 0L else System.currentTimeMillis() + PAUSE_MS
                refreshScreenStatus()
            }
        }
        root.addView(pauseButton, matchWrap(dp(12)))

        screenStatus = TextView(this).apply {
            setPadding(0, dp(12), 0, dp(4))
            setTextIsSelectable(true)
        }
        root.addView(screenStatus)

        uploadButton = Button(this).apply {
            text = "立即上傳"
            setOnClickListener { runScreenUpload() }
        }
        root.addView(uploadButton, matchWrap(dp(8)))
        testButton = Button(this).apply {
            text = "測試連線"
            setOnClickListener { testScreenConnection() }
        }
        root.addView(testButton, matchWrap())

        screenResult = TextView(this).apply {
            setPadding(0, dp(12), 0, dp(16))
            setTextIsSelectable(true)
        }
        root.addView(screenResult)
        refreshScreenStatus()
    }

    private fun saveScreenInputs() {
        settings.endpoint = endpointInput.text.toString()
        screenSettings.token = phoneTokenInput.text.toString()
        screenSettings.exclusionsText = exclusionsInput.text.toString()
    }

    private fun runScreenUpload() {
        saveScreenInputs()
        uploadButton.isEnabled = false
        screenResult.text = "上傳中…"
        lifecycleScope.launch {
            try {
                val outcome = ScreenUploader.uploadPending(this@MainActivity)
                screenResult.text = outcome.error?.let { "上傳失敗：$it" }
                    ?: "已送出 ${outcome.sent} 筆（新增 ${outcome.accepted}、重複 ${outcome.duplicates}），佇列剩 ${outcome.remaining} 筆。"
            } finally {
                uploadButton.isEnabled = true
                refreshScreenStatus()
            }
        }
    }

    private fun testScreenConnection() {
        saveScreenInputs()
        testButton.isEnabled = false
        screenResult.text = "測試連線中…"
        lifecycleScope.launch {
            try {
                val status = runCatching { ScreenUploader.checkStatus(this@MainActivity) }
                screenResult.text = status.fold(
                    onSuccess = {
                        val last = it.optString("lastObservationAt").takeUnless { value -> value.isEmpty() || value == "null" }
                        "連線成功（${it.optString("status")}）：伺服器最後收到 ${last ?: "尚無資料"}，待處理 ${it.optInt("pending")} 筆。"
                    },
                    onFailure = { "連線失敗：${it.message ?: it.javaClass.simpleName}" },
                )
            } finally {
                testButton.isEnabled = true
            }
        }
    }

    private fun refreshScreenStatus() {
        val enabled = isScreenServiceEnabled()
        accessibilityStatus.text = if (enabled) "無障礙服務：已開啟" else "無障礙服務：尚未開啟（記錄需要開啟 Infovore 手機 Dayflow）"
        recordingSwitch.isChecked = screenSettings.enabled
        val now = System.currentTimeMillis()
        val paused = screenSettings.isPaused(now)
        pauseButton.text = if (paused) "恢復" else "暫停 1 小時"
        val state = when {
            !screenSettings.enabled -> "記錄已關閉"
            paused -> "已暫停至 ${Instant.ofEpochMilli(screenSettings.pausedUntil).atZone(java.time.ZoneId.systemDefault()).toLocalTime().withNano(0)}"
            !enabled -> "等待開啟無障礙服務"
            else -> "記錄中"
        }
        val lastCapture = screenSettings.lastCaptureAt.takeIf { it > 0 }
            ?.let { Instant.ofEpochMilli(it).atZone(java.time.ZoneId.systemDefault()).toLocalDateTime().withNano(0).toString() }
            ?: "尚未擷取"
        val pending = ObservationQueue.get(this).count()
        screenStatus.text = "狀態：$state\n最後擷取時間：$lastCapture\n佇列中 $pending 筆\n最後上傳結果：${screenSettings.lastUploadStatus}"
    }

    private fun isScreenServiceEnabled(): Boolean {
        val expected = ComponentName(this, ScreenActivityService::class.java)
        val enabled = Settings.Secure.getString(contentResolver, Settings.Secure.ENABLED_ACCESSIBILITY_SERVICES).orEmpty()
        return enabled.split(':').any { ComponentName.unflattenFromString(it) == expected }
    }

    private fun runManualSync(sleepOnly: Boolean = false) {
        if (syncing) return
        syncing = true
        saveInputs()
        syncButton.isEnabled = false
        sleepButton.isEnabled = false
        syncStatus.text = "同步中…第一次同步可能需要幾分鐘。"
        window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        lifecycleScope.launch {
            try {
                val outcome = runCatching {
                    withContext(Dispatchers.IO) {
                        val progress: (String) -> Unit = { progress ->
                            settings.lastStatus = progress
                            runOnUiThread {
                                syncStatus.text = progress
                                sleepStatus.text = settings.lastSleepStatus
                            }
                        }
                        val sync = HealthConnectSync(this@MainActivity)
                        if (sleepOnly) sync.runSleep(progress) else sync.run(progress)
                    }
                }
                outcome.onSuccess {
                    settings.lastStatus = "${Instant.now()}：新增 ${it.inserted}、更新 ${it.updated}、刪除 ${it.deleted}"
                }.onFailure {
                    settings.lastStatus = "${Instant.now()}：${it.message ?: it.javaClass.simpleName}"
                }
                syncStatus.text = settings.lastStatus
                sleepStatus.text = settings.lastSleepStatus
            } finally {
                window.clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
                syncing = false
                refreshPermissionStatus()
            }
        }
    }

    private fun saveInputs() {
        settings.endpoint = endpointInput.text.toString()
        settings.token = tokenInput.text.toString()
        settings.historyDays = historyDaysInput.text.toString().toIntOrNull() ?: SecureSettings.DEFAULT_HISTORY_DAYS
        historyDaysInput.setText(settings.historyDays.toString())
    }

    private suspend fun refreshPermissionStatus() {
        val sdkStatus = HealthConnectClient.getSdkStatus(this)
        if (sdkStatus != HealthConnectClient.SDK_AVAILABLE) {
            permissionStatus.text = "此裝置目前無法使用 Health Connect（狀態 $sdkStatus）。"
            syncButton.isEnabled = false
            sleepButton.isEnabled = false
            return
        }
        val client = HealthConnectClient.getOrCreate(this)
        val granted = client.permissionController.getGrantedPermissions()
        val missing = HealthConnectSync.readPermissions - granted
        permissionStatus.text = if (missing.isEmpty()) {
            val background = HealthPermission.PERMISSION_READ_HEALTH_DATA_IN_BACKGROUND in granted
            val history = HealthPermission.PERMISSION_READ_HEALTH_DATA_HISTORY in granted
            "Health Connect 已授權（背景：${yesNo(background)}；完整歷史：${yesNo(history)}）"
        } else {
            "Health Connect 尚缺 ${missing.size} 項資料讀取權限。"
        }
        syncButton.isEnabled = !syncing && missing.isEmpty()
        sleepButton.isEnabled = !syncing
        sleepStatus.text = settings.lastSleepStatus
    }

    private fun permissionsToRequest(client: HealthConnectClient): Set<String> = buildSet {
        addAll(HealthConnectSync.readPermissions)
        if (client.features.getFeatureStatus(HealthConnectFeatures.FEATURE_READ_HEALTH_DATA_IN_BACKGROUND) ==
            HealthConnectFeatures.FEATURE_STATUS_AVAILABLE
        ) add(HealthPermission.PERMISSION_READ_HEALTH_DATA_IN_BACKGROUND)
        if (client.features.getFeatureStatus(HealthConnectFeatures.FEATURE_READ_HEALTH_DATA_HISTORY) ==
            HealthConnectFeatures.FEATURE_STATUS_AVAILABLE
        ) add(HealthPermission.PERMISSION_READ_HEALTH_DATA_HISTORY)
    }

    private fun label(text: String) = TextView(this).apply {
        this.text = text
        setPadding(0, dp(10), 0, 0)
    }

    private fun matchWrap(topMargin: Int = 0) = LinearLayout.LayoutParams(
        LinearLayout.LayoutParams.MATCH_PARENT,
        LinearLayout.LayoutParams.WRAP_CONTENT,
    ).apply { this.topMargin = topMargin }

    private companion object {
        const val PAUSE_MS = 60 * 60_000L
    }

    private fun dp(value: Int) = (value * resources.displayMetrics.density).toInt()
    private fun yesNo(value: Boolean) = if (value) "是" else "否"
}
