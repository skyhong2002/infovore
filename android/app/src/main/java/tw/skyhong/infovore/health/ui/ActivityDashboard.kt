package tw.skyhong.infovore.health.ui

import android.content.Context
import android.graphics.Color
import android.graphics.drawable.GradientDrawable
import android.text.SpannableString
import android.text.Spanned
import android.text.style.ForegroundColorSpan
import android.view.Gravity
import android.view.View
import android.view.ViewGroup
import android.widget.LinearLayout
import android.widget.TextView
import org.json.JSONArray
import org.json.JSONObject
import tw.skyhong.infovore.health.R
import tw.skyhong.infovore.health.ui.ViewKit.Style
import java.time.Instant
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import java.util.Locale
import kotlin.math.roundToInt

/** Native version of /platforms/dayflow: outlined stats, topic chips and stacked daily bars. */
class ActivityDashboard(private val context: Context, private val kit: ViewKit) {
    fun render(data: JSONObject, phone: Boolean, onDay: (String) -> Unit): View {
        val root = kit.column()
        val extra = data.getJSONObject("extra")
        val stats = data.getJSONObject("stats")
        val days = extra.getJSONArray("daily")
        root.addView(hero(extra, phone))
        val overview = panel()
        overview.addView(kit.heading(Style.SUBHEAD, "時數總覽"))
        val metrics = listOf(
            (if (phone) "近 30 天有紀錄" else "有紀錄天數") to "${stats.optInt("recordedDays")} 天",
            "今日記錄" to duration(stats.optDouble("todayMinutes")),
            "本週記錄" to hours(stats.optDouble("weeklyHours")),
            "本週活躍" to hours(stats.optDouble("weeklyActiveHours")),
        )
        val columns = if (context.resources.configuration.fontScale >= 1.5f) 1 else 2
        for (chunk in metrics.chunked(columns)) {
            val row = horizontal()
            for ((label, value) in chunk) {
                val cell = panel(11).apply { setPadding(kit.dp(12), kit.dp(12), kit.dp(12), kit.dp(12)) }
                cell.addView(kit.text(Style.CAPTION, label))
                cell.addView(kit.text(Style.SECTION, value), ViewKit.matchWrap(kit.dp(4)))
                row.addView(cell, LinearLayout.LayoutParams(0, -1, 1f).apply { if (row.childCount > 0) marginStart = kit.dp(8) })
            }
            overview.addView(row, ViewKit.matchWrap(kit.dp(8)))
        }
        overview.addView(kit.text(Style.CAPTION, "本週為週一至週日，Asia/Taipei 每天 04:00 起算。活躍時間不含閒置。"), ViewKit.matchWrap(kit.dp(12)))
        root.addView(overview, ViewKit.matchWrap(kit.dp(16)))

        val pools = extra.optJSONObject("keywordPools")
        heading(root, "近期特別常見", "最近 7 天 vs 前 90 天")
        val distinctive = pools?.optJSONArray("distinctive") ?: JSONArray()
        root.addView(chips(distinctive) { item -> "${item.getString("name")} · ${item.optInt("mentions")} 段活動" })
        root.addView(note(when {
            pools == null -> "目前沒有近期主題統計。"
            pools.optString("status") == "insufficient_history" -> "歷史資料累積中，尚不足以比較哪些主題特別常見。"
            distinctive.length() == 0 -> "這段時間沒有明顯增加的主題。"
            else -> "相較平常更常出現的主題。最近：${pools.optString("recentFrom")}–${pools.optString("recentTo")}；對照期有 ${pools.optInt("baselineDays")} 天紀錄。"
        }), ViewKit.matchWrap(kit.dp(12)))
        heading(root, "所有近期關鍵字", "最近 7 天 · 次數為活動提及")
        val all = pools?.optJSONArray("all") ?: extra.optJSONArray("keywords") ?: JSONArray()
        if (all.length() == 0) root.addView(kit.text(Style.CAPTION, "目前沒有可顯示的關鍵字。"))
        else root.addView(chips(all) { item -> "${item.getString("name")} · ${item.optInt("mentions")} 段活動" })
        root.addView(note(if (phone) "從已整理的手機活動標題與摘要擷取關鍵字；未做電腦 Dayflow 的 AI 主題分類。次數不是使用時長，主題可能重疊。" else "與網頁 Dayflow 使用相同的主題統計。次數為活動提及，不是使用時長；主題可能重疊。"), ViewKit.matchWrap(kit.dp(12)))

        heading(root, "本週分類", "週一至週日 · 04:00 分日")
        val categories = extra.getJSONArray("categories")
        if (categories.length() == 0) root.addView(kit.text(Style.CAPTION, "本週尚無已整理的活動。"))
        else {
            root.addView(chips(categories, categoryColors = true) { item -> "● ${category(item.getString("name"))} · ${duration(item.getDouble("minutes"))}" })
            root.addView(bar(categories, sum(categories)), ViewKit.matchWrap(kit.dp(12)))
        }
        heading(root, "最近有紀錄的日子", "Asia/Taipei · 04:00–04:00")
        val shown = (0 until minOf(days.length(), 30)).map { days.getJSONObject(it) }
            .filter { it.optDouble("trackedMinutes", 0.0) + it.optDouble("errorMinutes", 0.0) > 0 }
        val maximum = shown.maxOfOrNull { it.optDouble("trackedMinutes") }?.coerceAtLeast(1.0) ?: 1.0
        if (shown.isEmpty()) root.addView(note("等待第一批活動整理完成。沒有紀錄的日子不會當成零分鐘。"))
        for (day in shown) {
            val date = day.getString("day")
            val card = panel(11)
            val line = horizontal()
            line.addView(kit.text(Style.CAPTION, date), LinearLayout.LayoutParams(0, -2, 1f))
            line.addView(kit.text(Style.SUBHEAD, duration(day.optDouble("trackedMinutes"))))
            card.addView(line)
            card.addView(bar(day.getJSONArray("categories"), maximum), ViewKit.matchWrap(kit.dp(10)))
            card.addView(kit.text(Style.CAPTION, "${duration(day.optDouble("activeMinutes"))} 活躍 · ${duration(day.optDouble("idleMinutes"))} 閒置"), ViewKit.matchWrap(kit.dp(8)))
            val keywords = day.optJSONArray("keywords")
            if (keywords != null && keywords.length() > 0) card.addView(kit.text(Style.CAPTION, (0 until keywords.length()).map { keywords.getJSONObject(it).getString("name") }.joinToString(" · ")), ViewKit.matchWrap(kit.dp(4)))
            if (phone) {
                card.addView(kit.textButton("查看 $date 活動  →").apply { setOnClickListener { onDay(date) } }, ViewKit.matchWrap(kit.dp(4)))
            }
            root.addView(card, ViewKit.matchWrap(kit.dp(8)))
        }
        root.addView(note(if (phone) "手機抽樣記錄獨立計算，可能與電腦時間重疊。活動摘要只在私人介面顯示，原始畫面不會出現在這裡。" else "電腦時間包含閒置，排除分析錯誤；可能與音樂、影片及手機時間重疊。完整電腦活動描述維持私密。"), ViewKit.matchWrap(kit.dp(16)))
        return root
    }

