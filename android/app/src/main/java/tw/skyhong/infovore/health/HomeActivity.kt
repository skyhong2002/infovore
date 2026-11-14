package tw.skyhong.infovore.health

import android.annotation.SuppressLint
import android.content.ComponentName
import android.content.Intent
import android.graphics.Color
import android.graphics.Typeface
import android.graphics.drawable.GradientDrawable
import android.os.Bundle
import android.provider.Settings
import android.view.Gravity
import android.view.View
import android.webkit.WebResourceRequest
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.Button
import android.widget.FrameLayout
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.HorizontalScrollView
import android.widget.ImageView
import android.content.res.ColorStateList
import androidx.core.content.ContextCompat
import androidx.core.widget.TextViewCompat
import androidx.activity.OnBackPressedCallback
import androidx.appcompat.app.AppCompatActivity
import androidx.core.view.ViewCompat
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import androidx.lifecycle.lifecycleScope
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import org.json.JSONObject
import tw.skyhong.infovore.health.screen.ObservationQueue
import tw.skyhong.infovore.health.screen.ScreenActivityService
import tw.skyhong.infovore.health.screen.ScreenSettings
import tw.skyhong.infovore.health.ui.ActivityDashboard
import tw.skyhong.infovore.health.ui.ViewKit
import tw.skyhong.infovore.health.ui.ViewKit.Style
import java.time.Instant
import java.time.LocalDate
import java.time.ZoneId
import java.time.format.DateTimeFormatter

