package tw.skyhong.infovore.health.ui

import android.content.Context
import android.graphics.Typeface
import android.text.InputType
import android.text.method.PasswordTransformationMethod
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
import androidx.appcompat.widget.AppCompatTextView
import androidx.appcompat.widget.SwitchCompat
import androidx.core.content.ContextCompat
import androidx.core.view.AccessibilityDelegateCompat
import androidx.core.view.ViewCompat
import androidx.core.view.accessibility.AccessibilityNodeInfoCompat
import androidx.core.view.accessibility.AccessibilityNodeInfoCompat.AccessibilityActionCompat
import androidx.core.widget.doAfterTextChanged
import com.google.android.material.button.MaterialButton
import com.google.android.material.materialswitch.MaterialSwitch
import com.google.android.material.progressindicator.LinearProgressIndicator
import com.google.android.material.textfield.TextInputEditText
import com.google.android.material.textfield.TextInputLayout
import tw.skyhong.infovore.health.R

/**
 * Small builder for the programmatic UI on Material 3: one type scale in sp, ≥48dp touch targets,
 * theme-aware colors (light and dark), and the accessibility semantics TalkBack needs.
 */
class ViewKit(private val context: Context) {
    enum class Style(val sp: Float, val weight: Weight, val secondary: Boolean) {
        TITLE(22f, Weight.BOLD, false),
        SECTION(18f, Weight.MEDIUM, false),
        /** A small label above a group of rows, e.g. "最近結果". */
        SUBHEAD(14f, Weight.MEDIUM, false),
        BODY(16f, Weight.REGULAR, false),
        CAPTION(14f, Weight.REGULAR, true),
    }

    enum class Weight { REGULAR, MEDIUM, BOLD }

    fun dp(value: Int): Int = TypedValue.applyDimension(
        TypedValue.COMPLEX_UNIT_DIP, value.toFloat(), context.resources.displayMetrics,
    ).toInt()

    fun color(id: Int): Int = ContextCompat.getColor(context, id)

    fun string(id: Int, vararg args: Any): String = context.getString(id, *args)

    fun text(style: Style, value: CharSequence? = null): TextView = KitTextView(context).apply {
        text = value
        setTextSize(TypedValue.COMPLEX_UNIT_SP, style.sp)
        when (style.weight) {
            Weight.REGULAR -> Unit
            Weight.MEDIUM -> typeface = medium
            Weight.BOLD -> typeface = Typeface.create(Typeface.DEFAULT, 700, false)
        }
        setTextColor(color(if (style.secondary) R.color.text_secondary else R.color.text_primary))
        setLineSpacing(0f, 1.2f)
    }

    /** Weight 500 by number, so the CJK font gets its Medium face too (a family name only reaches Roboto). */
    val medium: Typeface = Typeface.create(Typeface.DEFAULT, 500, false)

    /**
     * [first] in medium weight (in the box's tone color), then [rest] on the following lines in the
     * normal text color: only the headline carries the alarm, as in Material's error containers.
     */
    fun headlined(first: CharSequence, rest: CharSequence?, restColor: Int = R.color.text_primary): CharSequence {
        val text = android.text.SpannableStringBuilder(first)
        text.setSpan(android.text.style.TypefaceSpan(medium), 0, first.length, android.text.Spanned.SPAN_EXCLUSIVE_EXCLUSIVE)
        if (!rest.isNullOrEmpty()) {
            text.append("\n")
            val start = text.length
            text.append(rest)
            text.setSpan(android.text.style.ForegroundColorSpan(color(restColor)), start, text.length, android.text.Spanned.SPAN_EXCLUSIVE_EXCLUSIVE)
        }
        return text
    }

    /**
     * The shared label column of every "label   value" row (最近結果, 最近紀錄): as wide as the widest
     * label at the current font scale, so the values line up at any text size.
     */
    val labelColumnWidth: Int by lazy {
        val paint = text(Style.CAPTION).paint
        val widest = LABELS.maxOf { paint.measureText(context.getString(it)) }
        kotlin.math.ceil(widest).toInt() + dp(16)
    }

