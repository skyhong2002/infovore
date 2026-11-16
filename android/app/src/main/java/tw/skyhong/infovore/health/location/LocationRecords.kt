package tw.skyhong.infovore.health.location

import org.json.JSONArray
import org.json.JSONObject
import java.time.Instant

/** One position: a fix from this phone, or a point from an imported Google Maps Timeline. */
data class LocationFix(
    val timeMs: Long,
    val lat: Double,
    val lng: Double,
    val accuracy: Double? = null,
    val altitude: Double? = null,
    val speed: Double? = null,
)

/** A place stayed at, from a Timeline export. */
data class TimelineVisit(
    val startMs: Long,
    val endMs: Long,
    val lat: Double,
    val lng: Double,
    val placeId: String? = null,
    val semanticType: String? = null,
    val name: String? = null,
    val probability: Double? = null,
)

/** A trip between places, from a Timeline export. */
data class TimelineTrip(
    val startMs: Long,
    val endMs: Long,
    val startLat: Double? = null,
    val startLng: Double? = null,
    val endLat: Double? = null,
    val endLng: Double? = null,
    val distanceMeters: Double? = null,
    val mode: String? = null,
    val probability: Double? = null,
)

/**
 * The bodies of `POST /api/ingest/location/batches` and the queue's line format. Values outside
 * what the server accepts are dropped here (set to null, or the record skipped by the caller with
 * [valid]), so one odd record in a large Timeline export cannot make a whole batch fail with 400.
 */
object LocationJson {
    const val SOURCE_LIVE = "live"
    const val SOURCE_TIMELINE = "timeline"

    /** The server's per-kind limit is 2,000; batches stay well under it and under 1 MiB. */
    const val MAX_POINTS_PER_BATCH = 1_000
    const val MAX_SEGMENTS_PER_BATCH = 500

    fun validLat(value: Double?): Boolean = value != null && value.isFinite() && value in -90.0..90.0
    fun validLng(value: Double?): Boolean = value != null && value.isFinite() && value in -180.0..180.0

    fun valid(fix: LocationFix): Boolean = fix.timeMs > 0 && validLat(fix.lat) && validLng(fix.lng)
    fun valid(visit: TimelineVisit): Boolean = visit.startMs > 0 && validLat(visit.lat) && validLng(visit.lng)
    fun valid(trip: TimelineTrip): Boolean = trip.startMs > 0

    private fun bounded(value: Double?, min: Double, max: Double): Double? =
        value?.takeIf { it.isFinite() && it in min..max }

    private fun text(value: String?): String? = value?.trim()?.takeIf { it.isNotEmpty() }?.take(200)

    private fun iso(ms: Long): String = Instant.ofEpochMilli(ms).toString()

    private fun JSONObject.putOptional(key: String, value: Any?): JSONObject = if (value == null) this else put(key, value)

    fun point(fix: LocationFix): JSONObject = JSONObject()
        .put("time", iso(fix.timeMs))
        .put("lat", fix.lat)
        .put("lng", fix.lng)
        .putOptional("accuracy", bounded(fix.accuracy, 0.0, 100_000.0))
        .putOptional("altitude", bounded(fix.altitude, -1_000.0, 20_000.0))
        .putOptional("speed", bounded(fix.speed, 0.0, 1_000.0))

    fun visit(visit: TimelineVisit): JSONObject = JSONObject()
        .put("start", iso(visit.startMs))
        .put("end", iso(maxOf(visit.startMs, visit.endMs)))
        .put("lat", visit.lat)
        .put("lng", visit.lng)
        .putOptional("placeId", text(visit.placeId))
        .putOptional("semanticType", text(visit.semanticType))
        .putOptional("name", text(visit.name))
        .putOptional("probability", bounded(visit.probability, 0.0, 1.0))

    fun trip(trip: TimelineTrip): JSONObject {
        val start = trip.startLat?.let { lat -> trip.startLng?.takeIf { validLat(lat) && validLng(it) }?.let { lat to it } }
        val end = trip.endLat?.let { lat -> trip.endLng?.takeIf { validLat(lat) && validLng(it) }?.let { lat to it } }
        return JSONObject()
            .put("start", iso(trip.startMs))
            .put("end", iso(maxOf(trip.startMs, trip.endMs)))
            .putOptional("startLat", start?.first)
            .putOptional("startLng", start?.second)
            .putOptional("endLat", end?.first)
            .putOptional("endLng", end?.second)
            .putOptional("distanceMeters", bounded(trip.distanceMeters, 0.0, 50_000_000.0))
            .putOptional("mode", text(trip.mode))
            .putOptional("probability", bounded(trip.probability, 0.0, 1.0))
    }

    fun batch(
        deviceId: String,
        source: String,
        points: List<LocationFix> = emptyList(),
        visits: List<TimelineVisit> = emptyList(),
        trips: List<TimelineTrip> = emptyList(),
    ): String = JSONObject()
        .put("deviceId", deviceId)
        .put("source", source)
        .put("points", JSONArray().apply { points.filter(::valid).forEach { put(point(it)) } })
        .put("visits", JSONArray().apply { visits.filter(::valid).forEach { put(visit(it)) } })
        .put("activities", JSONArray().apply { trips.filter(::valid).forEach { put(trip(it)) } })
        .toString()

    /** One queued fix per line: `time,lat,lng,accuracy,altitude,speed`, an empty field for null. */
    fun encodeLine(fix: LocationFix): String = listOf(
        fix.timeMs.toString(), fix.lat.toString(), fix.lng.toString(),
        fix.accuracy?.toString().orEmpty(), fix.altitude?.toString().orEmpty(), fix.speed?.toString().orEmpty(),
    ).joinToString(",")

    /** null for a line that cannot be read back (a write cut short by a crash). */
    fun decodeLine(line: String): LocationFix? {
        val parts = line.split(',')
        if (parts.size != 6) return null
        val optional = { value: String -> value.takeIf(String::isNotEmpty)?.toDoubleOrNull() }
        val fix = LocationFix(
            timeMs = parts[0].toLongOrNull() ?: return null,
            lat = parts[1].toDoubleOrNull() ?: return null,
            lng = parts[2].toDoubleOrNull() ?: return null,
            accuracy = optional(parts[3]),
            altitude = optional(parts[4]),
            speed = optional(parts[5]),
        )
        return fix.takeIf(::valid)
    }
}