/** Daily reading surface. Recorder and Health Connect setup remain in MainActivity. */
class HomeActivity : AppCompatActivity() {
    private lateinit var kit: ViewKit
    private lateinit var settings: SecureSettings
    private lateinit var recording: ScreenSettings
    private lateinit var body: FrameLayout
    private val navigation = mutableListOf<Button>()
    private var tab = "home"
    private var day = today()
    private var job: Job? = null
    private var web: WebView? = null
    private var generation = 0
    private var loadedTarget: String? = null
    private var dashboardSource = "phone"
    private var browseFilter = ""
    private var browsePath: String? = null
    private val zone = ZoneId.of("Asia/Taipei")

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        WindowCompat.setDecorFitsSystemWindows(window, false)
        kit = ViewKit(this)
        settings = SecureSettings(this)
        recording = ScreenSettings(this)
        tab = savedInstanceState?.getString("tab") ?: "home"
        dashboardSource = savedInstanceState?.getString("dashboardSource") ?: "phone"
        browsePath = savedInstanceState?.getString("browsePath")
        browseFilter = savedInstanceState?.getString("browseFilter") ?: ""
        day = savedInstanceState?.getString("day")?.let { runCatching { LocalDate.parse(it) }.getOrNull() } ?: today()
        val root = kit.column().apply { setBackgroundColor(kit.color(R.color.screen_background)) }
        val header = row().apply { setPadding(kit.dp(20), kit.dp(8), kit.dp(12), kit.dp(8)) }
        header.addView(ImageView(this).apply { setImageResource(R.drawable.infovore_logo); importantForAccessibility = View.IMPORTANT_FOR_ACCESSIBILITY_NO }, LinearLayout.LayoutParams(kit.dp(32), kit.dp(32)))
        header.addView(kit.heading(Style.SECTION, "Infovore").apply { setPadding(kit.dp(10), 0, 0, 0) }, LinearLayout.LayoutParams(0, -2, 1f))
        header.addView(kit.textButton("重新整理").apply { setOnClickListener { if (tab == "browse" && browsePath != null) web?.reload() else select(tab) } })
        root.addView(header)
        body = FrameLayout(this)
        root.addView(body, LinearLayout.LayoutParams(-1, 0, 1f))
        val nav = row().apply {
            setPadding(kit.dp(12), kit.dp(4), kit.dp(12), kit.dp(4))
            setBackgroundColor(kit.color(R.color.card_background))
        }
        for ((key, label) in listOf("home" to "總覽", "browse" to "瀏覽", "phone" to "時間軸", "settings" to "設定")) {
            val icon = when (key) { "home" -> R.drawable.nav_home; "browse" -> R.drawable.nav_browse; "phone" -> R.drawable.nav_phone; else -> R.drawable.nav_settings }
            val button = kit.textButton(label).apply {
                textSize = 12f
                minHeight = kit.dp(72)
                setPadding(kit.dp(2), kit.dp(8), kit.dp(2), kit.dp(8))
                compoundDrawablePadding = kit.dp(4)
                setCompoundDrawablesWithIntrinsicBounds(null, ContextCompat.getDrawable(this@HomeActivity, icon), null, null)
                setOnClickListener { if (key == "settings") openSettings() else { browsePath = null; select(key) } }
            }
            navigation.add(button)
            nav.addView(button, LinearLayout.LayoutParams(0, -2, 1f))
        }
        root.addView(nav)
        ViewCompat.setOnApplyWindowInsetsListener(root) { view, insets ->
            val bars = insets.getInsets(WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.displayCutout() or WindowInsetsCompat.Type.ime())
            view.setPadding(bars.left, bars.top, bars.right, bars.bottom)
            WindowInsetsCompat.CONSUMED
        }
        setContentView(root)
        onBackPressedDispatcher.addCallback(this, object : OnBackPressedCallback(true) {
            override fun handleOnBackPressed() {
                when {
                    tab == "browse" && browsePath != null -> {
                        if (web?.canGoBack() == true) web?.goBack() else { browsePath = null; select("browse") }
                    }
                    tab != "home" -> select("home")
                    else -> finish()
                }
            }
        })
    }

    override fun onResume() {
        super.onResume()
        val target = DestinationChange.normalize(settings.endpoint)
        recording.bindLegacyToken(target)
        if (loadedTarget != null && loadedTarget != target) web?.clearHistory()
        loadedTarget = target
        select(tab)
        web?.onResume()
    }

    override fun onStop() {
        super.onStop()
        generation++
        job?.cancel()
        // Private cards are intentionally not retained while the app is in the background.
        if (tab != "browse") body.removeAllViews()
        web?.onPause()
    }

    override fun onDestroy() {
        web?.destroy()
        web = null
        super.onDestroy()
    }

    override fun onSaveInstanceState(outState: Bundle) {
        outState.putString("dashboardSource", dashboardSource)
        outState.putString("tab", tab)
        outState.putString("day", day.toString())
        outState.putString("browsePath", browsePath)
        outState.putString("browseFilter", browseFilter)
        super.onSaveInstanceState(outState)
    }

    private fun select(key: String) {
        generation++
        job?.cancel()
        tab = key
        body.removeAllViews()
        navigation.forEachIndexed { index, button ->
            val selected = listOf("home", "browse", "phone", "settings")[index] == key
            button.isSelected = selected
            TextViewCompat.setCompoundDrawableTintList(button, ColorStateList.valueOf(kit.color(if (selected) R.color.brand_primary else R.color.text_secondary)))
            button.setTextColor(kit.color(if (selected) R.color.brand_primary else R.color.text_secondary))
            button.setTypeface(null, if (selected) Typeface.BOLD else Typeface.NORMAL)
            button.background = rounded(if (selected) kit.color(R.color.tone_neutral_background) else Color.TRANSPARENT, 14)
            ViewCompat.setStateDescription(button, if (selected) "目前頁面" else null)
        }
        when (key) {
            "browse" -> if (browsePath == null) browseFeed() else browse()
            "phone" -> phone()
            else -> home()
        }
    }

    private fun page(): LinearLayout {
        val column = object : LinearLayout(this) {
            init { orientation = VERTICAL }
            override fun onMeasure(widthMeasureSpec: Int, heightMeasureSpec: Int) {
                super.onMeasure(MeasureSpec.makeMeasureSpec(minOf(MeasureSpec.getSize(widthMeasureSpec), kit.dp(760)), MeasureSpec.EXACTLY), heightMeasureSpec)
            }
        }.apply { setPadding(kit.dp(20), kit.dp(12), kit.dp(20), kit.dp(28)) }
        body.addView(ScrollView(this).apply { isFillViewport = true; addView(column, FrameLayout.LayoutParams(-1, -2, Gravity.CENTER_HORIZONTAL)) }, FrameLayout.LayoutParams(-1, -1))
        return column
    }

    private fun home() {
        val content = page()
        content.addView(kit.heading(Style.SECTION, "活動總覽"))
        val sources = row()
        for ((key, label) in listOf("phone" to "手機足跡", "computer" to "電腦 Dayflow")) {
            sources.addView(kit.textButton(label).apply {
                isSelected = dashboardSource == key
                if (isSelected) background = rounded(kit.color(R.color.tone_neutral_background), 24)
                setOnClickListener { dashboardSource = key; select("home") }
                ViewCompat.setStateDescription(this, if (isSelected) "目前來源" else null)
            }, LinearLayout.LayoutParams(0, -2, 1f))
        }
        content.addView(sources, ViewKit.matchWrap(kit.dp(12)))
        val dashboard = kit.column()
        content.addView(dashboard, ViewKit.matchWrap(kit.dp(16)))
        loadDashboard(dashboard)
        if (dashboardSource == "phone") {
            content.addView(sectionTitle("記錄與同步", "管理") { openSettings(screen = true) }, ViewKit.matchWrap(kit.dp(24)))
            content.addView(localStatus())
        }
    }

    private fun loadDashboard(container: LinearLayout) {
        val phone = dashboardSource == "phone"
        val destination = DestinationChange.normalize(settings.endpoint)
        val token = if (phone) recording.token else ""
        if (phone && (token.length < 32 || recording.tokenDestination != destination)) {
            container.addView(kit.text(Style.BODY, "連接手機足跡後，這裡會顯示近期主題、本週分類、每日分布與時數總覽。"))
            container.addView(kit.textButton("連接手機足跡  →").apply { setOnClickListener { openSettings(screen = true) } })
            return
        }
        val status = kit.liveText(Style.CAPTION).apply { text = "正在讀取活動總覽…" }
        container.addView(status)
        val version = generation
        val device = settings.deviceId
        job = lifecycleScope.launch {
            try {
                val response = withContext(Dispatchers.IO) {
                    val api = InfovoreApi(if (phone) destination else testPublicEndpoint ?: SITE, InfovoreApi.Timing(retryDelaysMs = emptyList()))
                    api.getJson(if (phone) "/api/ingest/dayflow-phone/activity?overview=1&deviceId=$device" else "/api/dayflow.json", token)
                }
                if (version != generation || (phone && (destination != DestinationChange.normalize(settings.endpoint) || recording.token != token))) return@launch
                val overview = response.optJSONObject(if (phone) "overview" else "data")
                    ?: throw IllegalStateException("overview unavailable")
                container.removeAllViews()
                container.addView(ActivityDashboard(this@HomeActivity, kit).render(overview, phone) { selectedDay ->
                    day = LocalDate.parse(selectedDay)
                    select("phone")
                })
            } catch (error: CancellationException) { throw error
            } catch (_: Exception) {
                if (version != generation) return@launch
                status.text = "暫時無法讀取活動總覽，請確認連線與伺服器已更新後重試。"
                container.addView(kit.textButton("重試").apply { setOnClickListener { select("home") } })
            }
        }
    }

    private fun localStatus(): View {
        val service = Settings.Secure.getString(contentResolver, Settings.Secure.ENABLED_ACCESSIBILITY_SERVICES)
            .orEmpty().split(':').any { ComponentName.unflattenFromString(it) == ComponentName(this, ScreenActivityService::class.java) }
        val state = when {
            !recording.enabled -> "尚未開始記錄"
            recording.isPaused() -> "記錄已暫停"
            !service -> "需要開啟無障礙服務"
            else -> "正在記錄手機活動"
        }
        val queued = ObservationQueue.get(this).count(DestinationChange.normalize(settings.endpoint))
        return kit.column().apply {
            addView(kit.heading(Style.SUBHEAD, state), ViewKit.matchWrap(kit.dp(12)))
            addView(kit.text(Style.CAPTION, "最近記錄：${stamp(recording.lastCaptureAt)}\n待上傳 $queued 筆 · ${recording.lastUploadStatus}"), ViewKit.matchWrap(kit.dp(8)))
            if (!recording.enabled || !service || recording.isPaused()) addView(kit.textButton("管理手機足跡  →").apply { setOnClickListener { openSettings(screen = true) } })
        }
    }

    private fun phone() {
        val content = page()
        content.addView(kit.heading(Style.TITLE, "手機足跡"), ViewKit.matchWrap(kit.dp(8)))
        content.addView(kit.text(Style.BODY, "回看手機上的一天。"), ViewKit.matchWrap(kit.dp(6)))
        val dates = row()
        dates.addView(kit.textButton("←").apply { contentDescription = "前一天"; setOnClickListener { day = day.minusDays(1); select("phone") } })
        dates.addView(kit.textButton(day.toString()).apply {
            contentDescription = "選擇日期，$day"
            setOnClickListener {
                android.app.DatePickerDialog(this@HomeActivity, { _, y, m, d -> day = LocalDate.of(y, m + 1, d); select("phone") }, day.year, day.monthValue - 1, day.dayOfMonth)
                    .apply { datePicker.maxDate = System.currentTimeMillis() }.show()
            }
        }, LinearLayout.LayoutParams(0, -2, 1f))
        dates.addView(kit.textButton("→").apply { contentDescription = "後一天"; isEnabled = day < today(); setOnClickListener { day = day.plusDays(1); select("phone") } })
        content.addView(dates, ViewKit.matchWrap(kit.dp(16)))
        content.addView(localStatus(), ViewKit.matchWrap(kit.dp(8)))
        content.addView(kit.textButton("重新整理").apply { setOnClickListener { select("phone") } })
        val timeline = kit.column()
        content.addView(timeline)
        content.addView(kit.text(Style.CAPTION, "Asia/Taipei · 每天 04:00 起算。抽樣記錄可能有空白；上傳後約 12–20 分鐘會整理成卡片。"), ViewKit.matchWrap(kit.dp(20)))
        load(timeline, day.toString(), preview = false)
    }

    private fun load(container: LinearLayout, date: String, preview: Boolean) {
        val destination = DestinationChange.normalize(settings.endpoint)
        val token = recording.token
        if (token.length < 32 || recording.tokenDestination != destination) {
            container.addView(kit.text(Style.BODY, "連接手機足跡後，這裡會出現活動摘要與使用的 app。"), ViewKit.matchWrap(kit.dp(12)))
            container.addView(kit.textButton("連接手機足跡  →").apply { setOnClickListener { openSettings(screen = true) } })
            return
        }
        val status = kit.liveText(Style.CAPTION).apply { text = "正在讀取活動…" }
        container.addView(status, ViewKit.matchWrap(kit.dp(12)))
        val version = generation
        val device = settings.deviceId
        job = lifecycleScope.launch {
            try {
                val data = withContext(Dispatchers.IO) {
                    InfovoreApi(destination, InfovoreApi.Timing(retryDelaysMs = emptyList()))
                        .getJson("/api/ingest/dayflow-phone/activity?day=$date&deviceId=$device", token)
                }
                if (version != generation || destination != DestinationChange.normalize(settings.endpoint) || recording.token != token) return@launch
                val server = data.getJSONObject("status")
                val pending = server.getInt("pending")
                val retrying = server.getInt("retrying")
                status.text = getString(R.string.home_server_pending, pending, retrying)
                if (!server.isNull("lastObservationAt")) status.append("\n最近收到記錄：${stamp(Instant.parse(server.getString("lastObservationAt")).toEpochMilli())}")
                val cards = data.getJSONArray("cards")
                if (cards.length() == 0) {
                    container.addView(kit.text(Style.BODY, if (pending > 0) "記錄已收到，活動整理中。稍後重新整理即可查看。" else "這一天還沒有活動。可以切換日期，或確認手機已開啟記錄與上傳。"), ViewKit.matchWrap(kit.dp(12)))
                    return@launch
                }
                if (!preview) {
                    val categories = data.getJSONArray("categories")
                    val summary = kit.card()
                    var total = 0
                    val lines = mutableListOf<String>()
                    for (i in 0 until categories.length()) {
                        val c = categories.getJSONObject(i)
                        val mins = c.getInt("minutes")
                        total += mins
                        if (mins > 0) lines.add("${category(c.getString("name"))}  $mins 分")
                    }
                    summary.addView(kit.heading(Style.TITLE, "$total 分鐘"), ViewKit.matchWrap(kit.dp(12)))
                    summary.addView(kit.text(Style.CAPTION, "已整理時間 · ${cards.length()} 段活動"))
                    summary.addView(kit.text(Style.BODY, lines.joinToString(" · ")), ViewKit.matchWrap(kit.dp(8)))
                    container.addView(summary, ViewKit.matchWrap(kit.dp(12)))
                }
                for (i in 0 until minOf(cards.length(), if (preview) 2 else 1000)) {
                    container.addView(activityCard(cards.getJSONObject(i)), ViewKit.matchWrap(kit.dp(12)))
                }
                if (data.optBoolean("truncated")) container.addView(kit.text(Style.CAPTION, "只顯示最新 1,000 段活動。"))
            } catch (error: CancellationException) { throw error
            } catch (error: Exception) {
                if (version != generation) return@launch
                status.text = when {
                    error is InfovoreApi.HttpStatusException && error.status == 401 -> "手機活動金鑰無效，請到設定更新。"
                    error is InfovoreApi.HttpStatusException && error.status == 404 -> "伺服器尚未支援時間軸，請更新伺服器。"
                    else -> "暫時無法讀取活動。請確認網路與同步連線後重試。"
                }
                container.addView(kit.textButton("重試").apply { setOnClickListener { select(tab) } })
            }
        }
    }

    private fun activityCard(card: JSONObject): View = kit.card().apply {
        val start = Instant.parse(card.getString("startAt"))
        val end = Instant.parse(card.getString("endAt"))
        val clock = DateTimeFormatter.ofPattern("HH:mm").withZone(zone)
        addView(kit.text(Style.CAPTION, "${clock.format(start)} – ${clock.format(end)} · ${java.time.Duration.between(start, end).toMinutes()} 分鐘"), ViewKit.matchWrap(kit.dp(12)))
        addView(kit.heading(Style.SUBHEAD, card.getString("title")), ViewKit.matchWrap(kit.dp(8)))
        val summary = card.optString("summary")
        if (summary.isNotBlank()) addView(kit.text(Style.BODY, summary), ViewKit.matchWrap(kit.dp(8)))
        val apps = card.getJSONArray("apps")
        val names = (0 until apps.length()).map { apps.getString(it) }
        addView(kit.text(Style.CAPTION, (listOf(category(card.getString("category"))) + names).joinToString(" · ")), ViewKit.matchWrap(kit.dp(12)))
        addView(kit.text(Style.CAPTION, if (card.optBoolean("summarized")) "AI 活動摘要" else "依 app 使用時段整理"), ViewKit.matchWrap(kit.dp(4)))
    }

    private fun sectionTitle(title: String, action: String, onClick: () -> Unit): View = row().apply {
        addView(kit.heading(Style.SECTION, title), LinearLayout.LayoutParams(0, -2, 1f))
        addView(kit.textButton(action).apply { setOnClickListener { onClick() } })
    }

    private fun openPage(path: String) {
        web?.clearHistory()
        browsePath = path
        select("browse")
    }

    private fun browseFeed() {
        val content = page()
        content.addView(kit.heading(Style.TITLE, "瀏覽"))
        content.addView(kit.text(Style.CAPTION, "Infovore · 最近的內容與活動"), ViewKit.matchWrap(kit.dp(8)))
        val filters = row()
        for ((label, kind) in listOf("全部" to "", "音樂" to "music", "影片" to "video", "閱讀" to "book", "活動" to "event")) {
            filters.addView(kit.textButton(label).apply {
                isSelected = browseFilter == kind
                if (isSelected) background = rounded(kit.color(R.color.tone_neutral_background), 16)
                setOnClickListener { browseFilter = kind; select("browse") }
            })
        }
        content.addView(HorizontalScrollView(this).apply { isHorizontalScrollBarEnabled = false; addView(filters) }, ViewKit.matchWrap(kit.dp(16)))
        content.addView(sectionTitle("最近紀錄", "所有平台") { openPage("/platforms") }, ViewKit.matchWrap(kit.dp(12)))
        val status = kit.liveText(Style.CAPTION).apply { text = "正在讀取內容…" }
        content.addView(status)
        val items = kit.card().apply { setPadding(kit.dp(16), 0, kit.dp(16), 0) }
        content.addView(items, ViewKit.matchWrap(kit.dp(12)))
        val version = generation
        job = lifecycleScope.launch {
            try {
                val data = withContext(Dispatchers.IO) {
                    InfovoreApi(testPublicEndpoint ?: SITE, InfovoreApi.Timing(retryDelaysMs = emptyList()))
                        .getJson("/api/activities.json?limit=24&kind=$browseFilter", "")
                }.getJSONArray("data")
                if (generation != version) return@launch
                status.text = if (data.length() == 0) "這個分類還沒有紀錄。" else "最近 ${data.length()} 筆 · 點選查看來源平台"
                for (i in 0 until data.length()) {
                    val item = data.getJSONObject(i)
                    val source = item.getString("source")
                    val entry = kit.column().apply {
                        setPadding(0, kit.dp(16), 0, kit.dp(16))
                        minimumHeight = kit.dp(64)
                        isClickable = true
                        isFocusable = true
                        setOnClickListener { if (source.matches(Regex("[a-z0-9-]+"))) openPage("/platforms/$source") }
                    }
                    entry.addView(kit.text(Style.CAPTION, sourceName(source) + " · " + mediaName(item.optString("mediaKind"))))
                    entry.addView(kit.text(Style.SUBHEAD, item.getString("title")), ViewKit.matchWrap(kit.dp(4)))
                    val at = item.optString("occurredAt")
                    if (at.isNotBlank() && at != "null") entry.addView(kit.text(Style.CAPTION, at.take(10)), ViewKit.matchWrap(kit.dp(4)))
                    items.addView(entry)
                    if (i < data.length() - 1) items.addView(View(this@HomeActivity).apply { setBackgroundColor(kit.color(R.color.card_stroke)) }, LinearLayout.LayoutParams(-1, kit.dp(1)))
                }
                content.addView(kit.textButton("搜尋完整紀錄  →").apply { setOnClickListener { openPage("/search") } }, ViewKit.matchWrap(kit.dp(16)))
            } catch (error: CancellationException) { throw error
            } catch (_: Exception) {
                if (generation != version) return@launch
                status.setText(R.string.home_content_unavailable)
                content.addView(kit.textButton("開啟 Infovore 網頁  →").apply { setOnClickListener { openPage("/") } })
            }
        }
    }

    @SuppressLint("SetJavaScriptEnabled")
    private fun browse() {
        val column = kit.column()
        val progress = kit.liveText(Style.CAPTION).apply { setPadding(kit.dp(20), 0, kit.dp(20), 0); text = "正在開啟 Infovore…" }
        column.addView(kit.textButton("← 返回內容列表").apply { setOnClickListener { browsePath = null; select("browse") } })
        val shortcuts = row()
        for ((label, path) in listOf("最新" to "/", "平台" to "/platforms", "統計" to "/stats")) shortcuts.addView(kit.textButton(label).apply { setOnClickListener { web?.loadUrl(SITE + path) } }, LinearLayout.LayoutParams(0, -2, 1f))
        column.addView(shortcuts)
        column.addView(progress)
        if (web == null) web = WebView(this).apply {
            settings.javaScriptEnabled = true
            settings.domStorageEnabled = true
            settings.allowFileAccess = false
            settings.allowContentAccess = false
            settings.mixedContentMode = android.webkit.WebSettings.MIXED_CONTENT_NEVER_ALLOW
        }
        (web?.parent as? android.view.ViewGroup)?.removeView(web)
        web!!.webViewClient = object : WebViewClient() {
            override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
                val uri = request.url
                if (uri.scheme == "https" && uri.host == "infovore.skyhong.tw" && uri.port in listOf(-1, 443)) {
                    if (uri.path == "/phone") { day = today(); select("phone"); return true }
                    return false
                }
                if (uri.scheme in listOf("https", "http", "mailto")) runCatching { startActivity(Intent(Intent.ACTION_VIEW, uri)) }
                return true
            }
            override fun onPageFinished(view: WebView, url: String) { progress.text = ""; progress.visibility = View.GONE }
            override fun onReceivedError(view: WebView, request: WebResourceRequest, error: android.webkit.WebResourceError) {
                if (request.isForMainFrame) { progress.visibility = View.VISIBLE; progress.text = "無法載入，請確認網路，或點選上方入口重試。" }
            }
        }
        column.addView(web, LinearLayout.LayoutParams(-1, 0, 1f))
        body.addView(column, FrameLayout.LayoutParams(-1, -1))
        if (web!!.url != SITE + browsePath) web!!.loadUrl(SITE + browsePath) else progress.visibility = View.GONE
    }

    private fun openSettings(health: Boolean = false, screen: Boolean = false) {
        startActivity(Intent(this, MainActivity::class.java).apply {
            putExtra(MainActivity.EXTRA_OPEN_HEALTH, health)
            putExtra(MainActivity.EXTRA_OPEN_SCREEN, screen)
        })
    }

    private fun stamp(value: Long): String = if (value <= 0) "尚無記錄" else DateTimeFormatter.ofPattern("M/d HH:mm").withZone(zone).format(Instant.ofEpochMilli(value))
    private fun row() = LinearLayout(this).apply { orientation = LinearLayout.HORIZONTAL; gravity = Gravity.CENTER_VERTICAL }
    private fun rounded(color: Int, radius: Int) = GradientDrawable().apply { setColor(color); cornerRadius = kit.dp(radius).toFloat() }

    companion object {
        private const val SITE = "https://infovore.skyhong.tw"
        @androidx.annotation.VisibleForTesting
        internal var testPublicEndpoint: String? = null
        private fun sourceName(source: String): String = when(source) {
            "statsfm" -> "stats.fm"; "youtube" -> "YouTube"; "hardcover" -> "Hardcover"; "backloggd" -> "Backloggd"
            "kitsu" -> "Kitsu"; "simkl" -> "SIMKL"; "events" -> "活動"; else -> source
        }
        private fun mediaName(kind: String): String = when(kind) {
            "music" -> "音樂"; "video" -> "影片"; "book" -> "書籍"; "event" -> "活動"; "movie" -> "電影"
            "show" -> "影集"; "anime" -> "動畫"; "manga" -> "漫畫"; "game" -> "遊戲"; else -> kind
        }
        private fun today(): LocalDate = java.time.ZonedDateTime.now(ZoneId.of("Asia/Taipei")).minusHours(4).toLocalDate()
        private fun category(name: String): String = when (name) {
            "Work" -> "工作"; "Learning" -> "學習"; "Communication" -> "通訊"; "Social media" -> "社群"
            "Entertainment" -> "娛樂"; "News & reading" -> "新聞與閱讀"; "Life admin" -> "生活"; "Idle" -> "閒置"; else -> name
        }
    }
}
