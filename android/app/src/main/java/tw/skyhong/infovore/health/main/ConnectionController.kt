package tw.skyhong.infovore.health.main

import android.view.View
import android.widget.TextView
import androidx.appcompat.app.AlertDialog
import androidx.core.net.toUri
import tw.skyhong.infovore.health.DestinationChange
import tw.skyhong.infovore.health.R
import tw.skyhong.infovore.health.SecureSettings
import tw.skyhong.infovore.health.SyncRunner
import tw.skyhong.infovore.health.screen.ObservationQueue
import tw.skyhong.infovore.health.screen.ScreenUploader
import tw.skyhong.infovore.health.ui.CollapsibleSection
import tw.skyhong.infovore.health.ui.ConnectionSummary
import tw.skyhong.infovore.health.ui.Field
import tw.skyhong.infovore.health.ui.FieldResult
import tw.skyhong.infovore.health.ui.FormState
import tw.skyhong.infovore.health.ui.InputValidation
import tw.skyhong.infovore.health.ui.SaveState
import tw.skyhong.infovore.health.ui.SecretDrafts
import tw.skyhong.infovore.health.ui.Tone
import tw.skyhong.infovore.health.ui.ViewKit
import tw.skyhong.infovore.health.ui.ViewKit.Style
import tw.skyhong.infovore.health.ui.isValid
import tw.skyhong.infovore.health.ui.valueOrNull
import java.time.Instant

/**
 * The connection section: endpoint, Health Connect token and history window, their validation
 * and saving, including the confirmed sync-destination change (see [DestinationChange]).
 */
