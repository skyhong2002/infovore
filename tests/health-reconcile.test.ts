import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { Repository } from '../src/data/database.js';
import { createIngestApp } from '../src/ingest.js';
import { HealthReconcileRejected, MAX_RECONCILE_RECORD_IDS } from '../src/health/types.js';
import type { HealthConnectBatchInput, HealthConnectRecordInput } from '../src/health/types.js';

// Synthetic fixtures only: invented ids, devices and step counts.
const received = '2026-09-10T00:00:00.000Z';
const phone = 'fixture-phone-a';
const otherPhone = 'fixture-phone-b';
const windowStart = '2026-09-01T00:00:00.000Z';
const windowEnd = '2026-09-08T00:00:00.000Z';

const steps = (id: string, startTime: string, endTime = startTime): HealthConnectRecordInput => ({
  id, dataType: 'steps', dataOrigin: 'com.garmin.fixture', startTime, endTime,
  lastModifiedTime: received, payload: { count: 100 },
});
const batch = (syncId: string, deviceId: string, records: HealthConnectRecordInput[],
  extra: Partial<HealthConnectBatchInput> = {}): HealthConnectBatchInput => ({
  syncId, deviceId, observedAt: received, records, deletedRecordIds: [], ...extra,
});
const ids = (repository: Repository) => {
  const raw = (repository as unknown as { db: DatabaseSync }).db;
  return (raw.prepare('SELECT record_id FROM health_connect_records ORDER BY record_id').all() as Array<{ record_id: string }>)
    .map((row) => row.record_id);
};

test('A complete rescan deletes only the window rows the phone no longer has', () => {
  const repository = new Repository(':memory:');
  try {
    repository.ingestHealthConnect(batch('fixture-first-sync', phone, [
      steps('before-window', '2026-08-31T23:59:59.000Z', '2026-09-01T00:10:00.000Z'),
      steps('kept', '2026-09-01T00:00:00Z', '2026-09-01T00:15:00Z'),
      steps('deleted-at-source-1', '2026-09-02T08:00:00.000Z', '2026-09-02T08:15:00.000Z'),
      steps('deleted-at-source-2', '2026-09-03T08:00:00.000+08:00', '2026-09-03T08:15:00.000+08:00'),
      steps('also-kept', '2026-09-05T08:00:00.000Z', '2026-09-05T08:15:00.000Z'),
      steps('crosses-window-end', '2026-09-07T23:50:00.000Z', '2026-09-08T00:10:00.000Z'),
      steps('after-window', '2026-09-08T00:00:00.000Z', '2026-09-08T00:15:00.000Z'),
    ]), received);
    repository.ingestHealthConnect(batch('fixture-other-sync', otherPhone, [
      steps('other-device-in-window', '2026-09-04T08:00:00.000Z', '2026-09-04T08:15:00.000Z'),
    ]), received);

    // The rescan read [windowStart, windowEnd) completely and found only these ids.
    const result = repository.ingestHealthConnect(batch('fixture-rescan', phone, [], {
      reconcile: { dataType: 'steps', start: windowStart, end: windowEnd, recordIds: ['kept', 'also-kept', 'not-stored-yet'] },
    }), received);

    assert.equal(result.deleted, 2);
    assert.deepEqual(result.reconciled, { dataType: 'steps', start: windowStart, end: windowEnd, checked: 4, deleted: 2 });
    assert.deepEqual(ids(repository), [
      'after-window', 'also-kept', 'before-window', 'crosses-window-end', 'kept', 'other-device-in-window',
    ]);

    // Other data types in the same window are untouched.
    repository.ingestHealthConnect(batch('fixture-sleep', phone, [{
      ...steps('sleep-in-window', '2026-09-02T00:00:00.000Z', '2026-09-02T07:00:00.000Z'), dataType: 'sleep_session',
    }]), received);
    repository.ingestHealthConnect(batch('fixture-rescan-2', phone, [], {
      reconcile: { dataType: 'steps', start: windowStart, end: windowEnd, recordIds: ['kept', 'also-kept'] },
    }), received);
    assert.ok(ids(repository).includes('sleep-in-window'));
  } finally {
    repository.close();
  }
});

test('Batches without a reconcile window keep the old upsert-only behaviour', () => {
  const repository = new Repository(':memory:');
  try {
    repository.ingestHealthConnect(batch('fixture-legacy-1', phone, [steps('one', '2026-09-02T00:00:00.000Z')]), received);
    const result = repository.ingestHealthConnect(batch('fixture-legacy-2', phone, [steps('two', '2026-09-03T00:00:00.000Z')]), received);
    assert.deepEqual(result, { inserted: 1, updated: 0, deleted: 0, totalStored: 2 });
    assert.deepEqual(ids(repository), ['one', 'two']);
  } finally {
    repository.close();
  }
});

