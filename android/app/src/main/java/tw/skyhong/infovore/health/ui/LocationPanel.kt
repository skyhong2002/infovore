package tw.skyhong.infovore.health.ui

/** What the "位置紀錄" section shows for the recorder's settings and permissions. */
enum class LocationState(val tone: Tone, val summary: String) {
    OFF(Tone.NEUTRAL, "未開啟"),
    RECORDING(Tone.OK, "記錄中"),
    /** On, but the service stopped (Android refused a background restart, or a reboot without "一律允許"). */
    PAUSED(Tone.WARNING, "已暫停"),
    /** On, but precise location was withdrawn in system settings. */
    NO_PERMISSION(Tone.ERROR, "需要位置權限"),
}

data class LocationPanelUi(
    val state: LocationState,
    /** The switch's checked state: on only while it can actually record. */
    val checked: Boolean,
    /** Offer "一律允許" (background location) so recording resumes after a reboot. */
    val offerBackground: Boolean,
    val uploadEnabled: Boolean,
    val importEnabled: Boolean,
)

object LocationPanel {
    fun map(
        enabled: Boolean,
        fineGranted: Boolean,
        backgroundGranted: Boolean,
        problem: String?,
        queued: Int,
        connectionReady: Boolean,
        importing: Boolean,
    ): LocationPanelUi {
        val state = when {
            !enabled -> LocationState.OFF
            !fineGranted -> LocationState.NO_PERMISSION
            problem != null -> LocationState.PAUSED
            else -> LocationState.RECORDING
        }
        return LocationPanelUi(
            state = state,
            checked = enabled && fineGranted,
            offerBackground = enabled && fineGranted && !backgroundGranted,
            uploadEnabled = connectionReady && queued > 0,
            importEnabled = connectionReady && !importing,
        )
    }
}