    /**
     * A "label   value" row. TalkBack reads it as one stop ("最後定位，剛剛…"): the row carries the
     * combined description (kept current as the value changes) and its children are hidden.
     */
    fun labelRow(label: String, value: TextView): LinearLayout = LabelRow(context, labelColumnWidth).apply {
        val labelView = text(Style.CAPTION, label).apply {
            setPadding(0, dp(2), 0, 0)
            importantForAccessibility = View.IMPORTANT_FOR_ACCESSIBILITY_NO
        }
        addView(labelView, LinearLayout.LayoutParams(labelColumnWidth, ViewGroup.LayoutParams.WRAP_CONTENT))
        addView(value, LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f))
        // The first line ("42 分鐘前（上午 3:31）") leads; the details under it are quieter.
        (value as? KitTextView)?.quietDetails = true
        value.text = value.text
        // A changing value is announced through the row, since the value itself is hidden.
        accessibilityLiveRegion = value.accessibilityLiveRegion
        value.accessibilityLiveRegion = View.ACCESSIBILITY_LIVE_REGION_NONE
        value.importantForAccessibility = View.IMPORTANT_FOR_ACCESSIBILITY_NO
        isFocusable = false
        ViewCompat.setScreenReaderFocusable(this, true)
        val describe = { contentDescription = "$label，${value.text.toString().replace(TimeText.WORD_JOINER, "")}" }
        value.doAfterTextChanged { describe() }
        describe()
    }

    fun heading(style: Style, value: CharSequence): TextView = text(style, value).also {
        ViewCompat.setAccessibilityHeading(it, true)
    }

    /** Text whose changes TalkBack announces without moving focus. */
    fun liveText(style: Style = Style.BODY): TextView = text(style).also {
        it.accessibilityLiveRegion = View.ACCESSIBILITY_LIVE_REGION_POLITE
    }

    /** The one main action of a group: a filled button. */
    fun primaryButton(label: CharSequence): Button =
        MaterialButton(context, null, R.attr.infovoreFilledButtonStyle).apply { text = label }

    /** A supporting action: a tonal button. */
    fun secondaryButton(label: CharSequence): Button =
        MaterialButton(context, null, R.attr.infovoreTonalButtonStyle).apply { text = label }

    /** An optional action that is never a fix (e.g. importing): outlined, below any tonal fix. */
    fun outlinedButton(label: CharSequence): Button =
        MaterialButton(context, null, R.attr.infovoreOutlinedButtonStyle).apply { text = label }

    /**
     * A low-emphasis action or link: a text button. [inline] ones sit in a column of text, so their
     * label starts at the text's left edge instead of Material's 12dp inner padding.
     */
    fun textButton(label: CharSequence, inline: Boolean = false, trailing: Boolean = false): Button =
        MaterialButton(context, null, R.attr.infovoreTextButtonStyle).apply {
            text = Clauses.keepTogether(label)
            if (inline) {
                gravity = Gravity.CENTER_VERTICAL or Gravity.START
                setPaddingRelative(0, paddingTop, dp(12), paddingBottom)
            } else if (trailing) {
                // At the end of a row: the label ends on the same edge as the switches and buttons.
                gravity = Gravity.CENTER_VERTICAL or Gravity.END
                setPaddingRelative(dp(12), paddingTop, 0, paddingBottom)
            }
        }

    /** Turns a filled button tonal (or back), e.g. when another filled button is the fix to do first. */
    fun setFilled(button: Button, filled: Boolean) {
        val disabled = intArrayOf(-android.R.attr.state_enabled)
        val disabledFill = androidx.core.graphics.ColorUtils.setAlphaComponent(color(R.color.text_primary), 31)
        val disabledText = androidx.core.graphics.ColorUtils.setAlphaComponent(color(R.color.text_primary), 97)
        val fill = color(if (filled) R.color.brand_primary else R.color.primary_container)
        val text = color(if (filled) R.color.on_primary else R.color.on_primary_container)
        val states = arrayOf(disabled, intArrayOf())
        ViewCompat.setBackgroundTintList(button, android.content.res.ColorStateList(states, intArrayOf(disabledFill, fill)))
        button.setTextColor(android.content.res.ColorStateList(states, intArrayOf(disabledText, text)))
    }

    fun switch(label: CharSequence): SwitchCompat = MaterialSwitch(context).apply {
        // A bracketed aside ("（較耗電）") is kept whole and may move to the next line as a unit.
        val aside = label.indexOf('（')
        text = if (aside > 0) {
            android.text.SpannableStringBuilder(Clauses.keepTogether(label.subSequence(0, aside))).append(Clauses.keepTogether(label.subSequence(aside, label.length)))
        } else {
            Clauses.keepTogether(label)
        }
        setTextSize(TypedValue.COMPLEX_UNIT_SP, 16f)
        // The label dims with the switch when it is inactive (Material's 38% disabled content).
        val primary = color(R.color.text_primary)
        setTextColor(android.content.res.ColorStateList(
            arrayOf(intArrayOf(-android.R.attr.state_enabled), intArrayOf()),
            intArrayOf(androidx.core.graphics.ColorUtils.setAlphaComponent(primary, 97), primary),
        ))
        minHeight = dp(48)
        switchPadding = dp(16)
    }

    fun card(): LinearLayout = LinearLayout(context).apply {
        orientation = LinearLayout.VERTICAL
        setBackgroundResource(R.drawable.section_card)
        setPadding(dp(20), dp(8), dp(20), dp(20))
    }

    /** A hairline between two groups inside a card. */
    fun divider(): View = object : View(context) {
        // Always 1dp tall, whatever the parent's height spec (sections add rows as wrap-content).
        override fun onMeasure(widthMeasureSpec: Int, heightMeasureSpec: Int) =
            setMeasuredDimension(MeasureSpec.getSize(widthMeasureSpec), dp(1))
    }.apply {
        setBackgroundColor(color(R.color.outline_variant))
        importantForAccessibility = View.IMPORTANT_FOR_ACCESSIBILITY_NO
    }

    fun column(): LinearLayout = LinearLayout(context).apply { orientation = LinearLayout.VERTICAL }

    /**
     * Buttons side by side, equal width; stacked full width when a label would not fit on one line
     * (very large text).
     */
    fun buttonRow(vararg buttons: Button): LinearLayout = ButtonRow(context, dp(8), equal = true).apply {
        for (button in buttons) addView(button)
        mainAction = buttons.last()
    }

    /** Inline links in a row, stacked under each other when they would not fit (very large text). */
    fun linkRow(vararg links: Button): LinearLayout = ButtonRow(context, dp(12), equal = false).apply {
        for (link in links) addView(link)
    }

    fun row(): LinearLayout = LinearLayout(context).apply {
        orientation = LinearLayout.HORIZONTAL
        gravity = Gravity.CENTER_VERTICAL
    }

    /** A tinted box for status text. Call [setTone] to change its color. */
    fun statusBox(): TextView = liveText().apply {
        setBackgroundResource(R.drawable.status_box)
        setPadding(dp(16), dp(12), dp(16), dp(12))
    }

    /** A small status dot; [setDotTone] colors it. */
    fun dot(): ImageView = ImageView(context).apply {
        setImageResource(R.drawable.dot)
        importantForAccessibility = View.IMPORTANT_FOR_ACCESSIBILITY_NO
    }

    fun setDotTone(view: ImageView, tone: Tone) {
        // A quiet dot is dimmer than the live colors, so green/amber/red stay the brightest marks.
        view.imageTintList = ContextCompat.getColorStateList(context, if (tone == Tone.NEUTRAL) R.color.outline else toneColor(tone))
    }

    fun toneColor(tone: Tone): Int = when (tone) {
        Tone.OK -> R.color.tone_ok
        Tone.WARNING -> R.color.tone_warning
        Tone.ERROR -> R.color.tone_error
        Tone.NEUTRAL -> R.color.text_secondary
    }

    fun setTone(view: TextView, tone: Tone, tintBackground: Boolean = view.background != null) {
        val (fg, bg) = when (tone) {
            Tone.OK -> R.color.tone_ok to R.color.tone_ok_background
            Tone.WARNING -> R.color.tone_warning to R.color.tone_warning_background
            Tone.ERROR -> R.color.tone_error to R.color.tone_error_background
            Tone.NEUTRAL -> R.color.text_primary to R.color.tone_neutral_background
        }
        view.setTextColor(color(fg))
        if (tintBackground) {
            ViewCompat.setBackgroundTintList(view, ContextCompat.getColorStateList(context, bg))
            // A box that warns also says so in shape, not only in color (the icon is decorative:
            // the headline carries the meaning for TalkBack).
            val icon = when (tone) {
                Tone.WARNING -> R.drawable.ic_box_warning
                Tone.ERROR -> R.drawable.ic_box_error
                else -> null
            }
            (view as? KitTextView)?.setLeadingIcon(icon?.let {
                ContextCompat.getDrawable(context, it)!!.mutate().apply { setTint(color(fg)) }
            })
        }
    }

    fun progress(description: CharSequence): ProgressBar = LinearProgressIndicator(context).apply {
        isIndeterminate = true
        contentDescription = description
        trackCornerRadius = dp(2)
        visibility = View.GONE
    }

    fun chevron(): ImageView = ImageView(context).apply {
        setImageResource(R.drawable.ic_chevron)
        importantForAccessibility = View.IMPORTANT_FOR_ACCESSIBILITY_NO
    }

    /**
     * An outlined Material text field: [label] floats in the outline, [help] and errors show
     * underneath. Secrets are masked with a show/hide toggle.
     */
    fun field(id: Int, label: CharSequence, inputKind: InputKind, help: CharSequence? = null): Field {
        val layout = TextInputLayout(context, null, R.attr.infovoreOutlinedFieldStyle).apply {
            hint = label
            if (inputKind == InputKind.SECRET) endIconMode = TextInputLayout.END_ICON_PASSWORD_TOGGLE
            // The red outline and message carry the error; the icon would replace the show/hide toggle.
            errorIconDrawable = null
            // Every label sits in the outline, empty or not, so the three fields look alike.
            isExpandedHintEnabled = false
        }
        val input = TextInputEditText(layout.context).apply {
            this.id = id
            setTextSize(TypedValue.COMPLEX_UNIT_SP, 16f)
            inputType = inputKind.type
            if (inputKind == InputKind.MULTILINE) {
                isSingleLine = false
                minLines = 2
                gravity = Gravity.TOP or Gravity.START
            } else {
                isSingleLine = true
            }
            // setSingleLine replaces the transformation; a secret must stay masked.
            if (inputKind == InputKind.SECRET) {
                transformationMethod = PasswordTransformationMethod.getInstance()
                // The password input type switches to monospace; keep the app's font.
                typeface = Typeface.DEFAULT
                // Secrets must not end up in the saved-instance-state bundle.
                isSaveEnabled = false
            }
            minimumHeight = dp(56)
        }
        layout.addView(input, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT))
        return Field(this, layout, input, help)
    }

    enum class InputKind(val type: Int) {
        URL(InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_URI),
        SECRET(InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_PASSWORD),
        NUMBER(InputType.TYPE_CLASS_NUMBER),
        MULTILINE(InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_FLAG_MULTI_LINE or InputType.TYPE_TEXT_FLAG_NO_SUGGESTIONS),
    }

    companion object {
        /** Every label shown in a [labelRow]. */
        private val LABELS = listOf(
            R.string.result_full_sync, R.string.result_sleep,
            R.string.location_label_fix, R.string.location_label_queue, R.string.location_label_upload,
        )

        fun matchWrap(top: Int = 0) = LinearLayout.LayoutParams(
            ViewGroup.LayoutParams.MATCH_PARENT,
            ViewGroup.LayoutParams.WRAP_CONTENT,
        ).apply { topMargin = top }
    }
}