test('An implausibly large reconcile deletion is refused and rolls back the whole batch', () => {
  const repository = new Repository(':memory:');
  try {
    const stored = Array.from({ length: 30 }, (_, index) =>
      steps(`stored-${String(index).padStart(2, '0')}`, `2026-09-0${1 + (index % 6)}T0${index % 10}:00:00.000Z`));
    repository.ingestHealthConnect(batch('fixture-many', phone, stored), received);

    // 25 of 30 would go: more than 20 and more than half.
    assert.throws(() => repository.ingestHealthConnect(batch('fixture-suspicious', phone, [steps('new-row', '2026-09-09T12:00:00.000Z')], {
      reconcile: { dataType: 'steps', start: windowStart, end: windowEnd, recordIds: stored.slice(0, 5).map((row) => row.id) },
    }), received), (error) => error instanceof HealthReconcileRejected && error.wouldDelete === 25 && error.checked === 30);
    assert.equal(ids(repository).length, 30);
    assert.ok(!ids(repository).includes('new-row'), 'the rejected batch commits nothing');

    // The same sync id can be retried later because nothing was recorded.
    const allowed = repository.ingestHealthConnect(batch('fixture-suspicious', phone, [], {
      reconcile: { dataType: 'steps', start: windowStart, end: windowEnd, recordIds: stored.slice(0, 14).map((row) => row.id) },
    }), received);
    // 16 of 30 is more than half but within the small-deletion allowance.
    assert.equal(allowed.deleted, 16);

    // Twenty deletions are always allowed, even when they are every stored row.
    const few = new Repository(':memory:');
    try {
      few.ingestHealthConnect(batch('fixture-few', phone, stored.slice(0, 20)), received);
      const emptied = few.ingestHealthConnect(batch('fixture-few-rescan', phone, [], {
        reconcile: { dataType: 'steps', start: windowStart, end: windowEnd, recordIds: [] },
      }), received);
      assert.equal(emptied.deleted, 20);
    } finally {
      few.close();
    }
  } finally {
    repository.close();
  }
});

test('A retried reconcile request reports that it was already applied', () => {
  const repository = new Repository(':memory:');
  try {
    repository.ingestHealthConnect(batch('fixture-retry-seed', phone, [steps('gone', '2026-09-02T00:00:00.000Z')]), received);
    const request = batch('fixture-retry', phone, [], {
      reconcile: { dataType: 'steps', start: windowStart, end: windowEnd, recordIds: [] },
    });
    assert.equal(repository.ingestHealthConnect(request, received).deleted, 1);
    const repeated = repository.ingestHealthConnect(request, received);
    assert.equal(repeated.deleted, 0);
    assert.equal(repeated.reconciled?.alreadyApplied, true);
  } finally {
    repository.close();
  }
});

test('The ingest endpoint validates reconcile windows and reports refusals', async () => {
  const repository = new Repository(':memory:');
  const ingest = createIngestApp(repository);
  const headers = { 'content-type': 'application/json', authorization: 'Bearer test-token-with-at-least-32-characters' };
  const post = (body: unknown) => ingest.request('/api/ingest/health-connect', { method: 'POST', headers, body: JSON.stringify(body) });
  const reconcile = (recordIds: string[], overrides: Record<string, unknown> = {}) =>
    ({ dataType: 'steps', start: windowStart, end: windowEnd, recordIds, ...overrides });
  try {
    const seed = Array.from({ length: 30 }, (_, index) => steps(`http-${index}`, `2026-09-02T${String(index % 24).padStart(2, '0')}:00:00.000Z`));
    assert.equal((await post(batch('fixture-http-seed', phone, seed))).status, 201);

    const tooMany = Array.from({ length: MAX_RECONCILE_RECORD_IDS + 1 }, (_, index) => `id-${index}`);
    assert.equal((await post(batch('fixture-http-too-many', phone, [], { reconcile: reconcile(tooMany) as never }))).status, 400);
    assert.equal((await post(batch('fixture-http-bad-type', phone, [], { reconcile: reconcile([], { dataType: 'blood_glucose' }) as never }))).status, 400);
    assert.equal((await post(batch('fixture-http-bad-time', phone, [], { reconcile: reconcile([], { start: 'last week' }) as never }))).status, 400);
    assert.equal((await post(batch('fixture-http-reversed', phone, [], { reconcile: reconcile([], { start: windowEnd, end: windowStart }) as never }))).status, 400);
    assert.equal((await post(batch('fixture-http-extra-key', phone, [], { reconcile: reconcile([], { deleteAll: true }) as never }))).status, 400);
    assert.equal((await post(batch('fixture-http-empty-id', phone, [], { reconcile: reconcile(['']) as never }))).status, 400);
    assert.equal(ids(repository).length, 30, 'invalid requests delete nothing');

    const refused = await post(batch('fixture-http-refused', phone, [], { reconcile: reconcile([]) as never }));
    assert.equal(refused.status, 409);
    const refusal = await refused.json() as { reconcile: { status: string; wouldDelete: number; checked: number } };
    assert.deepEqual(refusal.reconcile, { status: 'rejected', wouldDelete: 30, checked: 30 });
    assert.equal(ids(repository).length, 30);

    const accepted = await post(batch('fixture-http-ok', phone, [], { reconcile: reconcile(seed.slice(1).map((row) => row.id)) as never }));
    assert.equal(accepted.status, 200);
    const body = await accepted.json() as { deleted: number; reconciled: { checked: number; deleted: number } };
    assert.equal(body.deleted, 1);
    assert.equal(body.reconciled.checked, 30);
    assert.equal(ids(repository).length, 29);
  } finally {
    repository.close();
  }
});

