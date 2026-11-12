package tw.skyhong.infovore.health.ui

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import tw.skyhong.infovore.health.ui.SecretDrafts.Key

class SecretDraftsTest {
    private val saved = "s".repeat(32)
    private val draft = "d".repeat(40)

    @Test
    fun anUnsavedEditIsRestoredAfterRecreation() {
        val drafts = SecretDrafts()
        assertEquals(saved, drafts.valueOr(Key.HEALTH_TOKEN, saved))
        drafts.update(Key.HEALTH_TOKEN, draft, saved)
        assertTrue(drafts.hasDraft(Key.HEALTH_TOKEN))
        // A recreated activity reads the draft back instead of overwriting it with the saved token.
        assertEquals(draft, drafts.valueOr(Key.HEALTH_TOKEN, saved))
        assertEquals(saved, drafts.valueOr(Key.PHONE_TOKEN, saved))
    }

    @Test
    fun bothTokensAreTrackedSeparately() {
        val drafts = SecretDrafts()
        drafts.update(Key.HEALTH_TOKEN, draft, saved)
        drafts.update(Key.PHONE_TOKEN, "", saved)
        assertEquals("", drafts.valueOr(Key.PHONE_TOKEN, saved))
        drafts.clear(Key.HEALTH_TOKEN)
        assertFalse(drafts.hasDraft(Key.HEALTH_TOKEN))
        assertTrue(drafts.hasDraft(Key.PHONE_TOKEN))
        drafts.clearAll()
        assertFalse(drafts.hasDraft(Key.PHONE_TOKEN))
    }

    @Test
    fun typingBackTheSavedValueForgetsTheDraft() {
        val drafts = SecretDrafts()
        drafts.update(Key.HEALTH_TOKEN, draft, saved)
        drafts.update(Key.HEALTH_TOKEN, " $saved ", saved)
        assertFalse(drafts.hasDraft(Key.HEALTH_TOKEN))
    }

    @Test
    fun toStringNeverRevealsValues() {
        val drafts = SecretDrafts()
        drafts.update(Key.HEALTH_TOKEN, draft, saved)
        assertFalse(drafts.toString().contains(draft))
    }
}
