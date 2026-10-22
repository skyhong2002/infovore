import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { Repository } from '../src/data/database.js';
import type { HealthConnectRecordInput } from '../src/health/types.js';

const received = '2026-09-07T00:00:00.000Z';
const record = (id: string, dataType: HealthConnectRecordInput['dataType'], startTime: string,
  dataOrigin = 'com.garmin.fixture'): HealthConnectRecordInput => ({
  id, dataType, dataOrigin, startTime, endTime: startTime, lastModifiedTime: received, payload: { count: 10 },
});
const batch = (syncId: string, records: HealthConnectRecordInput[], deletedRecordIds: string[] = []) => ({
  syncId, deviceId: 'fixture-health', observedAt: received, records, deletedRecordIds,
});

test('Health count memo follows Health sync identity across connections, not other stores or timestamps', t => {
  const dir = mkdtempSync(join(tmpdir(), 'health-count-cache-'));
  const reader = new Repository(join(dir, 'fixture.sqlite'));
  const writer = new Repository(join(dir, 'fixture.sqlite'));
  const reads = t.mock.method(reader as unknown as {
    readHealthActivityCounts(start: string, end: string): { sleep: number; workouts: number; stepDays: number };
  }, 'readHealthActivityCounts');
  try {
    assert.deepEqual(reader.healthActivityCounts(), { sleep: 0, workouts: 0, stepDays: 0 });
    reader.healthActivityCounts();
    assert.equal(reads.mock.callCount(), 1);
    writer.ingestHealthConnect(batch('fixture-sync-one', [record('steps-one', 'steps', '2026-09-04T10:00:00Z')]), received);
    assert.deepEqual(reader.healthActivityCounts(), { sleep: 0, workouts: 0, stepDays: 1 });
    assert.equal(reads.mock.callCount(), 2);
    writer.dayflow.ingest({ schemaVersion: 1, deviceId: 'fixture-dayflow', day: '2026-09-05', observedAt: received,
      timeZone: 'Asia/Taipei', dayBoundaryHour: 4, categories: [], cards: [] }, received);
    writer.computai.ingestSegments({ schemaVersion: 1, deviceId: 'fixture-computai', observedAt: received,
      from: '2026-09-04T00:00:00Z', to: '2026-09-05T00:00:00Z', segments: [] }, received);
    assert.deepEqual(reader.healthActivityCounts(), { sleep: 0, workouts: 0, stepDays: 1 });
    assert.equal(reads.mock.callCount(), 2, 'unrelated commits must not rerun the Health aggregate');
    // Equal received_at still represents a different, committed Health batch.
    writer.ingestHealthConnect(batch('fixture-sync-two', [record('sleep-one', 'sleep_session', '2026-09-04T10:00:00Z')]), received);
    assert.deepEqual(reader.healthActivityCounts(), { sleep: 1, workouts: 0, stepDays: 1 });
    assert.equal(reads.mock.callCount(), 3);
    writer.ingestHealthConnect(batch('fixture-sync-three', [], ['steps-one']), received);
    assert.deepEqual(reader.healthActivityCounts(), { sleep: 1, workouts: 0, stepDays: 0 });
    assert.equal(reads.mock.callCount(), 4);
    // Same-connection writes also advance the sync ID; duplicate batches do not.
    reader.ingestHealthConnect(batch('fixture-sync-four', [record('sleep-one', 'exercise_session', '2026-09-04T10:00:00Z')]), received);
    const result = reader.healthActivityCounts();
    assert.deepEqual(result, { sleep: 0, workouts: 1, stepDays: 0 });
    result.workouts = 999;
    reader.ingestHealthConnect(batch('fixture-sync-four', [], ['sleep-one']), received);
    assert.deepEqual(reader.healthActivityCounts(), { sleep: 0, workouts: 1, stepDays: 0 });
    assert.equal(reads.mock.callCount(), 5);
  } finally { reader.close(); writer.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('typed Health origins preserve whole Taipei-day winners and exact half-open bounds', () => {
  const repository = new Repository(':memory:');
  try {
    repository.ingestHealthConnect(batch('fixture-origin-bounds', [
      record('sleep-preferred-outside-window', 'sleep_session', '2026-09-04T15:00:00Z'),
      record('sleep-lower-inside-window', 'sleep_session', '2026-09-04T10:00:00Z', 'com.fitbit.fixture'),
      // 16:00 UTC begins a different Taipei day, with its own fallback winner.
      record('sleep-next-taipei-day', 'sleep_session', '2026-09-04T16:00:00Z', 'com.fitbit.fixture'),
      record('exercise-at-lower-bound', 'exercise_session', '2026-09-04T09:00:00Z'),
      record('exercise-at-upper-bound', 'exercise_session', '2026-09-04T12:00:00Z'),
      record('steps-one', 'steps', '2026-09-04T10:00:00Z'),
      record('steps-two', 'steps', '2026-09-04T11:00:00Z'),
      record('unrelated-type', 'heart_rate', '2026-09-04T10:00:00Z', 'com.garmin.other'),
    ]), received);
    assert.deepEqual(repository.healthActivityCounts(), { sleep: 2, workouts: 2, stepDays: 1 });
    assert.deepEqual(repository.healthActivityCounts('2026-09-04T09:00:00Z', '2026-09-04T12:00:00Z'),
      { sleep: 0, workouts: 1, stepDays: 1 });
    assert.deepEqual(repository.healthActivityCounts('2026-09-04T16:00:00Z', '2026-09-05T00:00:00Z'),
      { sleep: 1, workouts: 0, stepDays: 0 });
    assert.deepEqual(repository.healthActivityCounts('2027', '2028'), { sleep: 0, workouts: 0, stepDays: 0 });
    assert.deepEqual(repository.healthActivityCounts(), { sleep: 2, workouts: 2, stepDays: 1 });
  } finally { repository.close(); }
});
