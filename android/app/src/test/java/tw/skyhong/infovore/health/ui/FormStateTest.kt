package tw.skyhong.infovore.health.ui

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class FormStateTest {
    @Test
    fun connectionSaveStatePrefersUnsavedThenTheDestinationNotice() {
        assertEquals(SaveState.UNSAVED, FormState.connection(dirty = true, justSaved = true, destinationChanged = true, savedReady = true))
        assertEquals(SaveState.SAVED_NEW_DESTINATION, FormState.connection(false, justSaved = true, destinationChanged = true, savedReady = true))
        assertEquals(SaveState.JUST_SAVED, FormState.connection(false, justSaved = true, destinationChanged = false, savedReady = true))
        assertEquals(SaveState.CLEAN, FormState.connection(false, justSaved = false, destinationChanged = false, savedReady = true))
        assertEquals(SaveState.INCOMPLETE, FormState.connection(false, justSaved = false, destinationChanged = false, savedReady = false))
        assertEquals(Tone.WARNING, SaveState.SAVED_NEW_DESTINATION.tone)
    }

    @Test
    fun screenSaveStateAndLeavingConfirmation() {
        assertEquals(SaveState.UNSAVED, FormState.screen(dirty = true, justSaved = true))
        assertEquals(SaveState.JUST_SAVED, FormState.screen(dirty = false, justSaved = true))
        assertEquals(SaveState.CLEAN, FormState.screen(dirty = false, justSaved = false))
        assertTrue(FormState.confirmBeforeLeaving(connectionDirty = false, screenDirty = true))
        assertFalse(FormState.confirmBeforeLeaving(connectionDirty = false, screenDirty = false))
    }
}
