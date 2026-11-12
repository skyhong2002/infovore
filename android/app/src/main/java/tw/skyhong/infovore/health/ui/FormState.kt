package tw.skyhong.infovore.health.ui

/** The line under a form's save button. */
enum class SaveState(val tone: Tone) {
    UNSAVED(Tone.WARNING),
    JUST_SAVED(Tone.OK),

    /** Saved, and the sync destination changed, so history will be imported again. */
    SAVED_NEW_DESTINATION(Tone.WARNING),
    CLEAN(Tone.NEUTRAL),
    INCOMPLETE(Tone.WARNING),
}

/** Pure decisions for the settings forms, kept out of the activity so they can be unit tested. */
object FormState {
    fun connection(dirty: Boolean, justSaved: Boolean, destinationChanged: Boolean, savedReady: Boolean): SaveState = when {
        dirty -> SaveState.UNSAVED
        justSaved && destinationChanged -> SaveState.SAVED_NEW_DESTINATION
        justSaved -> SaveState.JUST_SAVED
        savedReady -> SaveState.CLEAN
        else -> SaveState.INCOMPLETE
    }

    fun screen(dirty: Boolean, justSaved: Boolean): SaveState = when {
        dirty -> SaveState.UNSAVED
        justSaved -> SaveState.JUST_SAVED
        else -> SaveState.CLEAN
    }

    /** Leaving the screen asks first only when a form has unsaved edits. */
    fun confirmBeforeLeaving(connectionDirty: Boolean, screenDirty: Boolean): Boolean = connectionDirty || screenDirty
}
