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
    /** The server's dataType for a record class, as written by [encode]. */
    fun typeName(type: kotlin.reflect.KClass<out Record>): String = when (type) {
        ExerciseSessionRecord::class -> "exercise_session"
        StepsRecord::class -> "steps"
        DistanceRecord::class -> "distance"
        TotalCaloriesBurnedRecord::class -> "total_calories_burned"
        HeartRateRecord::class -> "heart_rate"
        SleepSessionRecord::class -> "sleep_session"
        WeightRecord::class -> "weight"
        BodyFatRecord::class -> "body_fat"
        else -> error("Unsupported Health Connect record: ${type.simpleName}")
    }

    /** The time the server stores as start_at: the start of an interval, or an instant's time. */
    fun startOf(record: Record): Instant = when (record) {
        is ExerciseSessionRecord -> record.startTime
        is StepsRecord -> record.startTime
        is DistanceRecord -> record.startTime
        is TotalCaloriesBurnedRecord -> record.startTime
        is HeartRateRecord -> record.startTime
        is SleepSessionRecord -> record.startTime
        is WeightRecord -> record.time
        is BodyFatRecord -> record.time
        else -> error("Unsupported Health Connect record: ${record::class.simpleName}")
    }

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