/** A labelled outlined input with its help / error line, exposed to TalkBack as the field's error. */
class Field(
    private val kit: ViewKit,
    val layout: TextInputLayout,
    val input: EditText,
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
                info.hintText = listOfNotNull(layout.hint, if (current == null) help else null).joinToString("，")
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
        // Otherwise the hidden helper keeps its height and the spacing below the field changes.
        layout.helperText = null
        layout.error = text
    }

    fun showHelp(note: String? = null) {
        error = null
        layout.error = null
        layout.isErrorEnabled = false
        layout.helperText = note ?: help
    }

    fun clearErrorIfAny() {
        if (error != null) showHelp()
    }
}

/**
 * The kit's text view. zh-TW text wraps between clauses (after ，；。 and the like), not inside a
 * word such as 健康 or 備份, sized to the line it actually gets; a " · " list that does not fit one
 * line breaks between items without a dangling "·". With [quietDetails], the lines after the
 * first are in the caption size and color.
 */
class KitTextView(context: Context) : AppCompatTextView(context) {
    init {
        // Greedy: lines fill up to the last allowed break (the clause and word rules decide where
        // breaks are allowed); the default "balanced" strategy would leave short first lines.
        breakStrategy = android.graphics.text.LineBreaker.BREAK_STRATEGY_SIMPLE
    }