    private fun hero(extra: JSONObject, phone: Boolean): View = panel().apply {
        background = GradientDrawable(GradientDrawable.Orientation.TL_BR, intArrayOf(kit.color(R.color.dashboard_hero), kit.color(R.color.card_background))).apply {
            cornerRadius = kit.dp(16).toFloat()
            setStroke(kit.dp(1), kit.color(R.color.card_stroke))
        }
        addView(kit.text(Style.CAPTION, if (phone) "INFOVORE · 手機活動" else "INFOVORE MIRROR · DAYFLOW").apply { setTextColor(kit.color(R.color.dashboard_accent)) })
        addView(kit.heading(Style.TITLE, if (phone) "手機足跡" else "Dayflow"), ViewKit.matchWrap(kit.dp(6)))
        addView(kit.text(Style.CAPTION, if (phone) "每天的手機活動、主題、分類與活躍時間。" else "每天的電腦活動、主題、分類與活躍時間。"), ViewKit.matchWrap(kit.dp(6)))
        val at = extra.optString("lastSyncedAt")
        val stamp = runCatching { DateTimeFormatter.ofPattern("M/d HH:mm").withZone(ZoneId.of("Asia/Taipei")).format(Instant.parse(at)) }.getOrNull()
        addView(kit.text(Style.CAPTION, if (stamp == null) "尚未收到紀錄" else "${if (phone) "最新記錄" else "最後同步"} $stamp"), ViewKit.matchWrap(kit.dp(12)))
    }

    private fun heading(root: LinearLayout, title: String, description: String) {
        root.addView(kit.heading(Style.SUBHEAD, title), ViewKit.matchWrap(kit.dp(26)))
        root.addView(kit.text(Style.CAPTION, description), ViewKit.matchWrap(kit.dp(4)))
    }

    private fun chips(items: JSONArray, categoryColors: Boolean = false, label: (JSONObject) -> String): View = WrapLayout(context, kit.dp(6)).apply {
        for (i in 0 until items.length()) {
            val item = items.getJSONObject(i)
            addView(kit.text(Style.CAPTION, label(item)).apply {
                textSize = 13f
                if (categoryColors) {
                    text = SpannableString(text).apply { setSpan(ForegroundColorSpan(color(item.optString("color"))), 0, 1, Spanned.SPAN_EXCLUSIVE_EXCLUSIVE) }
                }
                setPadding(kit.dp(9), kit.dp(4), kit.dp(9), kit.dp(4))
                background = shape(kit.color(R.color.screen_background), 18)
            })
        }
    }

