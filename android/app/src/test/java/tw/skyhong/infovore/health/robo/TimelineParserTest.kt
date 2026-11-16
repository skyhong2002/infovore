package tw.skyhong.infovore.health.robo

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import tw.skyhong.infovore.health.location.LocationFix
import tw.skyhong.infovore.health.location.LocationJson
import tw.skyhong.infovore.health.location.TimelineParser
import tw.skyhong.infovore.health.location.TimelineTrip
import tw.skyhong.infovore.health.location.TimelineVisit
import java.io.StringReader
import java.time.Instant

/**
 * The Timeline export formats, on Robolectric for android.util.JsonReader. The samples follow
 * the real exports' shape with made-up places and times.
 */
@RunWith(RobolectricTestRunner::class)
class TimelineParserTest {
    private class Collected : TimelineParser.Sink {
        val points = mutableListOf<LocationFix>()
        val visits = mutableListOf<TimelineVisit>()
        val trips = mutableListOf<TimelineTrip>()
        override fun point(fix: LocationFix) { points += fix }
        override fun visit(visit: TimelineVisit) { visits += visit }
        override fun trip(trip: TimelineTrip) { trips += trip }
    }

    private fun parse(json: String): Pair<Collected, TimelineParser.Counts> {
        val sink = Collected()
        val parser = TimelineParser(sink)
        parser.parse(StringReader(json))
        return sink to parser.counts
    }

    private fun ms(iso: String) = Instant.parse(iso).toEpochMilli()

    @Test
    fun readsTheOnDeviceAndroidExport() {
        val (sink, counts) = parse("""
            {"semanticSegments": [
              {"startTime": "2026-03-03T01:00:00.000+08:00", "endTime": "2026-03-03T09:00:00.000+08:00",
               "startTimeTimezoneUtcOffsetMinutes": 480,
               "visit": {"hierarchyLevel": 0, "probability": 0.9,
                 "topCandidate": {"placeId": "ChIJ-home", "semanticType": "HOME", "probability": 0.8,
                   "placeLocation": {"latLng": "25.0400000°, 121.5300000°"}}}},
              {"startTime": "2026-03-03T02:00:00.000+08:00", "endTime": "2026-03-03T03:00:00.000+08:00",
               "visit": {"hierarchyLevel": 1, "topCandidate": {"placeId": "ChIJ-inner", "placeLocation": {"latLng": "25.04°, 121.53°"}}}},
              {"startTime": "2026-03-03T09:00:00.000+08:00", "endTime": "2026-03-03T09:30:00.000+08:00",
               "activity": {"start": {"latLng": "25.04°, 121.53°"}, "end": {"latLng": "25.05°, 121.57°"},
                 "distanceMeters": 4200.5, "topCandidate": {"type": "IN_BUS", "probability": 0.7}}},
              {"startTime": "2026-03-03T09:00:00.000+08:00", "endTime": "2026-03-03T11:00:00.000+08:00",
               "timelinePath": [{"point": "25.0410°, 121.5400°", "time": "2026-03-03T09:10:00.000+08:00"},
                                {"point": "not a place", "time": "2026-03-03T09:20:00.000+08:00"}]},
              {"timelineMemory": {"trip": {}}}
            ],
            "rawSignals": [
              {"position": {"LatLng": "25.0420°, 121.5500°", "accuracyMeters": 12, "altitudeMeters": 30.5,
                "source": "WIFI", "timestamp": "2026-03-03T09:15:00.000+08:00", "speedMetersPerSecond": 3.2}},
              {"wifiScan": {"deliveryTime": "2026-03-03T09:15:00.000+08:00", "devicesRecords": []}}
            ],
            "userLocationProfile": {"frequentPlaces": [{"placeId": "ChIJ-home", "label": "HOME"}]}}
        """)

        assertEquals(listOf(TimelineVisit(ms("2026-03-02T17:00:00Z"), ms("2026-03-03T01:00:00Z"), 25.04, 121.53, "ChIJ-home", "HOME", null, 0.8)), sink.visits)
        assertEquals(1, sink.trips.size)
        val trip = sink.trips.single()
        assertEquals("IN_BUS", trip.mode)
        assertEquals(4200.5, trip.distanceMeters!!, 0.0)
        assertEquals(25.05, trip.endLat!!, 0.0)
        assertEquals(2, sink.points.size)
        assertEquals(LocationFix(ms("2026-03-03T01:10:00Z"), 25.041, 121.54), sink.points[0])
        assertEquals(LocationFix(ms("2026-03-03T01:15:00Z"), 25.042, 121.55, 12.0, 30.5, 3.2), sink.points[1])
        // The unreadable path point; the nested visit, the timelineMemory segment and the wifi scan are ignored silently.
        assertEquals(1, counts.skipped)
    }

