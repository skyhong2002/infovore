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
    val root: LinearLayout = kit.card()
    val body: LinearLayout = kit.column()
    private val titleView: TextView = kit.text(ViewKit.Style.SECTION, title)
    private val summaryView: TextView = kit.text(ViewKit.Style.CAPTION)
    private val chevron = kit.chevron()
    private val header = LinearLayout(root.context).apply {
        orientation = LinearLayout.HORIZONTAL
        gravity = Gravity.CENTER_VERTICAL
        minimumHeight = kit.dp(56)
        setPadding(0, kit.dp(8), 0, kit.dp(8))
        isClickable = true
        isFocusable = true
        val ripple = android.util.TypedValue()
        context.theme.resolveAttribute(android.R.attr.selectableItemBackground, ripple, true)
        setBackgroundResource(ripple.resourceId)
    }
    private val titleText = title

    var expanded: Boolean = expanded
        private set

    init {
        val texts = kit.column().apply {
            addView(titleView)
            addView(summaryView)
        }
        header.addView(texts, LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f))
        header.addView(chevron, LinearLayout.LayoutParams(kit.dp(24), kit.dp(24)).apply { marginStart = kit.dp(8) })
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
        chevron.rotation = if (value) 180f else 0f
        ViewCompat.setStateDescription(header, root.context.getString(if (value) R.string.state_expanded else R.string.state_collapsed))
        header.setClickActionLabel(root.context.getString(if (value) R.string.action_collapse else R.string.action_expand))
        if (notify) onToggle(value)
    }

    fun setSummary(text: CharSequence?, tone: Tone = Tone.NEUTRAL) {
        summaryView.text = text
        summaryView.visibility = if (text.isNullOrEmpty()) View.GONE else View.VISIBLE
        if (tone == Tone.NEUTRAL) {
            summaryView.setTextColor(kit.color(R.color.text_secondary))
        } else {
            kit.setTone(summaryView, tone, tintBackground = false)
        }
        header.contentDescription = if (text.isNullOrEmpty()) titleText else "$titleText，$text"
    }

    fun add(view: View, topMarginDp: Int = 0) {
        body.addView(view, ViewKit.matchWrap(kit.dp(topMarginDp)))
    }
}
