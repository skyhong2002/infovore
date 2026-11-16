package tw.skyhong.infovore.health

import android.annotation.SuppressLint
import android.content.Intent
import android.graphics.Color
import android.graphics.Typeface
import android.graphics.drawable.GradientDrawable
import android.os.Bundle
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
import tw.skyhong.infovore.health.ui.ActivityDashboard
import tw.skyhong.infovore.health.ui.ViewKit
import tw.skyhong.infovore.health.ui.ViewKit.Style

/** Daily reading surface. Health Connect setup remains in MainActivity. */
class HomeActivity : AppCompatActivity() {
    private lateinit var kit: ViewKit
    private lateinit var settings: SecureSettings
    private lateinit var body: FrameLayout
    private val navigation = mutableListOf<Button>()
    private var tab = "home"
    private var job: Job? = null
    private var web: WebView? = null
    private var generation = 0
    private var loadedTarget: String? = null
    private var browseFilter = ""
    private var browsePath: String? = null

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        WindowCompat.setDecorFitsSystemWindows(window, false)
        kit = ViewKit(this)
        settings = SecureSettings(this)
        // The 時間軸 tab (phone timeline) is gone; a state saved by 0.5.x opens the overview.
        tab = savedInstanceState?.getString("tab")?.takeIf { it in TABS } ?: "home"
        browsePath = savedInstanceState?.getString("browsePath")
        browseFilter = savedInstanceState?.getString("browseFilter") ?: ""
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
        for ((key, label) in listOf("home" to "總覽", "browse" to "瀏覽", "settings" to "設定")) {
            val icon = when (key) { "home" -> R.drawable.nav_home; "browse" -> R.drawable.nav_browse; else -> R.drawable.nav_settings }
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
        if (loadedTarget != null && loadedTarget != target) web?.clearHistory()
        loadedTarget = target
        select(tab)
        web?.onResume()
    }

    override fun onStop() {
        super.onStop()
        generation++
        job?.cancel()
        if (tab != "browse") body.removeAllViews()
        web?.onPause()
    }

    override fun onDestroy() {
        web?.destroy()
        web = null
        super.onDestroy()
    }

    override fun onSaveInstanceState(outState: Bundle) {
        outState.putString("tab", tab)
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
            val selected = (TABS + "settings")[index] == key
            button.isSelected = selected
            TextViewCompat.setCompoundDrawableTintList(button, ColorStateList.valueOf(kit.color(if (selected) R.color.brand_primary else R.color.text_secondary)))
            button.setTextColor(kit.color(if (selected) R.color.brand_primary else R.color.text_secondary))
            button.setTypeface(null, if (selected) Typeface.BOLD else Typeface.NORMAL)
            button.background = rounded(if (selected) kit.color(R.color.tone_neutral_background) else Color.TRANSPARENT, 14)
            ViewCompat.setStateDescription(button, if (selected) "目前頁面" else null)
        }
        when (key) {
            "browse" -> if (browsePath == null) browseFeed() else browse()
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
        val dashboard = kit.column()
        content.addView(dashboard, ViewKit.matchWrap(kit.dp(16)))
        loadDashboard(dashboard)
    }

    /** The public /api/dayflow.json, the same data as /platforms/dayflow. */
    private fun loadDashboard(container: LinearLayout) {
        val status = kit.liveText(Style.CAPTION).apply { text = "正在讀取活動總覽…" }
        container.addView(status)
        val version = generation
        job = lifecycleScope.launch {
            try {
                val response = withContext(Dispatchers.IO) {
                    InfovoreApi(testPublicEndpoint ?: SITE, InfovoreApi.Timing(retryDelaysMs = emptyList())).getJson("/api/dayflow.json", "")
                }
                if (version != generation) return@launch
                val overview = response.optJSONObject("data") ?: throw IllegalStateException("overview unavailable")
                container.removeAllViews()
                container.addView(ActivityDashboard(this@HomeActivity, kit).render(overview))
            } catch (error: CancellationException) { throw error
            } catch (_: Exception) {
                if (version != generation) return@launch
                status.text = "暫時無法讀取活動總覽，請確認網路後重試。"
                container.addView(kit.textButton("重試").apply { setOnClickListener { select("home") } })
            }
        }
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

    private fun openSettings() {
        startActivity(Intent(this, MainActivity::class.java))
    }

    private fun row() = LinearLayout(this).apply { orientation = LinearLayout.HORIZONTAL; gravity = Gravity.CENTER_VERTICAL }
    private fun rounded(color: Int, radius: Int) = GradientDrawable().apply { setColor(color); cornerRadius = kit.dp(radius).toFloat() }

    companion object {
        private const val SITE = "https://infovore.skyhong.tw"
        private val TABS = listOf("home", "browse")
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
    }
}