    @Test
    fun readsTheIosArrayExport() {
        val (sink, _) = parse("""
            [{"startTime": "2026-03-03T09:00:00.000+08:00", "endTime": "2026-03-03T10:00:00.000+08:00",
              "activity": {"start": "geo:25.040000,121.530000", "end": "geo:25.050000,121.570000",
                "distanceMeters": "4200", "topCandidate": {"type": "walking", "probability": "0.5"}}},
             {"startTime": "2026-03-03T10:00:00.000+08:00", "endTime": "2026-03-03T12:00:00.000+08:00",
              "visit": {"hierarchyLevel": "0", "probability": "0.7",
                "topCandidate": {"placeID": "ChIJ-cafe", "semanticType": "Unknown", "probability": "0.6", "placeLocation": "geo:25.050000,121.570000"}}},
             {"startTime": "2026-03-03T09:00:00.000+08:00", "endTime": "2026-03-03T11:00:00.000+08:00",
              "timelinePath": [{"point": "geo:25.045,121.55", "durationMinutesOffsetFromStartTime": "30"}]}]
        """)
        assertEquals("walking", sink.trips.single().mode)
        assertEquals(4200.0, sink.trips.single().distanceMeters!!, 0.0)
        assertEquals("ChIJ-cafe", sink.visits.single().placeId)
        assertEquals(0.6, sink.visits.single().probability!!, 0.0)
        assertEquals(LocationFix(ms("2026-03-03T01:30:00Z"), 25.045, 121.55), sink.points.single())
    }

    @Test
    fun readsTakeoutRecordsAndSemanticHistory() {
        val (records, _) = parse("""
            {"locations": [
              {"latitudeE7": 250330000, "longitudeE7": 1215654000, "accuracy": 20, "timestamp": "2026-01-01T00:00:00.123Z"},
              {"latitudeE7": 250340000, "longitudeE7": 1215655000, "timestampMs": "1767225660000", "velocity": 2},
              {"latitudeE7": 950000000, "longitudeE7": 0, "timestamp": "2026-01-01T00:02:00Z"}
            ]}
        """)
        assertEquals(2, records.points.size)
        assertEquals(LocationFix(ms("2026-01-01T00:00:00.123Z"), 25.033, 121.5654, 20.0), records.points[0])
        assertEquals(1767225660000L, records.points[1].timeMs)
        assertEquals(2.0, records.points[1].speed!!, 0.0)

        val (semantic, _) = parse("""
            {"timelineObjects": [
              {"placeVisit": {"location": {"latitudeE7": 250400000, "longitudeE7": 1215300000, "placeId": "ChIJ-x",
                  "name": "Some Café", "semanticType": "TYPE_SEARCHED_ADDRESS"},
                "duration": {"startTimestamp": "2022-05-01T01:00:00Z", "endTimestamp": "2022-05-01T02:00:00Z"},
                "visitConfidence": 85,
                "simplifiedRawPath": {"points": [{"latE7": 250400100, "lngE7": 1215300100, "accuracyMeters": 9, "timestamp": "2022-05-01T01:30:00Z"}]}}},
              {"activitySegment": {"startLocation": {"latitudeE7": 250400000, "longitudeE7": 1215300000},
                "endLocation": {"latitudeE7": 250500000, "longitudeE7": 1215700000},
                "duration": {"startTimestampMs": "1651370400000", "endTimestampMs": "1651372200000"},
                "distance": 4100, "activityType": "IN_PASSENGER_VEHICLE", "confidence": "HIGH"}}
            ]}
        """)
        val visit = semantic.visits.single()
        assertEquals("Some Café", visit.name)
        assertEquals(0.85, visit.probability!!, 1e-9)
        assertEquals(1, semantic.points.size)
        val trip = semantic.trips.single()
        assertEquals(1651370400000L, trip.startMs)
        assertEquals("IN_PASSENGER_VEHICLE", trip.mode)
        assertNull(trip.probability)
    }

    @Test
    fun refusesFilesThatAreNotTimelineExports() {
        assertThrows(IllegalArgumentException::class.java) { parse("""{"hello": "world"}""") }
        assertThrows(IllegalArgumentException::class.java) { parse("\"just a string\"") }
    }

    @Test
    fun theBatchKeepsOnlyWhatTheServerAccepts() {
        val body = org.json.JSONObject(LocationJson.batch(
            "device-1", LocationJson.SOURCE_TIMELINE,
            points = listOf(LocationFix(1, 25.0, 121.0, accuracy = -5.0, speed = 3.0), LocationFix(2, 91.0, 121.0)),
            visits = listOf(TimelineVisit(10, 5, 25.0, 121.0, name = "x".repeat(300), probability = 2.0)),
            trips = listOf(TimelineTrip(10, 20, startLat = 95.0, startLng = 121.0, endLat = 25.0, endLng = 121.0, mode = "  ")),
        ))
        val points = body.getJSONArray("points")
        assertEquals(1, points.length())
        assertTrue(!points.getJSONObject(0).has("accuracy"))
        val visit = body.getJSONArray("visits").getJSONObject(0)
        assertEquals(visit.getString("start"), visit.getString("end"))
        assertEquals(200, visit.getString("name").length)
        assertTrue(!visit.has("probability"))
        val trip = body.getJSONArray("activities").getJSONObject(0)
        assertTrue(!trip.has("startLat") && trip.has("endLat") && !trip.has("mode"))
    }

    @Test
    fun queueLinesRoundTripAndSkipTornWrites() {
        val fix = LocationFix(1767225600000, 25.033, 121.5654, 12.5, null, 0.0)
        assertEquals(fix, LocationJson.decodeLine(LocationJson.encodeLine(fix)))
        assertNull(LocationJson.decodeLine("1767225600000,25.03"))
        assertNull(LocationJson.decodeLine("x,25,121,,,"))
    }
}
