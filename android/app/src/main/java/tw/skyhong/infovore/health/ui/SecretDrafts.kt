package tw.skyhong.infovore.health.ui

/**
 * Unsaved token edits, kept only in memory (held by the ViewModel) so they survive an activity
 * recreation such as a rotation or a dark-mode switch. Secret fields are excluded from the
 * saved-instance-state bundle on purpose, so this is never written to a Bundle, to preferences,
 * or to logs; [toString] does not reveal the values.
 */
class SecretDrafts {
    enum class Key { HEALTH_TOKEN, PHONE_TOKEN }

    private val drafts = mutableMapOf<Key, String>()

    /** Records [current] as a draft, or forgets the draft once it matches [saved] again. */
    fun update(key: Key, current: String, saved: String) {
        if (current.trim() == saved) drafts.remove(key) else drafts[key] = current
    }

    /** The value to show in the field: the unsaved draft if there is one, else the saved value. */
    fun valueOr(key: Key, saved: String): String = drafts[key] ?: saved

    fun hasDraft(key: Key): Boolean = key in drafts

    fun clear(key: Key) {
        drafts.remove(key)
    }

    fun clearAll() = drafts.clear()

    override fun toString(): String = "SecretDrafts(${drafts.size} unsaved, values hidden)"
}
