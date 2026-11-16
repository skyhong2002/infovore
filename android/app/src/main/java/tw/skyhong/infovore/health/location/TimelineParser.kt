package tw.skyhong.infovore.health.location

import android.util.JsonReader
import android.util.JsonToken
import java.io.Reader
import java.time.Instant
import java.time.OffsetDateTime
import java.time.format.DateTimeParseException

/**
 * Reads a Google Maps Timeline export as a stream (exports reach hundreds of MB, so the file is
 * never held in memory; only one segment at a time is). Understood formats:
 *
 * - The on-device export (Android: Settings → Location → Timeline → Export Timeline data), an
 *   object with `semanticSegments` (visits, activities, `timelinePath` points) and `rawSignals`
 *   (`position` fixes); `userLocationProfile` is ignored.
 * - The iOS export, a top-level array of the same segments with `geo:` coordinates and
 *   `timelinePath` offsets in minutes.
 * - Google Takeout's Location History: `Records.json` (`locations`, E7 coordinates) and the
 *   monthly Semantic Location History files (`timelineObjects` with `placeVisit` and
 *   `activitySegment`).
 *
 * Records it cannot place in time or on the map are skipped and counted in [Counts.skipped].
 */
class TimelineParser(private val sink: Sink) {
    interface Sink {
        fun point(fix: LocationFix)
        fun visit(visit: TimelineVisit)
        fun trip(trip: TimelineTrip)
    }

    data class Counts(var points: Int = 0, var visits: Int = 0, var trips: Int = 0, var skipped: Int = 0) {
        val total: Int get() = points + visits + trips
    }

    val counts = Counts()

    /** Parses [reader] to the end. Throws [IllegalArgumentException] when it is not a Timeline export. */
    fun parse(reader: Reader) {
        JsonReader(reader).use { json ->
            json.isLenient = true
            when (json.peek()) {
                JsonToken.BEGIN_ARRAY -> eachElement(json) { segment(asMap(readValue(json))) }
                JsonToken.BEGIN_OBJECT -> {
                    var recognised = false
                    json.beginObject()
                    while (json.hasNext()) {
                        when (json.nextName()) {
                            "semanticSegments" -> { recognised = true; eachElement(json) { segment(asMap(readValue(json))) } }
                            "rawSignals" -> { recognised = true; eachElement(json) { rawSignal(asMap(readValue(json))) } }
                            "locations" -> { recognised = true; eachElement(json) { record(asMap(readValue(json))) } }
                            "timelineObjects" -> { recognised = true; eachElement(json) { timelineObject(asMap(readValue(json))) } }
                            else -> json.skipValue()
                        }
                    }
                    json.endObject()
                    require(recognised) { "這不是 Google 地圖時間軸的匯出檔（找不到 semanticSegments、locations 或 timelineObjects）。" }
                }
                else -> throw IllegalArgumentException("這不是 JSON 格式的時間軸匯出檔。")
            }
        }
    }

    private inline fun eachElement(json: JsonReader, block: () -> Unit) {
        if (json.peek() != JsonToken.BEGIN_ARRAY) { json.skipValue(); return }
        json.beginArray()
        while (json.hasNext()) block()
        json.endArray()
    }

    // ---- on-device and iOS segments ----

    private fun segment(segment: Map<String, Any?>?) {
        if (segment == null) return skip()
        val start = time(segment["startTime"])
        val end = time(segment["endTime"]) ?: start
        asMap(segment["visit"])?.let { visit(it, start, end) }
        asMap(segment["activity"])?.let { activity(it, start, end) }
        (segment["timelinePath"] as? List<*>)?.forEach { item ->
            val entry = asMap(item) ?: return@forEach skip()
            val point = latLng(entry["point"])
            val at = time(entry["time"])
                ?: number(entry["durationMinutesOffsetFromStartTime"])?.let { minutes -> start?.plus((minutes * 60_000).toLong()) }
            emitPoint(at, point, null)
        }
    }