    var quietDetails = false
    private var leadingIcon: android.graphics.drawable.Drawable? = null
    private val iconGap = (10 * context.resources.displayMetrics.density).toInt()
    private var raw: CharSequence? = null
    private var rawType: BufferType = BufferType.NORMAL
    private var laidOutFor = -1

    override fun setText(text: CharSequence?, type: BufferType?) {
        raw = text
        rawType = type ?: BufferType.NORMAL
        // Already laid out: arrange for the current width now. A change that keeps the height does
        // not measure the view again, so onMeasure would not get the chance.
        val known = (width - compoundPaddingLeft - compoundPaddingRight).takeIf { width > 0 && it > 0 }
        laidOutFor = known ?: -1
        super.setText(text?.let { arrange(it, known) }, type)
    }

    override fun onMeasure(widthMeasureSpec: Int, heightMeasureSpec: Int) {
        val text = raw
        if (text != null && MeasureSpec.getMode(widthMeasureSpec) != MeasureSpec.UNSPECIFIED) {
            val available = MeasureSpec.getSize(widthMeasureSpec) - compoundPaddingLeft - compoundPaddingRight
            if (available > 0 && available != laidOutFor) {
                laidOutFor = available
                super.setText(arrange(text, available), rawType)
            }
        }
        super.onMeasure(widthMeasureSpec, heightMeasureSpec)
    }

