package tw.skyhong.infovore.health.ui

import android.content.Context
import android.graphics.Typeface
import android.text.InputType
import android.util.TypedValue
import android.view.Gravity
import android.view.View
import android.view.ViewGroup
import android.widget.Button
import android.widget.EditText
import android.widget.ImageView
import android.widget.LinearLayout
import android.widget.ProgressBar
import android.widget.TextView
import androidx.appcompat.widget.AppCompatButton
import androidx.appcompat.widget.AppCompatEditText
import androidx.appcompat.widget.AppCompatTextView
import androidx.core.content.ContextCompat
import androidx.core.view.AccessibilityDelegateCompat
import androidx.core.view.ViewCompat
import androidx.core.view.accessibility.AccessibilityNodeInfoCompat
import androidx.core.view.accessibility.AccessibilityNodeInfoCompat.AccessibilityActionCompat
import androidx.core.widget.doAfterTextChanged
import tw.skyhong.infovore.health.R

/**
 * Small builder for the programmatic UI: consistent sp text sizes, ≥48dp touch targets,
 * theme-aware colors (light and dark), and the accessibility semantics TalkBack needs.
 */
class ViewKit(private val context: Context) {
    enum class Style(val sp: Float, val bold: Boolean, val secondary: Boolean) {
        TITLE(26f, true, false),
        SECTION(20f, true, false),
        SUBHEAD(16f, true, false),
        BODY(16f, false, false),
        CAPTION(14f, false, true),
    }

    fun dp(value: Int): Int = TypedValue.applyDimension(
        TypedValue.COMPLEX_UNIT_DIP, value.toFloat(), context.resources.displayMetrics,
    ).toInt()

    fun color(id: Int): Int = ContextCompat.getColor(context, id)

    fun string(id: Int, vararg args: Any): String = context.getString(id, *args)

    fun text(style: Style, value: CharSequence? = null): TextView = AppCompatTextView(context).apply {
        text = value
        setTextSize(TypedValue.COMPLEX_UNIT_SP, style.sp)
        if (style.bold) setTypeface(typeface, Typeface.BOLD)
        if (style.secondary) setTextColor(color(R.color.text_secondary))
        setLineSpacing(0f, 1.15f)
    }

    fun heading(style: Style, value: CharSequence): TextView = text(style, value).also {
        ViewCompat.setAccessibilityHeading(it, true)
    }

    /** Text whose changes TalkBack announces without moving focus. */
    fun liveText(style: Style = Style.BODY): TextView = text(style).also {
        it.accessibilityLiveRegion = View.ACCESSIBILITY_LIVE_REGION_POLITE
    }

    fun primaryButton(label: CharSequence): Button = AppCompatButton(context).apply {
        text = label
        isAllCaps = false
        setTextSize(TypedValue.COMPLEX_UNIT_SP, 16f)
        minHeight = dp(48)
        ViewCompat.setBackgroundTintList(this, ContextCompat.getColorStateList(context, R.color.button_primary_background))
        setTextColor(ContextCompat.getColorStateList(context, R.color.button_primary_text))
    }

    fun secondaryButton(label: CharSequence): Button = AppCompatButton(context).apply {
        text = label
        isAllCaps = false
        setTextSize(TypedValue.COMPLEX_UNIT_SP, 16f)
        minHeight = dp(48)
    }

    fun textButton(label: CharSequence): Button =
        AppCompatButton(context, null, androidx.appcompat.R.attr.borderlessButtonStyle).apply {
            text = label
            isAllCaps = false
            setTextSize(TypedValue.COMPLEX_UNIT_SP, 16f)
            minHeight = dp(48)
            minWidth = dp(48)
            setTextColor(color(R.color.brand_primary))
        }

    fun card(): LinearLayout = LinearLayout(context).apply {
        orientation = LinearLayout.VERTICAL
        setBackgroundResource(R.drawable.section_card)
        setPadding(dp(16), dp(4), dp(16), dp(16))
    }

    fun column(): LinearLayout = LinearLayout(context).apply { orientation = LinearLayout.VERTICAL }

    /** A tinted box for status text. Call [setTone] to change its color. */
    fun statusBox(): TextView = liveText().apply {
        setBackgroundResource(R.drawable.status_box)
        setPadding(dp(12), dp(10), dp(12), dp(10))
    }

    fun setTone(view: TextView, tone: Tone, tintBackground: Boolean = view.background != null) {
        val (fg, bg) = when (tone) {
            Tone.OK -> R.color.tone_ok to R.color.tone_ok_background
            Tone.WARNING -> R.color.tone_warning to R.color.tone_warning_background
            Tone.ERROR -> R.color.tone_error to R.color.tone_error_background
            Tone.NEUTRAL -> 0 to R.color.tone_neutral_background
        }
        if (fg == 0) {
            view.setTextColor(resolveTextColor(android.R.attr.textColorPrimary))
        } else {
            view.setTextColor(color(fg))
        }
        if (tintBackground) ViewCompat.setBackgroundTintList(view, ContextCompat.getColorStateList(context, bg))
    }

