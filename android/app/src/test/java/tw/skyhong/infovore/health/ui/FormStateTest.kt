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
    fun leavingAsksOnlyWithUnsavedEdits() {
        assertTrue(FormState.confirmBeforeLeaving(connectionDirty = true))
        assertFalse(FormState.confirmBeforeLeaving(connectionDirty = false))
    }
}