class ConnectionController(
    private val host: UiHost,
    private val screen: ScreenController,
    /** Whether the Health Connect history permission is granted (for the re-import window). */
    private val historyPermissionGranted: () -> Boolean,
    /** A field changed: the health section re-checks whether syncing may start. */
    private val onEdited: () -> Unit,
    /** Settings were written: everything re-renders. */
    private val onSaved: () -> Unit,
    /** Unsaved edits changed: the activity re-evaluates its back handling. */
    private val onDirtyChanged: () -> Unit,
) {
    enum class SaveResult { SAVED, INVALID, AWAITING_CONFIRMATION, BLOCKED }

    private enum class ResetKind { QUIET, REIMPORT }

    private val kit = host.kit
    private val settings = host.settings
    private val model = host.model

    lateinit var section: CollapsibleSection
        private set
    private lateinit var endpointField: Field
    private lateinit var tokenField: Field
    private lateinit var historyDaysField: Field
    private lateinit var saveState: TextView

    private var justSaved = false

    /** The last save changed the sync destination, so the next full sync re-imports this many days. */
    private var reimportDaysAfterSave: Int? = null

    // Decrypted once and refreshed on save, so typing never triggers a Keystore operation per keystroke.
    private var savedHealthToken = settings.token

    fun build(expanded: Boolean?): CollapsibleSection {
        section = CollapsibleSection(kit, host.string(R.string.section_connection), expanded ?: !savedReady())
        endpointField = kit.field(
            R.id.endpoint_input, host.string(R.string.label_endpoint), ViewKit.InputKind.URL, host.string(R.string.help_endpoint),
        ).apply { input.hint = SecureSettings.DEFAULT_ENDPOINT }
        tokenField = kit.field(
            R.id.token_input, host.string(R.string.label_health_token), ViewKit.InputKind.SECRET, host.string(R.string.help_health_token),
        )
        historyDaysField = kit.field(
            R.id.history_days_input,
            host.string(R.string.label_history_days, SecureSettings.MAX_HISTORY_DAYS),
            ViewKit.InputKind.NUMBER,
            host.string(R.string.help_history_days, SecureSettings.DEFAULT_HISTORY_DAYS),
        )
        endpointField.setValue(settings.endpoint)
        // Unsaved token edits come back from the ViewModel after a rotation; never from the Bundle.
        tokenField.setValue(model.drafts.valueOr(SecretDrafts.Key.HEALTH_TOKEN, savedHealthToken))
        historyDaysField.setValue(settings.historyDays.toString())
        for (field in listOf(endpointField, tokenField, historyDaysField)) {
            section.add(field.input.parent as View)
            field.onChange {
                justSaved = false
                reimportDaysAfterSave = null
                if (field == tokenField) model.drafts.update(SecretDrafts.Key.HEALTH_TOKEN, field.value, savedHealthToken)
                field.clearErrorIfAny()
                if (field == endpointField) showEndpointNote()
                render()
                onEdited()
            }
            field.input.setOnFocusChangeListener { _, focused ->
                if (!focused && field.value.isNotBlank()) field.show(validate(field))
            }
        }
        section.add(kit.primaryButton(host.string(R.string.action_save_connection)).apply {
            setOnClickListener { save(showSuccess = true) }
        }, 16)
        saveState = kit.liveText(Style.CAPTION).apply { setPadding(kit.dp(4), kit.dp(8), 0, 0) }
        section.add(saveState)
        return section
    }

    private fun validate(field: Field): FieldResult<*> = when (field) {
        endpointField -> endpointResult()
        tokenField -> InputValidation.token(field.value, "HEALTH_CONNECT_TOKEN", required = true)
        historyDaysField -> InputValidation.historyDays(field.value)
        else -> FieldResult.Valid(field.value)
    }

    fun dirty(): Boolean =
        endpointField.value.trim().trimEnd('/') != settings.endpoint ||
            tokenField.value.trim() != savedHealthToken ||
            historyDaysField.value.trim() != settings.historyDays.toString()

    fun savedReady(): Boolean =
        InputValidation.endpoint(settings.endpoint).isValid &&
            InputValidation.token(savedHealthToken, "token", required = true).isValid

    /** Expands the section and focuses the first invalid field (the token when all are valid). */
    fun focusFirstInvalid() {
        section.setExpanded(true)
        val target = listOf(endpointField, tokenField, historyDaysField).firstOrNull { !validate(it).isValid } ?: tokenField
        host.focusField(target)
    }

    /** Endpoint validation plus a note when the edit points to a new sync destination. */
    private fun endpointResult(): FieldResult<String> {
        val result = InputValidation.endpoint(endpointField.value)
        val note = (result as? FieldResult.Valid)?.let {
            DestinationChange.fieldNote(settings.endpoint, it.value, destinationTies())
        }
        return if (result is FieldResult.Valid && note != null) result.copy(note = note) else result
    }

    /** Shows or hides the new-destination note while typing; errors still wait for the field to lose focus. */
    private fun showEndpointNote() {
        val result = endpointResult()
        if (result is FieldResult.Valid) endpointField.show(result)
    }

    /**
     * Validates every connection field and saves them when all are valid. Changing the sync
     * destination after a sync first asks for confirmation (the next sync re-imports history);
     * [afterConfirmedSave] runs once that confirmed save succeeds.
     */
    fun save(showSuccess: Boolean, afterConfirmedSave: () -> Unit = {}): SaveResult {
        val endpoint = endpointResult()
        val token = InputValidation.token(tokenField.value, "HEALTH_CONNECT_TOKEN", required = true)
        val days = InputValidation.historyDays(historyDaysField.value)
        endpointField.show(endpoint)
        tokenField.show(token)
        historyDaysField.show(days)
        val firstInvalid = listOf(endpointField to endpoint, tokenField to token, historyDaysField to days)
            .firstOrNull { !it.second.isValid }
        if (firstInvalid != null) {
            section.setExpanded(true)
            host.focusField(firstInvalid.first)
            saveState.text = host.string(R.string.save_state_fix_errors)
            kit.setTone(saveState, Tone.ERROR, tintBackground = false)
            return SaveResult.INVALID
        }
        val endpointValue = requireNotNull(endpoint.valueOrNull())
        val tokenValue = requireNotNull(token.valueOrNull())
        val daysValue = requireNotNull(days.valueOrNull())
        val ties = destinationTies()
        return when (DestinationChange.decide(settings.endpoint, endpointValue, ties)) {
            DestinationChange.Action.KEEP -> commit(endpointValue, tokenValue, daysValue, reset = null, showSuccess)
            DestinationChange.Action.RESET -> commit(endpointValue, tokenValue, daysValue, reset = ResetKind.QUIET, showSuccess)
            DestinationChange.Action.CONFIRM_RESET -> {
                if (model.sync.value.busy || ScreenUploader.isUploading) {
                    showDestinationBusy()
                    return SaveResult.BLOCKED
                }
                val reimportDays = DestinationChange.reimportDays(daysValue, historyPermissionGranted())
                val kind = if (ties.hasSyncProgress) ResetKind.REIMPORT else ResetKind.QUIET
                AlertDialog.Builder(host.activity)
                    .setTitle(R.string.destination_change_title)
                    .setMessage(DestinationChange.confirmMessage(hostOf(endpointValue), ties, reimportDays.takeIf { ties.hasSyncProgress }))
                    .setPositiveButton(
                        if (ties.hasSyncProgress) R.string.destination_change_ok else R.string.destination_change_ok_no_reimport,
                    ) { _, _ ->
                        val saved = commit(endpointValue, tokenValue, daysValue, kind, showSuccess)
                        if (saved == SaveResult.SAVED) afterConfirmedSave()
                    }
                    .setNegativeButton(R.string.action_cancel, null)
                    .show()
                SaveResult.AWAITING_CONFIRMATION
            }
        }
    }

    /** Writes validated values; [reset] also clears the sync cursor for a new destination. */
    private fun commit(endpointValue: String, tokenValue: String, daysValue: Int, reset: ResetKind?, showSuccess: Boolean): SaveResult {
        if (reset == null) {
            settings.endpoint = endpointValue
            reimportDaysAfterSave = null
        } else {
            val reimportDays = DestinationChange.reimportDays(daysValue, historyPermissionGranted())
            val status = if (reset == ResetKind.REIMPORT) "${Instant.now()}：${DestinationChange.resetStatus(reimportDays)}" else null
            // Under both the screen-upload and the sync lock, so neither an upload run nor a sync can
            // straddle the change or write the old destination's state afterwards. The phone token
            // belongs to the old destination and is cleared; queued screen records stay filed
            // under the old destination and are never sent to the new one.
            var done = false
            ScreenUploader.tryExclusive {
                done = SyncRunner.coordinator.tryExclusive {
                    settings.changeEndpointAndResetSync(endpointValue, status)
                    host.screenSettings.clearToken()
                }
            }
            if (!done) {
                showDestinationBusy()
                return SaveResult.BLOCKED
            }
            reimportDaysAfterSave = if (reset == ResetKind.REIMPORT) reimportDays else null
            screen.forgetTokenForNewDestination()
        }
        settings.token = tokenValue
        savedHealthToken = tokenValue
        model.drafts.clear(SecretDrafts.Key.HEALTH_TOKEN)
        settings.historyDays = daysValue
        // Show the normalised values (e.g. a trailing slash removed) so the form matches what was saved.
        if (endpointField.value != endpointValue) endpointField.setValue(endpointValue)
        if (tokenField.value != tokenValue) tokenField.setValue(tokenValue)
        if (historyDaysField.value != daysValue.toString()) historyDaysField.setValue(daysValue.toString())
        endpointField.show(endpointResult())
        historyDaysField.show(InputValidation.historyDays(daysValue.toString()))
        justSaved = showSuccess || reimportDaysAfterSave != null
        onSaved()
        return SaveResult.SAVED
    }

    private fun showDestinationBusy() {
        section.setExpanded(true)
        saveState.text = host.string(R.string.destination_change_busy)
        kit.setTone(saveState, Tone.ERROR, tintBackground = false)
    }

    /** What is tied to the saved destination: sync progress, queued screen records, a phone token. */
    private fun destinationTies() = DestinationChange.Ties(
        hasSyncProgress = settings.hasSyncProgress,
        screenPending = ObservationQueue.get(host.activity).count(host.currentDestination()),
        phoneTokenSaved = screen.phoneTokenSaved,
    )

    fun render() {
        if (!::saveState.isInitialized) return
        val dirty = dirty()
        val reimportDays = reimportDaysAfterSave
        val state = FormState.connection(dirty, justSaved, reimportDays != null, savedReady())
        saveState.text = when (state) {
            SaveState.UNSAVED -> host.string(R.string.save_state_unsaved)
            SaveState.SAVED_NEW_DESTINATION -> host.string(R.string.save_state_saved_new_destination, reimportDays ?: 0)
            SaveState.JUST_SAVED -> host.string(R.string.save_state_saved)
            SaveState.CLEAN -> host.string(R.string.save_state_clean)
            SaveState.INCOMPLETE -> host.string(R.string.save_state_incomplete)
        }
        if (state.tone == Tone.NEUTRAL) saveState.setTextColor(kit.color(R.color.text_secondary)) else kit.setTone(saveState, state.tone, tintBackground = false)
        val summary = ConnectionSummary.of(dirty, savedReady())
        section.setSummary(
            when (summary) {
                ConnectionSummary.UNSAVED -> host.string(R.string.connection_summary_unsaved)
                ConnectionSummary.READY -> host.string(R.string.connection_summary_ready, hostOf(settings.endpoint))
                ConnectionSummary.INCOMPLETE -> host.string(R.string.connection_summary_incomplete)
            },
            summary.tone,
        )
        onDirtyChanged()
    }

    /** Why the sync buttons cannot use the current connection settings, or null when they can. */
    fun problem(): String? {
        val valid = InputValidation.endpoint(endpointField.value).isValid &&
            InputValidation.token(tokenField.value, "token", required = true).isValid &&
            InputValidation.historyDays(historyDaysField.value).isValid
        return when {
            valid -> null
            dirty() -> host.string(R.string.sync_blocked_invalid_inputs)
            else -> host.string(R.string.sync_blocked_no_connection)
        }
    }

    private fun hostOf(endpoint: String): String = runCatching { endpoint.toUri().host }.getOrNull() ?: endpoint
}