    private fun visit(visit: Map<String, Any?>, start: Long?, end: Long?) {
        // Nested visits (a shop inside a mall) repeat their parent; keep the top level only.
        val level = number(visit["hierarchyLevel"]) ?: 0.0
        if (level > 0) return
        val candidate = asMap(visit["topCandidate"]) ?: return skip()
        val location = latLng(asMap(candidate["placeLocation"])?.get("latLng") ?: candidate["placeLocation"])
        if (start == null || end == null || location == null) return skip()
        emitVisit(TimelineVisit(
            startMs = start, endMs = end, lat = location.first, lng = location.second,
            placeId = string(candidate["placeId"]) ?: string(candidate["placeID"]),
            semanticType = string(candidate["semanticType"]),
            probability = number(candidate["probability"]) ?: number(visit["probability"]),
        ))
    }

    private fun activity(activity: Map<String, Any?>, start: Long?, end: Long?) {
        if (start == null || end == null) return skip()
        val from = latLng(asMap(activity["start"])?.get("latLng") ?: activity["start"])
        val to = latLng(asMap(activity["end"])?.get("latLng") ?: activity["end"])
        val candidate = asMap(activity["topCandidate"])
        emitTrip(TimelineTrip(
            startMs = start, endMs = end,
            startLat = from?.first, startLng = from?.second, endLat = to?.first, endLng = to?.second,
            distanceMeters = number(activity["distanceMeters"]),
            mode = string(candidate?.get("type")),
            probability = number(candidate?.get("probability")) ?: number(activity["probability"]),
        ))
    }

    private fun rawSignal(signal: Map<String, Any?>?) {
        val position = asMap(signal?.get("position")) ?: return // wifi scans and activity records carry no position
        emitPoint(
            time(position["timestamp"]),
            latLng(position["LatLng"] ?: position["latLng"]),
            LocationFix(0, 0.0, 0.0,
                accuracy = number(position["accuracyMeters"]),
                altitude = number(position["altitudeMeters"]),
                speed = number(position["speedMetersPerSecond"])),
        )
    }

    // ---- Takeout ----

    private fun record(location: Map<String, Any?>?) {
        if (location == null) return skip()
        emitPoint(
            time(location["timestamp"]) ?: number(location["timestampMs"])?.toLong(),
            e7(location["latitudeE7"], location["longitudeE7"]),
            LocationFix(0, 0.0, 0.0,
                accuracy = number(location["accuracy"]),
                altitude = number(location["altitude"]),
                // Records.json "velocity" is in m/s.
                speed = number(location["velocity"])),
        )
    }

    private fun timelineObject(item: Map<String, Any?>?) {
        if (item == null) return skip()
        asMap(item["placeVisit"])?.let { placeVisit ->
            val location = asMap(placeVisit["location"])
            val (start, end) = duration(asMap(placeVisit["duration"]))
            val at = e7(location?.get("latitudeE7"), location?.get("longitudeE7"))
            if (start == null || end == null || at == null) skip() else emitVisit(TimelineVisit(
                startMs = start, endMs = end, lat = at.first, lng = at.second,
                placeId = string(location?.get("placeId")),
                semanticType = string(location?.get("semanticType")),
                name = string(location?.get("name")),
                probability = number(placeVisit["visitConfidence"])?.let { if (it > 1) it / 100 else it },
            ))
            rawPath(placeVisit)
        }
        asMap(item["activitySegment"])?.let { segment ->
            val (start, end) = duration(asMap(segment["duration"]))
            val from = asMap(segment["startLocation"]).let { e7(it?.get("latitudeE7"), it?.get("longitudeE7")) }
            val to = asMap(segment["endLocation"]).let { e7(it?.get("latitudeE7"), it?.get("longitudeE7")) }
            if (start == null || end == null) skip() else emitTrip(TimelineTrip(
                startMs = start, endMs = end,
                startLat = from?.first, startLng = from?.second, endLat = to?.first, endLng = to?.second,
                distanceMeters = number(segment["distance"]),
                // Its "confidence" is a word (HIGH, LOW), not a probability.
                mode = string(segment["activityType"]),
            ))
            rawPath(segment)
        }
    }

    private fun rawPath(container: Map<String, Any?>) {
        val points = asMap(container["simplifiedRawPath"])?.get("points") as? List<*> ?: return
        for (item in points) {
            val point = asMap(item) ?: continue
            emitPoint(
                time(point["timestamp"]) ?: number(point["timestampMs"])?.toLong(),
                e7(point["latE7"], point["lngE7"]),
                LocationFix(0, 0.0, 0.0, accuracy = number(point["accuracyMeters"])),
            )
        }
    }