    private fun bar(categories: JSONArray, max: Double): View {
        val total = sum(categories)
        return horizontal().apply {
            minimumHeight = kit.dp(8)
            weightSum = max.toFloat().coerceAtLeast(total.toFloat()).coerceAtLeast(1f)
            background = shape(kit.color(R.color.tone_neutral_background), 4, stroke = false)
            importantForAccessibility = View.IMPORTANT_FOR_ACCESSIBILITY_NO
            for (i in 0 until categories.length()) {
                val category = categories.getJSONObject(i)
                val mins = category.optDouble("minutes")
                if (mins > 0) addView(View(context).apply { setBackgroundColor(color(category.optString("color"))) }, LinearLayout.LayoutParams(0, kit.dp(8), mins.toFloat()))
            }
            contentDescription = "分類時數分布"
        }
    }

    private fun note(value: String): View = kit.text(Style.CAPTION, value).apply {
        setPadding(kit.dp(12), kit.dp(12), kit.dp(12), kit.dp(12))
        background = shape(kit.color(R.color.card_background), 11, stroke = false)
    }
    private fun panel(radius: Int = 16) = kit.column().apply {
        background = shape(kit.color(R.color.card_background), radius)
        setPadding(kit.dp(16), kit.dp(16), kit.dp(16), kit.dp(16))
    }
    private fun shape(fill: Int, radius: Int, stroke: Boolean = true) = GradientDrawable().apply {
        setColor(fill); cornerRadius = kit.dp(radius).toFloat()
        if (stroke) setStroke(kit.dp(1), kit.color(R.color.card_stroke))
    }
    private fun horizontal() = LinearLayout(context).apply { orientation = LinearLayout.HORIZONTAL; gravity = Gravity.CENTER_VERTICAL }
    private fun color(value: String): Int = runCatching { Color.parseColor(value) }.getOrDefault(kit.color(R.color.brand_primary))
    private fun sum(categories: JSONArray) = (0 until categories.length()).sumOf { categories.getJSONObject(it).optDouble("minutes") }
    private fun hours(value: Double) = String.format(Locale.TAIWAN, "%.1f 小時", value)
    private fun duration(value: Double): String {
        val mins = value.roundToInt()
        return if (mins >= 60) "${mins / 60} 小時 ${mins % 60} 分" else "$mins 分鐘"
    }
    private fun category(name: String): String = when(name) {
        "Work" -> "工作"; "Learning" -> "學習"; "Communication" -> "通訊"; "Social media" -> "社群"
        "Entertainment" -> "娛樂"; "News & reading" -> "新聞與閱讀"; "Life admin" -> "生活"; "Idle" -> "閒置"; else -> name
    }
}

/** Width-aware chip flow: wraps naturally at larger font sizes without truncating labels. */
private class WrapLayout(context: Context, private val gap: Int) : ViewGroup(context) {
    override fun onMeasure(widthMeasureSpec: Int, heightMeasureSpec: Int) {
        val width = MeasureSpec.getSize(widthMeasureSpec)
        val usable = (width - paddingLeft - paddingRight).coerceAtLeast(0)
        var x = 0; var y = 0; var height = 0
        for (i in 0 until childCount) {
            val child = getChildAt(i)
            child.measure(MeasureSpec.makeMeasureSpec(usable, MeasureSpec.AT_MOST), MeasureSpec.makeMeasureSpec(0, MeasureSpec.UNSPECIFIED))
            if (x > 0 && x + child.measuredWidth > usable) { x = 0; y += height + gap; height = 0 }
            height = maxOf(height, child.measuredHeight)
            x += child.measuredWidth + gap
        }
        setMeasuredDimension(resolveSize(width, widthMeasureSpec), resolveSize(y + height + paddingTop + paddingBottom, heightMeasureSpec))
    }
    override fun onLayout(changed: Boolean, left: Int, top: Int, right: Int, bottom: Int) {
        val usable = right - left - paddingLeft - paddingRight
        var x = 0; var y = paddingTop; var height = 0
        for (i in 0 until childCount) {
            val child = getChildAt(i)
            if (x > 0 && x + child.measuredWidth > usable) { x = 0; y += height + gap; height = 0 }
            child.layout(paddingLeft + x, y, paddingLeft + x + child.measuredWidth, y + child.measuredHeight)
            x += child.measuredWidth + gap
            height = maxOf(height, child.measuredHeight)
        }
    }
}