    // A cached measurement can skip onMeasure: the final size is checked once more here.
    override fun onSizeChanged(w: Int, h: Int, oldw: Int, oldh: Int) {
        super.onSizeChanged(w, h, oldw, oldh)
        val text = raw ?: return
        val available = w - compoundPaddingLeft - compoundPaddingRight
        if (available > 0 && available != laidOutFor) {
            laidOutFor = available
            super.setText(arrange(text, available), rawType)
        }
    }

    /**
     * An icon at the start of the first line (e.g. a status box's warning sign); the text wraps
     * with a hanging indent, so every line starts after the icon.
     */
    fun setLeadingIcon(icon: android.graphics.drawable.Drawable?) {
        if (icon == leadingIcon) return
        leadingIcon = icon?.apply {
            val size = (textSize * 1.15f).toInt()
            setBounds(0, 0, size, size)
        }
        raw?.let { setText(it, rawType) }
    }

    private fun arrange(text: CharSequence, width: Int?): CharSequence {
        val icon = leadingIcon
        val indent = if (icon == null) 0 else icon.bounds.width() + iconGap
        val textWidth = width?.minus(indent)
        val styled = if (quietDetails) quiet(text) else text
        val listed = if (textWidth == null) styled else breakAsides(breakLists(breakAtSemicolon(styled, textWidth), textWidth), textWidth)
        val limit = if (textWidth == null) Clauses.DEFAULT_LIMIT else textWidth / textSize - 0.5f
        val arranged = Clauses.keepTogether(listed, limit)
        if (icon == null) return arranged
        val out = android.text.SpannableStringBuilder("\uFFFC").append(arranged)
        // Decorative: the words carry the meaning; the gap after the icon is part of its span.
        val iconSpan = object : android.text.style.ImageSpan(icon, android.text.style.DynamicDrawableSpan.ALIGN_CENTER) {
            override fun getSize(paint: android.graphics.Paint, text: CharSequence?, start: Int, end: Int, fm: android.graphics.Paint.FontMetricsInt?): Int =
                super.getSize(paint, text, start, end, fm) + iconGap
        }
        out.setSpan(iconSpan, 0, 1, android.text.Spanned.SPAN_EXCLUSIVE_EXCLUSIVE)
        var start = 0
        while (start < out.length) {
            val end = out.indexOf('\n', start).let { if (it < 0) out.length else it + 1 }
            val margin = if (start == 0) android.text.style.LeadingMarginSpan.Standard(0, indent) else android.text.style.LeadingMarginSpan.Standard(indent)
            out.setSpan(margin, start, end, android.text.Spanned.SPAN_PARAGRAPH)
            start = end
        }
        return out
    }

    /**
     * A paragraph "a；b" too wide for one line, whose second clause fits a line: break right after
     * "；", so each clause reads whole ("…3 次後通知；" / "同步成功後自動清除。").
     */
    private fun breakAtSemicolon(text: CharSequence, width: Int): CharSequence {
        val at = text.indexOf('；')
        if (at < 0 || at == text.length - 1 || text.contains('\n')) return text
        val avail = width - textSize / 2
        if (paint.measureText(text, 0, text.length) <= avail) return text
        if (paint.measureText(text, at + 1, text.length) > avail) return text
        return android.text.SpannableStringBuilder(text).insert(at + 1, "\n")
    }

