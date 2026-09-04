@file:Suppress("SetTextI18n")

package tw.skyhong.infovore.health

import android.os.Bundle
import android.text.InputType
import android.view.View
import android.widget.Button
import android.widget.EditText
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView
import androidx.appcompat.app.AppCompatActivity
import androidx.health.connect.client.HealthConnectClient
import androidx.health.connect.client.HealthConnectFeatures
import androidx.health.connect.client.permission.HealthPermission
import androidx.lifecycle.lifecycleScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import java.time.Instant

class MainActivity : AppCompatActivity() {
    private lateinit var settings: SecureSettings
    private lateinit var endpointInput: EditText
    private lateinit var tokenInput: EditText
    private lateinit var permissionStatus: TextView
    private lateinit var syncStatus: TextView
    private lateinit var syncButton: Button

    private val permissionLauncher = registerForActivityResult(HealthConnectSync.permissionContract()) {
        lifecycleScope.launch { refreshPermissionStatus() }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        settings = SecureSettings(this)
        setContentView(buildContent())
        lifecycleScope.launch { refreshPermissionStatus() }
    }

    override fun onResume() {
        super.onResume()
        if (::permissionStatus.isInitialized) lifecycleScope.launch { refreshPermissionStatus() }
    }

    private fun buildContent(): View {
        val root = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(dp(24), dp(32), dp(24), dp(32))
        }
        root.addView(TextView(this).apply {
            text = "Infovore Health"
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

        root.addView(Button(this).apply {
            text = "儲存連線設定"
            setOnClickListener {
                settings.endpoint = endpointInput.text.toString()
                settings.token = tokenInput.text.toString()
                syncStatus.text = "設定已安全儲存；token 由 Android Keystore 加密。"
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
            text = "背景同步每 6 小時執行一次。請保持 Tailscale 連線，並在 Garmin Connect → 設定 → Health Connect 開啟資料分享。第一次同步預設讀取 30 天；授權歷史資料後最多回溯 10 年。"
            textSize = 14f
        })

        return ScrollView(this).apply { addView(root) }
    }

    private fun runManualSync() {
        settings.endpoint = endpointInput.text.toString()
        settings.token = tokenInput.text.toString()
        syncButton.isEnabled = false
        syncStatus.text = "同步中…第一次同步可能需要幾分鐘。"
        lifecycleScope.launch {
            val outcome = runCatching {
                withContext(Dispatchers.IO) {
                    HealthConnectSync(this@MainActivity).run { progress ->
                        settings.lastStatus = progress
                        runOnUiThread { syncStatus.text = progress }
                    }
                }
            }
            outcome.onSuccess {
                settings.lastStatus = "${Instant.now()}：新增 ${it.inserted}、更新 ${it.updated}、刪除 ${it.deleted}"
            }.onFailure {
                settings.lastStatus = "${Instant.now()}：${it.message ?: it.javaClass.simpleName}"
            }
            syncStatus.text = settings.lastStatus
            syncButton.isEnabled = true
        }
    }

    private suspend fun refreshPermissionStatus() {
        val sdkStatus = HealthConnectClient.getSdkStatus(this)
        if (sdkStatus != HealthConnectClient.SDK_AVAILABLE) {
            permissionStatus.text = "此裝置目前無法使用 Health Connect（狀態 $sdkStatus）。"
            syncButton.isEnabled = false
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
        syncButton.isEnabled = missing.isEmpty()
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

    private fun dp(value: Int) = (value * resources.displayMetrics.density).toInt()
    private fun yesNo(value: Boolean) = if (value) "是" else "否"
}