test('Migration 19 records the uploading device, backfilling only an unambiguous one', () => {
  const dir = mkdtempSync(join(tmpdir(), 'health-reconcile-migration-'));
  const downgrade = (path: string, devices: string[]) => {
    new Repository(path).close();
    const raw = new DatabaseSync(path);
    raw.exec(`
      DROP INDEX health_connect_records_device_type_time_idx;
      ALTER TABLE health_connect_records DROP COLUMN device_id;
      PRAGMA user_version = 18;
    `);
    raw.prepare(`INSERT INTO health_connect_records VALUES ('legacy-row', 'steps', 'com.garmin.fixture',
      '2026-09-02T00:00:00.000Z', '2026-09-02T00:15:00.000Z', ?, '{"count":1}', ?, ?)`).run(received, received, received);
    devices.forEach((device, index) => raw.prepare(`INSERT INTO health_connect_syncs VALUES (?, ?, ?, ?, 1, 1, 0, 0)`)
      .run(`fixture-legacy-sync-${index}`, device, received, received));
    raw.close();
  };
  const deviceOf = (path: string) => {
    const raw = new DatabaseSync(path);
    try {
      return {
        version: (raw.prepare('PRAGMA user_version').get() as { user_version: number }).user_version,
        device: (raw.prepare(`SELECT device_id FROM health_connect_records WHERE record_id='legacy-row'`).get() as { device_id: string | null }).device_id,
      };
    } finally {
      raw.close();
    }
  };
  try {
    const single = join(dir, 'single.sqlite');
    downgrade(single, [phone, phone]);
    const migratedSingle = new Repository(single);
    migratedSingle.close();
    assert.deepEqual(deviceOf(single), { version: 19, device: phone });

    const shared = join(dir, 'shared.sqlite');
    downgrade(shared, [phone, otherPhone]);
    const repository = new Repository(shared);
    try {
      assert.deepEqual(deviceOf(shared), { version: 19, device: null });
      // A row of unknown origin is never reconciled away.
      const result = repository.ingestHealthConnect(batch('fixture-unknown-origin', phone, [], {
        reconcile: { dataType: 'steps', start: windowStart, end: windowEnd, recordIds: [] },
      }), received);
      assert.equal(result.deleted, 0);
      assert.deepEqual(ids(repository), ['legacy-row']);
      // Re-uploading the record claims it for the uploading device.
      repository.ingestHealthConnect(batch('fixture-claim', phone, [steps('legacy-row', '2026-09-02T00:00:00.000Z', '2026-09-02T00:15:00.000Z')]), received);
      assert.equal(repository.ingestHealthConnect(batch('fixture-after-claim', phone, [], {
        reconcile: { dataType: 'steps', start: windowStart, end: windowEnd, recordIds: [] },
      }), received).deleted, 1);
    } finally {
      repository.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('Large windows may only lose a small share, and never more than 200 rows at once', () => {
  const day = (index: number) => new Date(Date.parse(windowStart) + (index % 6) * 86_400_000 + index * 1000).toISOString();
  const fill = (repository: Repository, count: number) => {
    const rows = Array.from({ length: count }, (_, index) => steps(`bulk-${String(index).padStart(5, '0')}`, day(index)));
    repository.ingestHealthConnect(batch(`fixture-bulk-${count}`, phone, rows), received);
    return rows.map((row) => row.id);
  };
  const small = new Repository(':memory:');
  try {
    const stored = fill(small, 1000);
    // 99 of 1,000 (under 10%) is accepted.
    const result = small.ingestHealthConnect(batch('fixture-bulk-ok', phone, [], {
      reconcile: { dataType: 'steps', start: windowStart, end: windowEnd, recordIds: stored.slice(99) },
    }), received);
    assert.equal(result.deleted, 99);
    // 150 of the remaining 901 (over 10%) is refused.
    assert.throws(() => small.ingestHealthConnect(batch('fixture-bulk-share', phone, [], {
      reconcile: { dataType: 'steps', start: windowStart, end: windowEnd, recordIds: stored.slice(249) },
    }), received), HealthReconcileRejected);
  } finally {
    small.close();
  }
  const large = new Repository(':memory:');
  try {
    const stored = fill(large, 3000);
    // 250 of 3,000 is under 10% but over the absolute ceiling.
    assert.throws(() => large.ingestHealthConnect(batch('fixture-bulk-cap', phone, [], {
      reconcile: { dataType: 'steps', start: windowStart, end: windowEnd, recordIds: stored.slice(250) },
    }), received), HealthReconcileRejected);
    assert.equal(ids(large).length, 3000);
  } finally {
    large.close();
  }
});