    /** A line "a · b · c" too wide for [width]: as many items per line as fit, no "·" at a line end. */
    private fun breakLists(text: CharSequence, width: Int): CharSequence {
        if (!text.contains(" · ")) return text
        val breaks = mutableListOf<Int>()
        var lineStart = 0
        var lineIndex = 0
        while (true) {
            val newline = text.indexOf('\n', lineStart)
            val lineEnd = if (newline < 0) text.length else newline
            val scale = if (quietDetails && lineIndex > 0) 14f / 16f else 1f
            // Half a character of slack: the layout breaks a hair earlier than measureText suggests.
            fun fits(from: Int, to: Int) = paint.measureText(text, from, to) * scale <= width - textSize / 2
            if (!fits(lineStart, lineEnd)) {
                val separators = mutableListOf<Int>()
                var at = text.indexOf(" · ", lineStart)
                while (at in lineStart until lineEnd) {
                    separators += at
                    at = text.indexOf(" · ", at + 3)
                }
                var from = lineStart
                var lastFit = -1
                for (end in separators + lineEnd) {
                    if (fits(from, end)) {
                        lastFit = end
                        continue
                    }
                    if (lastFit >= 0) {
                        breaks += lastFit
                        from = lastFit + 3
                        lastFit = -1
                        if (fits(from, end)) {
                            lastFit = end
                            continue
                        }
                    }
                    // One item wider than the line: it wraps on its own; the next starts a line.
                    if (end != lineEnd) {
                        breaks += end
                        from = end + 3
                    }
                }
            }
            if (newline < 0) break
            lineStart = newline + 1
            lineIndex++
        }
        if (breaks.isEmpty()) return text
        val out = android.text.SpannableStringBuilder(text)
        for (at in breaks.distinct().sortedDescending()) out.replace(at, at + 3, "\n")
        return out
    }

    /** A line ending in "（…）" (e.g. "7 小時前（昨天 下午 9:52）") that is too wide: the aside moves whole to the next line. */
    private fun breakAsides(text: CharSequence, width: Int): CharSequence {
        if (!text.contains('（')) return text
        val out = android.text.SpannableStringBuilder(text)
        var lineEnd = out.length
        var lineIndex = out.count { it == '\n' }
        while (lineEnd >= 0) {
            val lineStart = out.lastIndexOf('\n', lineEnd - 1).let { if (it < 0) 0 else it + 1 }
            val scale = if (quietDetails && lineIndex > 0) 14f / 16f else 1f
            var close = lineEnd - 1
            if (close >= lineStart && out[close] == '）' && paint.measureText(out, lineStart, lineEnd) * scale > width) {
                val open = out.lastIndexOf('（', close).takeIf { it > lineStart }
                if (open != null) {
                    // The whole "（…）" moves to its own line, same style, so every row of a table
                    // keeps one format (it never breaks inside).
                    out.insert(open, "\n")
                }
            }
            if (lineStart == 0) break
            lineEnd = lineStart - 1
            lineIndex--
        }
        return out
    }

    private fun quiet(text: CharSequence): CharSequence {
        val firstBreak = text.indexOf('\n')
        if (firstBreak < 0) return text
        val out = android.text.SpannableString(text)
        val start = firstBreak + 1
        out.setSpan(android.text.style.RelativeSizeSpan(14f / 16f), start, out.length, android.text.Spanned.SPAN_EXCLUSIVE_EXCLUSIVE)
        // A line that carries its own color (a failure, a warning) keeps it.
        if (out.getSpans(start, out.length, android.text.style.ForegroundColorSpan::class.java).isEmpty()) {
            out.setSpan(
                android.text.style.ForegroundColorSpan(ContextCompat.getColor(context, R.color.text_secondary)),
                start, out.length, android.text.Spanned.SPAN_EXCLUSIVE_EXCLUSIVE,
            )
        }
        return out
    }
}

/**
 * Keeps CJK words together with word joiners (invisible, not spoken), so lines end at punctuation
 * instead of inside a word such as 健康. A clause that fits a line ([limit], in CJK characters)
 * stays whole; a longer one may also break at the spaces around Latin words ("Wi-Fi", "Keystore").
 */
object Clauses {
    private const val BREAK_AFTER = "，；。：！？"
    /** Weak breaks: a clause ending here stays with the next one when both fit a line. */
    private const val MINOR = "，"
    /** Used before the line width is known. */
    const val DEFAULT_LIMIT = 16f
    /** A clause this short ("允許後，") joins the next one when both fit a line, so it is not a line of its own. */
    private const val SHORT = 4f
    /** Width (in CJK characters) kept together at the end of a long run. */
    private const val TAIL = 4f
    /** Clauses up to this share of a line are never split. */
    private const val WHOLE = 0.75f

    private fun isWide(c: Char) = c in '\u2e80'..'\u9fff' || c in '\uff00'..'\uffef' || c in '\u3000'..'\u303f'
    private fun weight(text: CharSequence, from: Int, to: Int): Float =
        (from until to).sumOf { if (isWide(text[it])) 1.0 else 0.55 }.toFloat()

