package tw.skyhong.infovore.health

import androidx.health.connect.client.records.BodyFatRecord
import androidx.health.connect.client.records.DistanceRecord
import androidx.health.connect.client.records.ExerciseSessionRecord
import androidx.health.connect.client.records.HeartRateRecord
import androidx.health.connect.client.records.Record
import androidx.health.connect.client.records.SleepSessionRecord
import androidx.health.connect.client.records.StepsRecord
import androidx.health.connect.client.records.TotalCaloriesBurnedRecord
import androidx.health.connect.client.records.WeightRecord
import org.json.JSONArray
import org.json.JSONObject
import java.time.Instant

object HealthRecordJson {
    fun encode(record: Record): JSONObject {
        val (type, start, end, payload) = when (record) {
            is ExerciseSessionRecord -> Encoded(
                "exercise_session", record.startTime, record.endTime,
                JSONObject()
                    .put("exerciseType", record.exerciseType)
                    .put("title", record.title ?: JSONObject.NULL)
                    .put("notes", record.notes ?: JSONObject.NULL)
                    .put("segments", JSONArray(record.segments.map { segment ->
                        JSONObject()
                            .put("startTime", segment.startTime.toString())
                            .put("endTime", segment.endTime.toString())
                            .put("segmentType", segment.segmentType)
                            .put("repetitions", segment.repetitions)
                    }))
            )
            is StepsRecord -> Encoded(
                "steps", record.startTime, record.endTime,
                JSONObject().put("count", record.count)
            )
            is DistanceRecord -> Encoded(
                "distance", record.startTime, record.endTime,
                JSONObject().put("meters", record.distance.inMeters)
            )
            is TotalCaloriesBurnedRecord -> Encoded(
                "total_calories_burned", record.startTime, record.endTime,
                JSONObject().put("kilocalories", record.energy.inKilocalories)
            )
            is HeartRateRecord -> Encoded(
                "heart_rate", record.startTime, record.endTime,
                JSONObject().put("samples", JSONArray(record.samples.map { sample ->
                    JSONObject()
                        .put("time", sample.time.toString())
                        .put("beatsPerMinute", sample.beatsPerMinute)
                }))
            )
            is SleepSessionRecord -> Encoded(
                "sleep_session", record.startTime, record.endTime,
                JSONObject()
                    .put("title", record.title ?: JSONObject.NULL)
                    .put("notes", record.notes ?: JSONObject.NULL)
                    .put("stages", JSONArray(record.stages.map { stage ->
                        JSONObject()
                            .put("startTime", stage.startTime.toString())
                            .put("endTime", stage.endTime.toString())
                            .put("stage", stage.stage)
                    }))
            )
            is WeightRecord -> Encoded(
                "weight", record.time, record.time,
                JSONObject().put("kilograms", record.weight.inKilograms)
            )
            is BodyFatRecord -> Encoded(
                "body_fat", record.time, record.time,
                JSONObject().put("percentage", record.percentage.value)
            )
            else -> error("Unsupported Health Connect record: ${record::class.simpleName}")
        }
        return JSONObject()
            .put("id", record.metadata.id)
            .put("dataType", type)
            .put("dataOrigin", record.metadata.dataOrigin.packageName)
            .put("startTime", start.toString())
            .put("endTime", end.toString())
            .put("lastModifiedTime", record.metadata.lastModifiedTime.toString())
            .put("payload", payload)
    }

    private data class Encoded(
        val type: String,
        val start: Instant,
        val end: Instant,
        val payload: JSONObject,
    )
}
