package tw.skyhong.infovore.health.main

import android.view.View
import android.widget.Button
import android.widget.LinearLayout
import android.widget.TextView
import tw.skyhong.infovore.health.R
import tw.skyhong.infovore.health.ReconcileGaps
import tw.skyhong.infovore.health.SyncRunner
import tw.skyhong.infovore.health.ui.CollapsibleSection
import tw.skyhong.infovore.health.ui.ReconcileStatus
import tw.skyhong.infovore.health.ui.ReconcileUi
import tw.skyhong.infovore.health.ui.Tone
import tw.skyhong.infovore.health.ui.ViewKit
import tw.skyhong.infovore.health.ui.ViewKit.Style
import java.time.Instant
import java.time.ZoneId

/**
 * The health section's persistent "history not fully re-verified" box: re-verification, and for
 * a deletion the server refused as too large, the user's explicit choice between confirming it
 * (two dialogs, then a fresh read; see [tw.skyhong.infovore.health.HealthSyncEngine.confirmDelete])
 * and keeping the server's rows (dismissing the reminder, deleting nothing).
 */
class ReconcileController(
    private val host: UiHost,
    /** Starts a re-verification through the health section (it checks the connection first). */
    private val startReverify: () -> Unit,
    /** The gaps changed outside a sync (dismissed or restored): the health section re-renders. */
    private val onChanged: () -> Unit,
) {
    private val kit = host.kit

    private lateinit var box: TextView
    private lateinit var refusals: LinearLayout
    private lateinit var reverifyButton: Button
    private lateinit var hint: TextView
    private lateinit var notice: TextView
    private lateinit var dismissedNote: TextView
    private lateinit var restoreButton: Button

    fun build(section: CollapsibleSection) {
        // Persistent until a re-verification completes; independent of the last sync's result.
        box = kit.statusBox().apply {
            visibility = View.GONE
            setTextIsSelectable(true)
        }
        section.add(box, 12)
        refusals = kit.column().apply { visibility = View.GONE }
        section.add(refusals, 4)
        reverifyButton = kit.secondaryButton(host.string(R.string.action_reverify)).apply {
            visibility = View.GONE
            setOnClickListener { startReverify() }
        }
        section.add(reverifyButton, 4)
        hint = kit.text(Style.CAPTION).apply {
            visibility = View.GONE
            setPadding(kit.dp(4), kit.dp(4), 0, 0)
        }
        section.add(hint)
        notice = kit.liveText(Style.CAPTION).apply {
            visibility = View.GONE
            setTextIsSelectable(true)
            setPadding(kit.dp(4), kit.dp(4), 0, 0)
        }
        section.add(notice)
        dismissedNote = kit.text(Style.CAPTION).apply {
            visibility = View.GONE
            setPadding(kit.dp(4), kit.dp(8), 0, 0)
        }
        section.add(dismissedNote)
        restoreButton = kit.textButton(host.string(R.string.reconcile_restore)).apply {
            visibility = View.GONE
            setOnClickListener { restoreAll() }
        }
        section.add(restoreButton)
    }

    /**
     * Shows the saved gaps; [syncReady]/[syncHint] say whether a full sync could start now.
     * [resultNotice] is the last re-verification or confirmed deletion's result. Returns the
     * box's state, or null when no (undismissed) gap is left.
     */
    fun render(syncReady: Boolean, syncHint: String?, resultNotice: String?): ReconcileUi? {
        val now = Instant.now()
        val zone = ZoneId.systemDefault()
        val gaps = ReconcileGaps.decode(host.settings.reconcileGapsText)
        val ui = ReconcileStatus.map(gaps, now, zone, syncReady = syncReady, syncHint = syncHint)
        box.visibility = if (ui == null) View.GONE else View.VISIBLE
        reverifyButton.visibility = box.visibility
        if (ui != null) {
            box.text = listOf(ui.headline, ui.detail).joinToString("\n")
            kit.setTone(box, Tone.WARNING)
            reverifyButton.isEnabled = ui.reverifyEnabled
        }
        hint.text = ui?.reverifyHint
        hint.visibility = if (ui?.reverifyHint == null) View.GONE else View.VISIBLE
        renderRefusals(ui)

        notice.text = resultNotice
        notice.visibility = if (resultNotice == null) View.GONE else View.VISIBLE

        val dismissed = ReconcileStatus.dismissed(gaps)
        dismissedNote.text = dismissed?.text
        dismissedNote.visibility = if (dismissed == null) View.GONE else View.VISIBLE
        restoreButton.visibility = dismissedNote.visibility
        restoreButton.isEnabled = !host.model.sync.value.busy
        return ui
    }

    private fun renderRefusals(ui: ReconcileUi?) {
        refusals.removeAllViews()
        val items = ui?.refusals.orEmpty()
        refusals.visibility = if (items.isEmpty()) View.GONE else View.VISIBLE
        for (item in items) {
            refusals.addView(kit.statusBox().apply {
                text = item.explanation
                kit.setTone(this, Tone.WARNING)
                accessibilityLiveRegion = View.ACCESSIBILITY_LIVE_REGION_NONE
            }, ViewKit.matchWrap(kit.dp(8)))
            item.confirmLabel?.let { label ->
                refusals.addView(kit.secondaryButton(label).apply {
                    isEnabled = item.confirmEnabled
                    setOnClickListener { confirmDelete(item.dataType, item.expected) }
                }, ViewKit.matchWrap(kit.dp(4)))
            }
            refusals.addView(kit.secondaryButton(item.ignoreLabel).apply {
                isEnabled = !host.model.sync.value.busy
                setOnClickListener { confirmIgnore(item.dataType) }
            }, ViewKit.matchWrap(kit.dp(4)))
        }
    }

    /** Two dialogs (what, then "cannot be undone"); only then is the deletion started. */
    private fun confirmDelete(dataType: String, expected: Int) {
        val gap = currentGap(dataType) ?: return onChanged()
        // The numbers on screen must still be the saved ones; otherwise show the new ones first.
        if (gap.refusal?.wouldDelete != expected) return onChanged()
        val zone = ZoneId.systemDefault()
        val (first, second) = ReconcileStatus.confirmDialogs(gap, zone, host.use24Hour) ?: return onChanged()
        host.confirm(first) {
            host.confirm(second) {
                if (!SyncRunner.startConfirmDelete(host.activity, dataType, expected)) {
                    host.toast(host.string(R.string.reconcile_busy))
                }
            }
        }
    }

    private fun confirmIgnore(dataType: String) {
        val gap = currentGap(dataType) ?: return onChanged()
        host.confirm(ReconcileStatus.ignoreDialog(gap, ZoneId.systemDefault(), host.use24Hour)) {
            if (!SyncRunner.dismissGap(host.activity, dataType)) host.toast(host.string(R.string.reconcile_busy))
            onChanged()
        }
    }

    private fun restoreAll() {
        val dismissed = ReconcileGaps.decode(host.settings.reconcileGapsText).filter { it.dismissed }
        for (gap in dismissed) {
            if (!SyncRunner.restoreGap(host.activity, gap.dataType)) {
                host.toast(host.string(R.string.reconcile_busy))
                break
            }
        }
        onChanged()
    }

    private fun currentGap(dataType: String) =
        ReconcileGaps.decode(host.settings.reconcileGapsText).firstOrNull { it.dataType == dataType && !it.dismissed }
}