    fun keepTogether(text: CharSequence, limit: Float = DEFAULT_LIMIT): CharSequence {
        if (text.none(::isWide)) return text
        // Clauses: split after punctuation and at line breaks.
        val clauses = mutableListOf<IntRange>()
        var start = 0
        for (i in text.indices) {
            val c = text[i]
            if (c == '\n') {
                if (i > start) clauses += start until i
                clauses += i until i // a hard break: never merged across
                start = i + 1
            } else if (c in BREAK_AFTER) {
                clauses += start until i + 1
                start = i + 1
            }
        }
        if (start < text.length) clauses += start until text.length
        // Merge a very short clause into the next when together they still fit; a clause after a
        // comma also joins the next one when both fit a line, so lines prefer to end at "；" / "。".
        val merged = mutableListOf<IntRange>()
        val wholeLine = mutableSetOf<IntRange>()
        var i = 0
        while (i < clauses.size) {
            var range = clauses[i]
            while (true) {
                val next = clauses.getOrNull(i + 1) ?: break
                if (range.isEmpty() || next.isEmpty() || next.first != range.last + 1) break
                if (text[range.last] !in MINOR || weight(text, range.first, next.last + 1) > limit) break
                range = range.first..next.last
                wholeLine += range
                i++
            }
            val next = clauses.getOrNull(i + 1)
            // (When together they are too long, the merged clause breaks at a word inside the second.)
            if (!range.isEmpty() && next != null && !next.isEmpty() && next.first == range.last + 1 &&
                weight(text, range.first, range.last + 1) < SHORT
            ) {
                range = range.first..next.last
                i++
            }
            merged += range
            i++
        }
        // Marks where joiners go, then inserts them from the end so the spans keep their places.
        val joins = mutableListOf<Int>()
        fun join(from: Int, to: Int) {
            if (to - from < 2 || (from until to).any { text[it] == TimeText.WORD_JOINER[0] }) return
            for (k in from + 1 until to) joins += k
        }
        for (range in merged) {
            if (range.isEmpty()) continue
            val from = range.first
            val to = range.last + 1
            // Short clauses stay whole; longer ones keep their words whole and fill the line, so a
            // note is not a stack of half-empty lines.
            if (weight(text, from, to) <= limit * WHOLE || (range in wholeLine && weight(text, from, to) <= limit)) {
                join(from, to)
            } else {
                // A number stays with the unit after it ("3 次", "18 小時"): no break at that space.
                // (Only forwards: joining both sides would chain a whole clause into one unbreakable run.)
                for (k in from + 1 until to - 1) {
                    // "約 18": the approximation stays with its number too.
                    if (text[k] == ' ' && ((text[k - 1].isDigit() && isWide(text[k + 1])) || (text[k - 1] == '約' && text[k + 1].isDigit()))) {
                        joins += k
                        joins += k + 1
                    }
                }
                // Too long for one line: keep each word (between spaces) whole where it fits, and
                // a long run's last characters together, so its last line is never one character.
                var wordStart = from
                for (k in from..to) {
                    if (k == to || text[k] == ' ') {
                        if (k > wordStart && weight(text, wordStart, k) <= limit * WHOLE) {
                            join(wordStart, k)
                        } else if (k - wordStart > 1) {
                            // Longer than a line: keep each dictionary word (繼續, 記錄) whole.
                            val words = android.icu.text.BreakIterator.getWordInstance(android.icu.util.ULocale.TRADITIONAL_CHINESE)
                            words.setText(text.substring(wordStart, k))
                            val bounds = mutableListOf(words.first())
                            while (true) {
                                val next = words.next()
                                if (next == android.icu.text.BreakIterator.DONE) break
                                bounds += next
                            }
                            for (w in 0 until bounds.size - 1) join(wordStart + bounds[w], wordStart + bounds[w + 1])
                            // A word ending in 的 stays with the noun it modifies ("你的伺服器").
                            for (w in 1 until bounds.size - 1) {
                                if (text[wordStart + bounds[w] - 1] == '的') join(wordStart + bounds[w - 1], wordStart + bounds[w + 1])
                            }
                            // The run's last words stay together (≥ TAIL wide), so a line never ends a
                            // paragraph with one or two characters ("不中斷。", "自動清除。").
                            val runEnd = wordStart + bounds.last()
                            var tailStart = bounds.size - 2
                            while (tailStart > 0 && weight(text, wordStart + bounds[tailStart], runEnd) < TAIL) tailStart--
                            if (tailStart > 0) join(wordStart + bounds[tailStart], runEnd)
                        }
                        wordStart = k + 1
                    }
                }
            }
        }
        if (joins.isEmpty()) return text
        val out = android.text.SpannableStringBuilder(text)
        for (k in joins.distinct().sorted().asReversed()) {
            if (out[k] == ' ') out.replace(k, k + 1, "\u00A0")
            if (out[k - 1] == ' ') out.replace(k - 1, k, "\u00A0")
            out.insert(k, TimeText.WORD_JOINER)
        }
        return out
    }
}

