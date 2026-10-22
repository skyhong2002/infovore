import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { Repository } from '../src/data/database.js';
import type { HealthConnectRecordInput, HealthConnectStatus } from '../src/health/types.js';

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

test('Health status memo follows Health commits and preserves received-time metadata ordering', t => {
  const dir = mkdtempSync(join(tmpdir(), 'health-status-cache-'));
  const reader = new Repository(join(dir, 'fixture.sqlite'));
  const writer = new Repository(join(dir, 'fixture.sqlite'));
  const reads = t.mock.method(reader as unknown as { readHealthConnectStatus(): HealthConnectStatus }, 'readHealthConnectStatus');
  try {
    assert.deepEqual(reader.healthConnectStatus(), { totalStored: 0, lastSyncedAt: null, lastDeviceId: null, recordsByType: {} });
    reader.healthConnectStatus();
    assert.equal(reads.mock.callCount(), 1);
    writer.ingestHealthConnect(batch('status-one', [record('one', 'steps', received)]), received);
    assert.deepEqual(reader.healthConnectStatus(), {
      totalStored: 1, lastSyncedAt: received, lastDeviceId: 'fixture-health', recordsByType: { steps: 1 },
    });
    assert.equal(reads.mock.callCount(), 2);
    writer.dayflow.ingest({ schemaVersion: 1, deviceId: 'fixture-dayflow', day: '2026-09-05', observedAt: received,
      timeZone: 'Asia/Taipei', dayBoundaryHour: 4, categories: [], cards: [] }, received);
    writer.computai.ingestSegments({ schemaVersion: 1, deviceId: 'fixture-computai', observedAt: received,
      from: '2026-09-04T00:00:00Z', to: '2026-09-05T00:00:00Z', segments: [] }, received);
    reader.startSync('kitsu', received);
    assert.equal(reader.healthConnectStatus().totalStored, 1);
    assert.equal(reads.mock.callCount(), 2, 'unrelated local and external writes must not rescan Health');
    // Same timestamp, new identity, changed type and count on another connection.
    writer.ingestHealthConnect(batch('status-two', [record('one', 'sleep_session', received), record('two', 'steps', received)]), received);
    const status = reader.healthConnectStatus();
    assert.equal(status.totalStored, 2);
    assert.deepEqual(status.recordsByType, { sleep_session: 1, steps: 1 });
    assert.equal(reads.mock.callCount(), 3);
    status.totalStored = 999;
    status.recordsByType.steps = 999;
    assert.equal(reader.healthConnectStatus().totalStored, 2);
    assert.deepEqual(reader.healthConnectStatus().recordsByType, { sleep_session: 1, steps: 1 });
    reader.ingestHealthConnect(batch('status-three', [], ['one']), received);
    assert.deepEqual(reader.healthConnectStatus().recordsByType, { steps: 1 });
    assert.equal(reader.healthConnectStatus().totalStored, 1);
    assert.equal(reads.mock.callCount(), 4);
    reader.ingestHealthConnect(batch('status-three', [], ['two']), received);
    assert.equal(reader.healthConnectStatus().totalStored, 1);
    assert.equal(reads.mock.callCount(), 4, 'duplicate sync IDs do not change data or invalidate');
    // Revision is insertion order; public latest metadata remains received_at order.
    writer.ingestHealthConnect({ ...batch('status-older', [record('three', 'heart_rate', received)]), deviceId: 'older-device' }, '2026-09-06T00:00:00.000Z');
    const afterOlder = reader.healthConnectStatus();
    assert.equal(afterOlder.totalStored, 2);
    assert.deepEqual(afterOlder.recordsByType, { heart_rate: 1, steps: 1 });
    assert.equal(afterOlder.lastSyncedAt, received);
    assert.equal(afterOlder.lastDeviceId, 'fixture-health');
    assert.equal(reads.mock.callCount(), 5);
    writer.ingestHealthConnect({ ...batch('status-newer', [], ['two', 'three']), deviceId: 'newer-device' }, '2026-09-08T00:00:00.000Z');
    assert.deepEqual(reader.healthConnectStatus(), {
      totalStored: 0, lastSyncedAt: '2026-09-08T00:00:00.000Z', lastDeviceId: 'newer-device', recordsByType: {},
    });
    assert.equal(reads.mock.callCount(), 6);
  } finally { reader.close(); writer.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('failed Health status computation does not cache the failed revision', t => {
  const repository = new Repository(':memory:');
  const internal = repository as unknown as { readHealthConnectStatus(): HealthConnectStatus };
  const original = internal.readHealthConnectStatus;
  const failure = new Error('synthetic read failure');
  const reads = t.mock.method(internal, 'readHealthConnectStatus');
  try {
    repository.healthConnectStatus();
    repository.ingestHealthConnect(batch('status-after-failure', [record('one', 'steps', received)]), received);
    reads.mock.mockImplementationOnce(() => { throw failure; }, 1);
    assert.throws(() => repository.healthConnectStatus(), error => error === failure);
    reads.mock.mockImplementation(original);
    assert.equal(repository.healthConnectStatus().totalStored, 1);
    assert.equal(reads.mock.callCount(), 3);
  } finally { repository.close(); }
});
