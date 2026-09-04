import assert from 'node:assert/strict';
import test from 'node:test';
import { Repository } from '../src/data/database.js';
import type { HealthConnectBatchInput } from '../src/health/types.js';

const NOW = new Date('2026-09-05T10:00:00.000Z');

function record(
  id: string,
  dataType: HealthConnectBatchInput['records'][number]['dataType'],
  startTime: string,
  endTime: string,
  payload: Record<string, unknown>,
): HealthConnectBatchInput['records'][number] {
  return {
    id,
    dataType,
    dataOrigin: 'com.garmin.android.apps.connectmobile',
    startTime,
    endTime,
    lastModifiedTime: endTime,
    payload,
  };
}

test('Health Connect builds a safe, complete platform projection and measured exercise time', () => {
  const repository = new Repository(':memory:');
  const batch: HealthConnectBatchInput = {
    syncId: 'health-projection-sync-0001',
    deviceId: 'health-projection-device-01',
    observedAt: NOW.toISOString(),
    deletedRecordIds: [],
    records: [
      record('raw-step-a', 'steps', '2026-09-05T00:00:00Z', '2026-09-05T01:00:00Z', { count: 1000 }),
      record('raw-step-b', 'steps', '2026-09-05T01:00:00Z', '2026-09-05T02:00:00Z', { count: 2000 }),
      record('raw-distance', 'distance', '2026-09-05T00:00:00Z', '2026-09-05T02:00:00Z', { meters: 1500 }),
      record('raw-calories', 'total_calories_burned', '2026-09-05T00:00:00Z', '2026-09-05T02:00:00Z', { kilocalories: 500 }),
      record('raw-workout', 'exercise_session', '2026-09-05T00:10:00Z', '2026-09-05T00:40:00Z', { exerciseType: 79, title: null }),
      record('raw-sleep', 'sleep_session', '2026-09-04T16:00:00Z', '2026-09-05T00:00:00Z', { stages: [] }),
      record('raw-heart', 'heart_rate', '2026-09-05T00:00:00Z', '2026-09-05T00:05:00Z', {
        samples: [
          { time: '2026-09-05T00:01:00Z', beatsPerMinute: 60 },
          { time: '2026-09-05T00:02:00Z', beatsPerMinute: 100 },
        ],
      }),
      record('raw-weight', 'weight', '2026-09-05T00:00:00Z', '2026-09-05T00:00:00Z', { kilograms: 70.25 }),
      record('raw-body-fat', 'body_fat', '2026-09-05T00:00:00Z', '2026-09-05T00:00:00Z', { percentage: 20.4 }),
    ],
  };
  repository.ingestHealthConnect(batch, NOW.toISOString());

  const snapshot = repository.healthConnectSnapshot('Sky', NOW);
  assert.equal(snapshot.source, 'health');
  assert.equal(snapshot.stats.records, 9);
  assert.equal(snapshot.stats.totalSteps, 3000);
  assert.equal(snapshot.stats.totalDistanceKm, 1.5);
  assert.equal(snapshot.stats.workouts, 1);
  assert.deepEqual(snapshot.extra.daily[0], {
    day: '2026-09-05', steps: 3000, distanceMeters: 1500, kilocalories: 500,
    exerciseSeconds: 1800, sleepSeconds: 28800,
    heartRateAverage: 80, heartRateMinimum: 60, heartRateMaximum: 100,
  });
  assert.deepEqual(snapshot.extra.latest, {
    weightKilograms: 70.3, weightAt: '2026-09-05T00:00:00Z',
    bodyFatPercentage: 20.4, bodyFatAt: '2026-09-05T00:00:00Z',
  });
  const workout = snapshot.entries.find((entry) => entry.status === 'workout');
  assert.equal(workout?.title, 'Walking');
  assert.equal(workout?.extra.durationMinutes, 30);
  assert.doesNotMatch(JSON.stringify(snapshot), /raw-workout|com\.garmin|beatsPerMinute/);

  const healthTime = repository.timeSpent(NOW).sources.find((entry) => entry.source === 'health');
  assert.equal(healthTime?.method, 'measured');
  assert.deepEqual(healthTime?.windows, {
    last24h: 1800, day: 1800, week: 1800, month: 1800, year: 1800, allTime: 1800,
  });
  repository.close();
});