/**
 * Buttons side by side; stacked when a label would not fit on one line (very large text).
 * [equal]: equal widths (action buttons); otherwise each as wide as its label, [gap] apart (links).
 */
private class ButtonRow(context: Context, private val gap: Int, private val equal: Boolean) : LinearLayout(context) {
    private var arrangedInline: Boolean? = null
    /** The row's main action: the last one passed in. */
    var mainAction: View? = null

    init {
        orientation = HORIZONTAL
    }

    override fun onMeasure(widthMeasureSpec: Int, heightMeasureSpec: Int) {
        val shown = (0 until childCount).map(::getChildAt).filter { it.visibility != View.GONE }
        if (shown.isNotEmpty() && MeasureSpec.getMode(widthMeasureSpec) != MeasureSpec.UNSPECIFIED) {
            val available = MeasureSpec.getSize(widthMeasureSpec) - paddingLeft - paddingRight
            val unbounded = MeasureSpec.makeMeasureSpec(0, MeasureSpec.UNSPECIFIED)
            shown.forEach { it.measure(unbounded, unbounded) }
            val fits = if (equal) {
                val share = (available - gap * (shown.size - 1)) / shown.size
                shown.all { it.measuredWidth <= share }
            } else {
                shown.sumOf { it.measuredWidth } + gap * (shown.size - 1) <= available
            }
            if (fits != arrangedInline) {
                arrangedInline = fits
                orientation = if (fits) HORIZONTAL else VERTICAL
                // Side by side the main action is last (on the right); stacked it comes first.
                if (equal && childCount > 1 && (fits == (getChildAt(0) === mainAction))) {
                    val children = (0 until childCount).map(::getChildAt)
                    removeAllViews()
                    children.asReversed().forEach(::addView)
                }
                // Margins by position in the (possibly reordered) row.
                val ordered = (0 until childCount).map(::getChildAt).filter { it.visibility != View.GONE }
                ordered.forEachIndexed { index, child ->
                    child.layoutParams = when {
                        !fits -> LayoutParams(if (equal) LayoutParams.MATCH_PARENT else LayoutParams.WRAP_CONTENT, LayoutParams.WRAP_CONTENT)
                            .apply { if (equal && index > 0) topMargin = gap }
                        equal -> LayoutParams(0, LayoutParams.WRAP_CONTENT, 1f).apply { if (index > 0) marginStart = gap }
                        else -> LayoutParams(LayoutParams.WRAP_CONTENT, LayoutParams.WRAP_CONTENT).apply { if (index > 0) marginStart = gap }
                    }
                }
            }
        }
        super.onMeasure(widthMeasureSpec, heightMeasureSpec)
    }
}

/** A label/value row that stacks the label above the value when the label column would crowd it (very large text). */
private class LabelRow(context: Context, private val labelWidth: Int) : LinearLayout(context) {
    private val dp6 = (6 * context.resources.displayMetrics.density).toInt()
    init {
        orientation = HORIZONTAL
        gravity = Gravity.TOP
    }

    override fun onMeasure(widthMeasureSpec: Int, heightMeasureSpec: Int) {
        if (childCount == 2 && MeasureSpec.getMode(widthMeasureSpec) != MeasureSpec.UNSPECIFIED) {
            val available = MeasureSpec.getSize(widthMeasureSpec) - paddingLeft - paddingRight
            val stack = labelWidth > available / 3
            val wanted = if (stack) VERTICAL else HORIZONTAL
            if (orientation != wanted) {
                orientation = wanted
                // Stacked rows: a little air above each label, so label/value pairs read as pairs.
                setPadding(paddingLeft, if (stack) dp6 else 0, paddingRight, paddingBottom)
                getChildAt(0).layoutParams = if (stack) LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.WRAP_CONTENT) else LayoutParams(labelWidth, LayoutParams.WRAP_CONTENT)
                getChildAt(1).layoutParams = if (stack) LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.WRAP_CONTENT) else LayoutParams(0, LayoutParams.WRAP_CONTENT, 1f)
            }
        }
        super.onMeasure(widthMeasureSpec, heightMeasureSpec)
    }
}

/** Replaces the spoken name of a view's click action, e.g. "雙擊以展開". */
fun View.setClickActionLabel(label: CharSequence) {
    ViewCompat.replaceAccessibilityAction(this, AccessibilityActionCompat.ACTION_CLICK, label) { view, _ ->
        view.performClick()
    }
}
