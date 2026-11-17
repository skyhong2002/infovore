package tw.skyhong.infovore.health.ui

import android.view.Gravity
import android.view.View
import android.widget.LinearLayout
import android.widget.TextView
import androidx.core.view.ViewCompat
import tw.skyhong.infovore.health.R

/**
 * A card with a tappable heading row (title, one-line status, chevron) and a body that can be
 * collapsed. TalkBack hears it as a heading with an "已展開 / 已收合" state and an expand action.
 */
class CollapsibleSection(
    private val kit: ViewKit,
    title: String,
    expanded: Boolean,
    private val onToggle: (Boolean) -> Unit = {},
) {
    // The header row brings its own vertical padding; the body adds the bottom space when open.
    val root: LinearLayout = kit.card().apply { setPadding(kit.dp(20), kit.dp(4), kit.dp(20), kit.dp(4)) }
    val body: LinearLayout = kit.column().apply { setPadding(0, 0, 0, kit.dp(16)) }
    private val titleView: TextView = kit.text(ViewKit.Style.SECTION, title)
    private val summaryView: TextView = kit.text(ViewKit.Style.CAPTION)
    private val chevron = kit.chevron()
    private val dot = kit.dot().apply { visibility = View.GONE }

    /** Shown under the header only while the section is collapsed, e.g. its main action. */
    private var collapsedFooter: View? = null
    private val header = LinearLayout(root.context).apply {
        orientation = LinearLayout.HORIZONTAL
        gravity = Gravity.CENTER_VERTICAL
        minimumHeight = kit.dp(64)
        setPadding(0, kit.dp(12), 0, kit.dp(12))
        isClickable = true
        isFocusable = true
        val ripple = android.util.TypedValue()
        context.theme.resolveAttribute(android.R.attr.selectableItemBackground, ripple, true)
        setBackgroundResource(ripple.resourceId)
    }
    private val titleText = title

    var expanded: Boolean = expanded
        private set

    /** The header's one-line status and its tone, also shown by the overview card. */
    var summary: CharSequence? = null
        private set
    var summaryTone: Tone = Tone.NEUTRAL
        private set

    val title: String get() = titleText

    init {
        // The header speaks "title，summary" with its heading and expanded state, as one stop.
        val texts = kit.column().apply {
            addView(titleView)
            addView(summaryView, ViewKit.matchWrap(kit.dp(2)))
            importantForAccessibility = View.IMPORTANT_FOR_ACCESSIBILITY_NO_HIDE_DESCENDANTS
        }
        // Centred on the title's first line, not on the title + summary block.
        // Dot and chevron grow with large text (capped), so they stay visible beside big titles.
        val glyphScale = root.context.resources.configuration.fontScale.coerceIn(1f, 1.5f)
        val dotSize = (kit.dp(10) * glyphScale).toInt()
        val chevronSize = (kit.dp(24) * glyphScale).toInt()
        header.addView(dot, LinearLayout.LayoutParams(dotSize, dotSize).apply {
            marginEnd = kit.dp(12)
            gravity = Gravity.TOP
            topMargin = ((titleView.lineHeight - dotSize) / 2).coerceAtLeast(0)
        })
        header.addView(texts, LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f))
        // On the title's line too, however many lines the summary takes.
        header.addView(chevron, LinearLayout.LayoutParams(chevronSize, chevronSize).apply {
            marginStart = kit.dp(12)
            gravity = Gravity.TOP
            topMargin = ((titleView.lineHeight - chevronSize) / 2).coerceAtLeast(0)
        })
        ViewCompat.setAccessibilityHeading(header, true)
        header.setOnClickListener { setExpanded(!this.expanded, notify = true) }
        root.addView(header, ViewKit.matchWrap())
        root.addView(body, ViewKit.matchWrap())
        setExpanded(expanded, notify = false)
        summaryView.visibility = View.GONE
    }

    fun setExpanded(value: Boolean, notify: Boolean = false) {
        expanded = value
        body.visibility = if (value) View.VISIBLE else View.GONE
        collapsedFooter?.visibility = if (value) View.GONE else View.VISIBLE
        chevron.rotation = if (value) 180f else 0f
        ViewCompat.setStateDescription(header, root.context.getString(if (value) R.string.state_expanded else R.string.state_collapsed))
        header.setClickActionLabel(root.context.getString(if (value) R.string.action_collapse else R.string.action_expand))
        if (notify) onToggle(value)
    }

    /** [idle]: off or not started yet ("未開啟"), an empty dot; a filled grey one is set up and quiet. */
    fun setSummary(text: CharSequence?, tone: Tone = Tone.NEUTRAL, idle: Boolean = false) {
        summary = text
        summaryTone = tone
        summaryIdle = idle && tone == Tone.NEUTRAL
        summaryView.text = text
        summaryView.visibility = if (text.isNullOrEmpty()) View.GONE else View.VISIBLE
        dot.visibility = summaryView.visibility
        // The dot carries "fine"; only warnings and errors color the words.
        if (tone == Tone.NEUTRAL || tone == Tone.OK) {
            summaryView.setTextColor(kit.color(R.color.text_secondary))
        } else {
            kit.setTone(summaryView, tone, tintBackground = false)
        }
        tintDot()
        header.contentDescription = if (text.isNullOrEmpty()) titleText else "$titleText，$text"
    }

    /** [view] shows below the header while the section is collapsed (and hides when it opens). */
    fun setCollapsedFooter(view: View) {
        collapsedFooter = view
        root.addView(view, ViewKit.matchWrap())
        view.visibility = if (expanded) View.GONE else View.VISIBLE
    }

    /** This section holds the first-run step to do now: a neutral dot takes the brand color. */
    var currentStep = false
        set(value) {
            field = value
            tintDot()
        }

    private var summaryIdle = false

    private fun tintDot() {
        if (summaryIdle && !currentStep) {
            // Off or not started: an empty ring in the neutral color.
            dot.imageTintList = null
            dot.setImageDrawable(android.graphics.drawable.GradientDrawable().apply {
                shape = android.graphics.drawable.GradientDrawable.OVAL
                setColor(android.graphics.Color.TRANSPARENT)
                setStroke((kit.dp(3) / 2).coerceAtLeast(2), kit.color(R.color.outline))
                setSize(kit.dp(10), kit.dp(10))
            })
            summaryView.setTextColor(kit.color(R.color.text_secondary))
            return
        }
        if (currentStep && summaryTone == Tone.NEUTRAL) {
            // The step to do now: a brand ring around a brand dot (unlike any status dot), and the
            // status words in the brand color, like the step's badge.
            val brand = kit.color(R.color.brand_primary)
            dot.imageTintList = null
            dot.setImageDrawable(android.graphics.drawable.LayerDrawable(arrayOf(
                android.graphics.drawable.GradientDrawable().apply {
                    shape = android.graphics.drawable.GradientDrawable.OVAL
                    setColor(android.graphics.Color.TRANSPARENT)
                    setStroke(kit.dp(1).coerceAtLeast(2), brand)
                    setSize(kit.dp(10), kit.dp(10))
                },
                android.graphics.drawable.GradientDrawable().apply {
                    shape = android.graphics.drawable.GradientDrawable.OVAL
                    setColor(brand)
                },
            )).apply { setLayerInset(1, kit.dp(3), kit.dp(3), kit.dp(3), kit.dp(3)) })
            summaryView.setTextColor(brand)
        } else {
            dot.setImageResource(R.drawable.dot)
            if (summaryTone == Tone.NEUTRAL || summaryTone == Tone.OK) summaryView.setTextColor(kit.color(R.color.text_secondary))
            kit.setDotTone(dot, summaryTone)
        }
    }

    fun add(view: View, topMarginDp: Int = 0) {
        body.addView(view, ViewKit.matchWrap(kit.dp(topMarginDp)))
    }
}