    fun progress(description: CharSequence): ProgressBar =
        ProgressBar(context, null, android.R.attr.progressBarStyleHorizontal).apply {
            isIndeterminate = true
            contentDescription = description
            visibility = View.GONE
        }

    fun chevron(): ImageView = ImageView(context).apply {
        setImageResource(R.drawable.ic_chevron)
        importantForAccessibility = View.IMPORTANT_FOR_ACCESSIBILITY_NO
    }

    fun field(id: Int, label: CharSequence, inputKind: InputKind, help: CharSequence? = null): Field {
        val container = column()
        val labelView = text(Style.SUBHEAD, label).apply { setPadding(0, dp(16), 0, dp(4)) }
        val input = AppCompatEditText(context).apply {
            this.id = id
            setTextSize(TypedValue.COMPLEX_UNIT_SP, 16f)
            minHeight = dp(48)
            inputType = inputKind.type
            // Secrets must not end up in the saved-instance-state bundle.
            if (inputKind == InputKind.SECRET) isSaveEnabled = false
            if (inputKind == InputKind.MULTILINE) {
                isSingleLine = false
                minLines = 2
                gravity = Gravity.TOP or Gravity.START
            } else {
                isSingleLine = true
            }
        }
        labelView.labelFor = id
        val message = liveText(Style.CAPTION).apply { setPadding(dp(4), dp(2), 0, 0) }
        container.addView(labelView)
        container.addView(input, matchWrap())
        container.addView(message, matchWrap())
        return Field(this, input, message, help)
    }

    private fun resolveTextColor(attr: Int): Int {
        val value = TypedValue()
        context.theme.resolveAttribute(attr, value, true)
        return if (value.resourceId != 0) ContextCompat.getColor(context, value.resourceId) else value.data
    }

    enum class InputKind(val type: Int) {
        URL(InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_URI),
        SECRET(InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_PASSWORD),
        NUMBER(InputType.TYPE_CLASS_NUMBER),
        MULTILINE(InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_FLAG_MULTI_LINE or InputType.TYPE_TEXT_FLAG_NO_SUGGESTIONS),
    }

    companion object {
        fun matchWrap(top: Int = 0) = LinearLayout.LayoutParams(
            ViewGroup.LayoutParams.MATCH_PARENT,
            ViewGroup.LayoutParams.WRAP_CONTENT,
        ).apply { topMargin = top }
    }
}

/** A labelled input with an inline help / error line, exposed to TalkBack as the field's error. */
class Field(
    private val kit: ViewKit,
    val input: EditText,
    private val message: TextView,
    private val help: CharSequence?,
) {
    var error: String? = null
        private set

    init {
        ViewCompat.setAccessibilityDelegate(input, object : AccessibilityDelegateCompat() {
            override fun onInitializeAccessibilityNodeInfo(host: View, info: AccessibilityNodeInfoCompat) {
                super.onInitializeAccessibilityNodeInfo(host, info)
                val current = error
                info.isContentInvalid = current != null
                info.error = current
                if (current == null && help != null) info.hintText = help
            }
        })
        showHelp()
    }

    val value: String get() = input.text?.toString().orEmpty()

    fun setValue(text: String) {
        input.setText(text)
    }

    fun onChange(block: () -> Unit) {
        input.doAfterTextChanged { block() }
    }

    /** Shows the result of [result]: an error blocks saving, a note is informational. */
    fun show(result: FieldResult<*>) {
        when (result) {
            is FieldResult.Invalid -> showError(result.message)
            is FieldResult.Valid<*> -> showHelp(result.note)
        }
    }

    fun showError(text: String) {
        error = text
        message.text = kit.string(R.string.field_error, text)
        message.visibility = View.VISIBLE
        kit.setTone(message, Tone.ERROR, tintBackground = false)
    }

    fun showHelp(note: String? = null) {
        error = null
        message.text = note ?: help
        message.visibility = if (message.text.isNullOrEmpty()) View.GONE else View.VISIBLE
        message.setTextColor(kit.color(R.color.text_secondary))
    }

    fun clearErrorIfAny() {
        if (error != null) showHelp()
    }
}

/** Replaces the spoken name of a view's click action, e.g. "雙擊以展開". */
fun View.setClickActionLabel(label: CharSequence) {
    ViewCompat.replaceAccessibilityAction(this, AccessibilityActionCompat.ACTION_CLICK, label) { view, _ ->
        view.performClick()
    }
}
