import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { Repository } from '../src/data/database.js';
import { createIngestApp } from '../src/ingest.js';
import {
  countByOrigin, HealthReconcileRejected, MAX_CONFIRMED_RECONCILE_DELETES, MAX_ORIGIN_COUNTS, MAX_RECONCILE_RECORD_IDS,
  reconcileConfirmToken,
} from '../src/health/types.js';
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
// The confirm token the server names this device's steps rows `stale` with, for the default window.
const tokenFor = (stale: string[], deviceId = phone, start = windowStart, end = windowEnd) =>
  reconcileConfirmToken(deviceId, 'steps', Date.parse(start), Date.parse(end), stale);
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
    assert.deepEqual(refusal.reconcile, {
      status: 'rejected', wouldDelete: 30, checked: 30, byOrigin: [{ origin: 'com.garmin.fixture', count: 30 }],
      confirmToken: tokenFor(seed.map((row) => row.id)),
    });
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
      DROP TABLE health_connect_confirmed_deletes;
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
    assert.deepEqual(deviceOf(single), { version: 21, device: phone });

    const shared = join(dir, 'shared.sqlite');
    downgrade(shared, [phone, otherPhone]);
    const repository = new Repository(shared);
    try {
      assert.deepEqual(deviceOf(shared), { version: 21, device: null });
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

// User-confirmed deletions beyond the automatic limits (confirmDelete).
const audit = (repository: Repository) => {
  const raw = (repository as unknown as { db: DatabaseSync }).db;
  return raw.prepare('SELECT * FROM health_connect_confirmed_deletes ORDER BY id').all() as Array<Record<string, unknown>>;
};
const fillWindow = (repository: Repository, count: number, prefix = 'confirm') => {
  const rows = Array.from({ length: count }, (_, index) => steps(
    `${prefix}-${String(index).padStart(5, '0')}`,
    new Date(Date.parse(windowStart) + (index % 6) * 86_400_000 + index * 1000).toISOString(),
  ));
  repository.ingestHealthConnect(batch(`fixture-${prefix}-${count}`, phone, rows), received);
  return rows.map((row) => row.id);
};

test('A confirmed deletion with the wrong count is refused and deletes nothing', () => {
  const repository = new Repository(':memory:');
  try {
    const stored = fillWindow(repository, 30);
    // 25 of 30 would go: refused without confirmation.
    const window = { dataType: 'steps' as const, start: windowStart, end: windowEnd, recordIds: stored.slice(0, 5) };
    assert.throws(() => repository.ingestHealthConnect(batch('fixture-confirm-none', phone, [], { reconcile: window }), received),
      (error) => error instanceof HealthReconcileRejected && error.wouldDelete === 25 && error.checked === 30);
    const token = tokenFor(stored.slice(5));
    for (const expected of [24, 26, 1]) {
      assert.throws(() => repository.ingestHealthConnect(batch(`fixture-confirm-wrong-${expected}`, phone, [], {
        reconcile: { ...window, confirmDelete: { expected, token } },
      }), received), (error) => error instanceof HealthReconcileRejected && error.wouldDelete === 25 && error.checked === 30
        && error.confirmToken === token);
    }
    assert.equal(ids(repository).length, 30);
    assert.deepEqual(audit(repository), []);
  } finally {
    repository.close();
  }
});

test('A confirmed deletion with the exact count goes beyond the limits and is audited without record ids', () => {
  const repository = new Repository(':memory:');
  try {
    const stored = fillWindow(repository, 30);
    const result = repository.ingestHealthConnect(batch('fixture-confirm-ok', phone, [], {
      reconcile: {
        dataType: 'steps', start: windowStart, end: windowEnd, recordIds: stored.slice(0, 5),
        confirmDelete: { expected: 25, token: tokenFor(stored.slice(5)) },
      },
    }), '2026-09-11T00:00:00.000Z');
    assert.equal(result.deleted, 25);
    assert.deepEqual(result.reconciled, {
      dataType: 'steps', start: windowStart, end: windowEnd, checked: 30, deleted: 25, confirmed: true,
      byOrigin: [{ origin: 'com.garmin.fixture', count: 25 }],
    });
    assert.deepEqual(ids(repository), stored.slice(0, 5));
    const rows = audit(repository);
    assert.equal(rows.length, 1);
    assert.deepEqual({ ...rows[0], id: undefined }, {
      id: undefined,
      confirmed_at: '2026-09-11T00:00:00.000Z',
      device_id: phone,
      data_type: 'steps',
      window_start: windowStart,
      window_end: windowEnd,
      deleted_count: 25,
      checked_count: 30,
    });
    // Only counts and the window: no record ids or health values anywhere in the row.
    const text = JSON.stringify(rows);
    assert.ok(!stored.some((id) => text.includes(id)));
    assert.ok(!text.includes('count":100'));

    // Retrying the same sync id reports it as already applied and audits nothing twice.
    const repeated = repository.ingestHealthConnect(batch('fixture-confirm-ok', phone, [], {
      reconcile: { dataType: 'steps', start: windowStart, end: windowEnd, recordIds: [], confirmDelete: { expected: 25 } },
    }), received);
    assert.equal(repeated.reconciled?.alreadyApplied, true);
    assert.equal(audit(repository).length, 1);
  } finally {
    repository.close();
  }
});

test('No confirmation lifts the hard ceiling of 2,000 deletions', () => {
  const repository = new Repository(':memory:');
  try {
    const over = MAX_CONFIRMED_RECONCILE_DELETES + 1;
    const stored = fillWindow(repository, over);
    assert.throws(() => repository.ingestHealthConnect(batch('fixture-confirm-ceiling', phone, [], {
      reconcile: {
        dataType: 'steps', start: windowStart, end: windowEnd, recordIds: [],
        confirmDelete: { expected: over, token: tokenFor(stored) },
      },
    }), received), (error) => error instanceof HealthReconcileRejected && error.wouldDelete === over && error.checked === over);
    assert.equal(ids(repository).length, over);
    assert.deepEqual(audit(repository), []);
  } finally {
    repository.close();
  }
  const exact = new Repository(':memory:');
  try {
    const stored = fillWindow(exact, MAX_CONFIRMED_RECONCILE_DELETES);
    const result = exact.ingestHealthConnect(batch('fixture-confirm-at-ceiling', phone, [], {
      reconcile: {
        dataType: 'steps', start: windowStart, end: windowEnd, recordIds: [],
        confirmDelete: { expected: MAX_CONFIRMED_RECONCILE_DELETES, token: tokenFor(stored) },
      },
    }), received);
    assert.equal(result.deleted, MAX_CONFIRMED_RECONCILE_DELETES);
    assert.equal(audit(exact).length, 1);
  } finally {
    exact.close();
  }
});

test('Over HTTP, confirmDelete is validated, refusals carry only counts, and old clients are unaffected', async () => {
  const repository = new Repository(':memory:');
  const ingest = createIngestApp(repository);
  const headers = { 'content-type': 'application/json', authorization: 'Bearer test-token-with-at-least-32-characters' };
  const post = (body: unknown) => ingest.request('/api/ingest/health-connect', { method: 'POST', headers, body: JSON.stringify(body) });
  const reconcile = (recordIds: string[], extra: Record<string, unknown> = {}) =>
    ({ dataType: 'steps', start: windowStart, end: windowEnd, recordIds, ...extra });
  try {
    const stored = fillWindow(repository, 30, 'http-confirm');
    for (const [label, confirmDelete] of [
      ['zero', { expected: 0 }], ['negative', { expected: -3 }], ['fraction', { expected: 2.5 }],
      ['string', { expected: '25' }], ['missing', {}], ['extra-key', { expected: 25, force: true }], ['null', null],
      ['short-token', { expected: 25, token: 'abc' }], ['upper-token', { expected: 25, token: 'A'.repeat(64) }],
      ['number-token', { expected: 25, token: 7 }],
    ] as const) {
      const response = await post(batch(`fixture-http-confirm-${label}`, phone, [], { reconcile: reconcile([], { confirmDelete }) as never }));
      assert.equal(response.status, 400, label);
    }
    assert.equal(ids(repository).length, 30, 'invalid confirmations delete nothing');

    // An old client (no confirmDelete) gets the same counts as before; the added
    // byOrigin (source-app counts only) is a new field such clients ignore.
    const legacy = await post(batch('fixture-http-legacy', phone, [], { reconcile: reconcile(stored.slice(0, 5)) as never }));
    assert.equal(legacy.status, 409);
    const legacyBody = await legacy.json() as Record<string, unknown>;
    const token = tokenFor(stored.slice(5));
    const refusal = { status: 'rejected', wouldDelete: 25, checked: 30, byOrigin: [{ origin: 'com.garmin.fixture', count: 25 }], confirmToken: token };
    assert.deepEqual(legacyBody.reconcile, refusal);

    // A confirmation without the token (clients before 0.4.4) is always refused,
    // even with the right count, and answered with the token to confirm.
    const untokened = await post(batch('fixture-http-untokened', phone, [], {
      reconcile: reconcile(stored.slice(0, 5), { confirmDelete: { expected: 25 } }) as never,
    }));
    assert.equal(untokened.status, 409);
    assert.deepEqual((await untokened.json() as Record<string, unknown>).reconcile, refusal);
    assert.equal(ids(repository).length, 30);

    // A wrong count is refused with fresh counts and no record content.
    const mismatch = await post(batch('fixture-http-mismatch', phone, [], {
      reconcile: reconcile(stored.slice(0, 5), { confirmDelete: { expected: 20, token } }) as never,
    }));
    assert.equal(mismatch.status, 409);
    const mismatchText = await mismatch.text();
    assert.deepEqual((JSON.parse(mismatchText) as Record<string, unknown>).reconcile, refusal);
    assert.ok(!stored.some((id) => mismatchText.includes(id)));
    assert.equal(ids(repository).length, 30);

    const confirmed = await post(batch('fixture-http-confirmed', phone, [], {
      reconcile: reconcile(stored.slice(0, 5), { confirmDelete: { expected: 25, token } }) as never,
    }));
    assert.equal(confirmed.status, 200);
    const body = await confirmed.json() as { deleted: number; reconciled: { confirmed?: boolean; deleted: number } };
    assert.equal(body.deleted, 25);
    assert.equal(body.reconciled.confirmed, true);
    assert.equal(audit(repository).length, 1);

    // Ordinary reconciles after that behave as before and are not audited.
    const ordinary = await post(batch('fixture-http-ordinary', phone, [], { reconcile: reconcile(stored.slice(0, 4)) as never }));
    assert.equal(ordinary.status, 200);
    const ordinaryBody = await ordinary.json() as { reconciled: Record<string, unknown> };
    assert.equal(ordinaryBody.reconciled.confirmed, undefined);
    assert.equal(audit(repository).length, 1);
  } finally {
    repository.close();
  }
});

test('Migration 20 adds the confirmed-deletion audit table', () => {
  const repository = new Repository(':memory:');
  try {
    const raw = (repository as unknown as { db: DatabaseSync }).db;
    const columns = (raw.prepare('PRAGMA table_info(health_connect_confirmed_deletes)').all() as Array<{ name: string }>)
      .map((column) => column.name);
    assert.deepEqual(columns, [
      'id', 'confirmed_at', 'device_id', 'data_type', 'window_start', 'window_end', 'deleted_count', 'checked_count',
    ]);
    assert.equal((raw.prepare('PRAGMA user_version').get() as { user_version: number }).user_version, 21);
  } finally {
    repository.close();
  }
});

test('A reader that misses a record crossing or reaching the window end never gets it deleted', () => {
  // HealthConnectReaderTest (Android) pins that FakeHealthConnectClient only returns interval
  // records ending before the read range's end, so a record starting in the window and ending at
  // or after its end is missing from that window's recordIds. The server only deletes rows that
  // end before the window end, so such rows survive the reconcile; rows fully inside still go.
  const repository = new Repository(':memory:');
  try {
    repository.ingestHealthConnect(batch('fixture-crossing-seed', phone, [
      steps('listed', '2026-09-07T20:00:00.000Z', '2026-09-07T20:15:00.000Z'),
      steps('deleted-at-source', '2026-09-07T21:00:00.000Z', '2026-09-07T21:15:00.000Z'),
      steps('long-sleep-like', '2026-09-07T22:00:00.000Z', '2026-09-08T06:00:00.000Z'),
      steps('ends-at-window-end', '2026-09-07T23:00:00.000Z', windowEnd),
    ]), received);
    // The fake reader listed only `listed`: neither edge record is in recordIds.
    const result = repository.ingestHealthConnect(batch('fixture-crossing-rescan', phone, [], {
      reconcile: { dataType: 'steps', start: windowStart, end: windowEnd, recordIds: ['listed'] },
    }), received);
    assert.deepEqual(result.reconciled, { dataType: 'steps', start: windowStart, end: windowEnd, checked: 2, deleted: 1 });
    assert.deepEqual(ids(repository), ['ends-at-window-end', 'listed', 'long-sleep-like']);
  } finally {
    repository.close();
  }
});

test('Source-app counts list at most ten apps, largest first, and merge the rest into other', () => {
  assert.deepEqual(countByOrigin([]), []);
  assert.deepEqual(countByOrigin(['b.app', 'a.app', 'b.app', 'c.app', 'a.app', 'b.app']), [
    { origin: 'b.app', count: 3 }, { origin: 'a.app', count: 2 }, { origin: 'c.app', count: 1 },
  ]);
  const many = Array.from({ length: 12 }, (_, index) => `com.example.app${String(index).padStart(2, '0')}`);
  const origins = many.flatMap((origin, index) => Array(12 - index).fill(origin));
  const counted = countByOrigin(origins);
  assert.equal(counted.length, MAX_ORIGIN_COUNTS + 1);
  assert.deepEqual(counted.slice(0, 2), [{ origin: many[0], count: 12 }, { origin: many[1], count: 11 }]);
  // app10 (2 rows) and app11 (1 row) are merged.
  assert.deepEqual(counted.at(-1), { origin: 'other', count: 3 });
  assert.equal(counted.reduce((sum, entry) => sum + entry.count, 0), origins.length);
});

test('A refused or confirmed deletion reports which source apps the deleted rows came from', async () => {
  const repository = new Repository(':memory:');
  const ingest = createIngestApp(repository);
  const headers = { 'content-type': 'application/json', authorization: 'Bearer test-token-with-at-least-32-characters' };
  const post = (body: unknown) => ingest.request('/api/ingest/health-connect', { method: 'POST', headers, body: JSON.stringify(body) });
  try {
    const rows = Array.from({ length: 30 }, (_, index) => ({
      ...steps(`origin-${String(index).padStart(2, '0')}`, new Date(Date.parse(windowStart) + index * 3_600_000).toISOString()),
      dataOrigin: index < 20 ? 'com.garmin.fixture' : index < 27 ? 'com.fitbit.fixture' : 'com.example.kept',
    }));
    assert.equal((await post(batch('fixture-origin-seed', phone, rows))).status, 201);
    // The phone still has the three com.example.kept rows; the other 27 would go.
    const keep = rows.slice(27).map((row) => row.id);
    const window = { dataType: 'steps', start: windowStart, end: windowEnd, recordIds: keep };
    const expectedOrigins = [{ origin: 'com.garmin.fixture', count: 20 }, { origin: 'com.fitbit.fixture', count: 7 }];

    const refused = await post(batch('fixture-origin-refused', phone, [], { reconcile: window as never }));
    assert.equal(refused.status, 409);
    const text = await refused.text();
    const token = tokenFor(rows.slice(0, 27).map((row) => row.id));
    assert.deepEqual((JSON.parse(text) as { reconcile: unknown }).reconcile,
      { status: 'rejected', wouldDelete: 27, checked: 30, byOrigin: expectedOrigins, confirmToken: token });
    // Counts and package names only: no record ids or health values.
    assert.ok(!rows.some((row) => text.includes(row.id)));
    assert.ok(!text.includes('com.example.kept'));
    assert.ok(!text.includes('"count":100'));

    const confirmed = await post(batch('fixture-origin-confirmed', phone, [], {
      reconcile: { ...window, confirmDelete: { expected: 27, token } } as never,
    }));
    assert.equal(confirmed.status, 200);
    const body = await confirmed.json() as { reconciled: { byOrigin?: unknown; deleted: number } };
    assert.equal(body.reconciled.deleted, 27);
    assert.deepEqual(body.reconciled.byOrigin, expectedOrigins);
    assert.deepEqual(ids(repository), keep);

    // An ordinary (unconfirmed) reconcile response does not carry it.
    const ordinary = await post(batch('fixture-origin-ordinary', phone, [], { reconcile: window as never }));
    assert.equal((await ordinary.json() as { reconciled: { byOrigin?: unknown } }).reconciled.byOrigin, undefined);
  } finally {
    repository.close();
  }
});

test('A confirmation deletes only the set of rows the user was shown, never another set of the same size', async () => {
  // Round-7 reproduction (astra-6): two sources with 25 rows each. The refusal the user confirms
  // names source A's 25 rows; a later request listing a different keep set (so B's 25 rows would
  // go) with the same count must not delete anything. Neither may a set of the same source with
  // one id swapped. Only the exact set the token names is deleted.
  const repository = new Repository(':memory:');
  const ingest = createIngestApp(repository);
  const headers = { 'content-type': 'application/json', authorization: 'Bearer test-token-with-at-least-32-characters' };
  const post = (body: unknown) => ingest.request('/api/ingest/health-connect', { method: 'POST', headers, body: JSON.stringify(body) });
  const at = (index: number) => new Date(Date.parse(windowStart) + index * 3_600_000).toISOString();
  try {
    const sourceA = Array.from({ length: 25 }, (_, index) => ({ ...steps(`swap-a-${String(index).padStart(2, '0')}`, at(index)), dataOrigin: 'com.source.a' }));
    const sourceB = Array.from({ length: 25 }, (_, index) => ({ ...steps(`swap-b-${String(index).padStart(2, '0')}`, at(30 + index)), dataOrigin: 'com.source.b' }));
    assert.equal((await post(batch('fixture-swap-seed', phone, [...sourceA, ...sourceB]))).status, 201);
    const idsOf = (rows: HealthConnectRecordInput[]) => rows.map((row) => row.id);
    const window = (recordIds: string[], confirmDelete?: Record<string, unknown>) =>
      ({ dataType: 'steps', start: windowStart, end: windowEnd, recordIds, ...(confirmDelete ? { confirmDelete } : {}) });

    // The phone lists B: the server would delete A's 25 rows and says so.
    const refused = await post(batch('fixture-swap-refused', phone, [], { reconcile: window(idsOf(sourceB)) as never }));
    assert.equal(refused.status, 409);
    const shown = (await refused.json() as { reconcile: { wouldDelete: number; byOrigin: unknown; confirmToken: string } }).reconcile;
    assert.equal(shown.wouldDelete, 25);
    assert.deepEqual(shown.byOrigin, [{ origin: 'com.source.a', count: 25 }]);
    assert.match(shown.confirmToken, /^[0-9a-f]{64}$/);

    // Same count, other source: B's 25 rows would go instead. Refused, with B's counts and token.
    const swapped = await post(batch('fixture-swap-other-source', phone, [], {
      reconcile: window(idsOf(sourceA), { expected: 25, token: shown.confirmToken }) as never,
    }));
    assert.equal(swapped.status, 409);
    const fresh = (await swapped.json() as { reconcile: { wouldDelete: number; byOrigin: unknown; confirmToken: string } }).reconcile;
    assert.equal(fresh.wouldDelete, 25);
    assert.deepEqual(fresh.byOrigin, [{ origin: 'com.source.b', count: 25 }]);
    assert.notEqual(fresh.confirmToken, shown.confirmToken);
    assert.equal(ids(repository).length, 50);

    // Same source and count, one id replaced: refused too.
    const oneSwapped = [...idsOf(sourceB).slice(1), sourceA[0]!.id];
    const replaced = await post(batch('fixture-swap-one-id', phone, [], {
      reconcile: window(oneSwapped, { expected: 25, token: shown.confirmToken }) as never,
    }));
    assert.equal(replaced.status, 409);
    assert.equal(ids(repository).length, 50);

    // The token is bound to the device and window as well.
    assert.notEqual(tokenFor(idsOf(sourceA), otherPhone), shown.confirmToken);
    assert.notEqual(tokenFor(idsOf(sourceA), phone, windowStart, '2026-09-09T00:00:00.000Z'), shown.confirmToken);
    assert.equal(tokenFor(idsOf(sourceA)), shown.confirmToken);
    // Order of the ids does not matter; the token names the set.
    assert.equal(tokenFor([...idsOf(sourceA)].reverse()), shown.confirmToken);

    // The unchanged set with its token is deleted, and only it.
    const confirmed = await post(batch('fixture-swap-confirmed', phone, [], {
      reconcile: window(idsOf(sourceB), { expected: 25, token: shown.confirmToken }) as never,
    }));
    assert.equal(confirmed.status, 200);
    assert.equal((await confirmed.json() as { deleted: number }).deleted, 25);
    assert.deepEqual(ids(repository), idsOf(sourceB));
  } finally {
    repository.close();
  }
});