    private fun duration(duration: Map<String, Any?>?): Pair<Long?, Long?> =
        (time(duration?.get("startTimestamp")) ?: number(duration?.get("startTimestampMs"))?.toLong()) to
            (time(duration?.get("endTimestamp")) ?: number(duration?.get("endTimestampMs"))?.toLong())

    // ---- emitting ----

    private fun emitPoint(time: Long?, at: Pair<Double, Double>?, extra: LocationFix?) {
        if (time == null || at == null) return skip()
        val fix = LocationFix(time, at.first, at.second, extra?.accuracy, extra?.altitude, extra?.speed)
        if (!LocationJson.valid(fix)) return skip()
        counts.points++
        sink.point(fix)
    }

    private fun emitVisit(visit: TimelineVisit) {
        if (!LocationJson.valid(visit)) return skip()
        counts.visits++
        sink.visit(visit)
    }

    private fun emitTrip(trip: TimelineTrip) {
        if (!LocationJson.valid(trip)) return skip()
        counts.trips++
        sink.trip(trip)
    }

    private fun skip() {
        counts.skipped++
    }

    companion object {
        private val LAT_LNG = Regex("""(-?\d+(?:\.\d+)?)\s*°?\s*,\s*(-?\d+(?:\.\d+)?)\s*°?""")

        /** `25.0330°, 121.5654°`, `geo:25.0330,121.5654` or `25.0330, 121.5654`. */
        fun latLng(value: Any?): Pair<Double, Double>? {
            val text = (value as? String)?.removePrefix("geo:") ?: return null
            val match = LAT_LNG.find(text) ?: return null
            val lat = match.groupValues[1].toDoubleOrNull() ?: return null
            val lng = match.groupValues[2].toDoubleOrNull() ?: return null
            return (lat to lng).takeIf { LocationJson.validLat(lat) && LocationJson.validLng(lng) }
        }

        fun e7(lat: Any?, lng: Any?): Pair<Double, Double>? {
            val latitude = number(lat)?.div(1e7) ?: return null
            val longitude = number(lng)?.div(1e7) ?: return null
            return (latitude to longitude).takeIf { LocationJson.validLat(latitude) && LocationJson.validLng(longitude) }
        }

        /** An ISO-8601 instant with an offset (`2024-01-01T08:00:00.000+08:00`, `…Z`) as epoch ms. */
        fun time(value: Any?): Long? {
            val text = (value as? String)?.trim()?.takeIf { it.isNotEmpty() } ?: return null
            return try {
                OffsetDateTime.parse(text).toInstant().toEpochMilli()
            } catch (_: DateTimeParseException) {
                try { Instant.parse(text).toEpochMilli() } catch (_: DateTimeParseException) { null }
            }
        }

        fun number(value: Any?): Double? = when (value) {
            is Number -> value.toDouble()
            is String -> value.trim().toDoubleOrNull()
            else -> null
        }?.takeIf { it.isFinite() }

        fun string(value: Any?): String? = (value as? String)?.trim()?.takeIf { it.isNotEmpty() }

        @Suppress("UNCHECKED_CAST")
        fun asMap(value: Any?): Map<String, Any?>? = value as? Map<String, Any?>

        /** One JSON value as Map / List / String / Double / Boolean / null. */
        fun readValue(json: JsonReader): Any? = when (json.peek()) {
            JsonToken.BEGIN_OBJECT -> {
                val map = LinkedHashMap<String, Any?>()
                json.beginObject()
                while (json.hasNext()) map[json.nextName()] = readValue(json)
                json.endObject()
                map
            }
            JsonToken.BEGIN_ARRAY -> {
                val list = ArrayList<Any?>()
                json.beginArray()
                while (json.hasNext()) list.add(readValue(json))
                json.endArray()
                list
            }
            JsonToken.STRING -> json.nextString()
            JsonToken.NUMBER -> json.nextString().toDoubleOrNull()
            JsonToken.BOOLEAN -> json.nextBoolean()
            JsonToken.NULL -> { json.nextNull(); null }
            else -> { json.skipValue(); null }
        }
    }
}
