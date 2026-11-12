import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { Repository } from '../src/data/database.js';
import { createIngestApp } from '../src/ingest.js';
import { healthConnectBatchSchema } from '../src/health/types.js';

// The same synthetic fixture is produced field by field by the Android app's serializer
// (android/app/src/test/java/tw/skyhong/infovore/health/HealthReconcileContractTest.kt).
// If either side changes the reconcile wire format, one of the two tests fails.
const fixture = JSON.parse(readFileSync(new URL('./fixtures/health-reconcile-contract.json', import.meta.url), 'utf8')) as {
  request: Record<string, unknown> & { deviceId: string; reconcile: Record<string, unknown> };
  seedRecords: unknown[];
  expectedResponse: { deleted: number; reconciled: Record<string, unknown> };
  expectedRemainingIds: string[];
  confirmedDeleteCase: {
    request: Record<string, unknown> & { deviceId: string; reconcile: Record<string, unknown> };
    seedRecords: unknown[];
    seedSeries: {
      idPrefix: string; count: number; dataType: string; dataOrigin: string;
      firstStart: string; everyMinutes: number; durationMinutes: number;
    };
    expectedRefusalWithoutConfirmation: Record<string, unknown>;
    expectedResponse: { deleted: number; reconciled: Record<string, unknown> };
    expectedRemainingIds: string[];
    expectedAudit: Record<string, unknown>;
  };
};

const headers = { 'content-type': 'application/json', authorization: 'Bearer test-token-with-at-least-32-characters' };

test('The shared reconcile fixture is a valid Health Connect batch', () => {
  const parsed = healthConnectBatchSchema.safeParse(fixture.request);
  assert.ok(parsed.success, parsed.success ? '' : JSON.stringify(parsed.error.issues));
  assert.deepEqual(parsed.data.reconcile, fixture.request.reconcile);
  // The contract is strict: an extra or renamed reconcile field is refused, not ignored.
  assert.equal(healthConnectBatchSchema.safeParse({
    ...fixture.request, reconcile: { ...fixture.request.reconcile, ids: [] },
  }).success, false);
});

test('The shared reconcile fixture applies through the ingest endpoint', async () => {
  const repository = new Repository(':memory:');
  const ingest = createIngestApp(repository);
  const post = (body: unknown) => ingest.request('/api/ingest/health-connect', { method: 'POST', headers, body: JSON.stringify(body) });
  try {
    const seeded = await post({
      syncId: 'fixture-contract-seed-0001',
      deviceId: fixture.request.deviceId,
      observedAt: '2026-09-09T00:00:00Z',
      records: fixture.seedRecords,
      deletedRecordIds: [],
    });
    assert.equal(seeded.status, 201);

    const response = await post(fixture.request);
    assert.equal(response.status, 200);
    const body = await response.json() as { deleted: number; reconciled: Record<string, unknown> };
    assert.equal(body.deleted, fixture.expectedResponse.deleted);
    assert.deepEqual(body.reconciled, fixture.expectedResponse.reconciled);

    const raw = (repository as unknown as { db: DatabaseSync }).db;
    const ids = (raw.prepare('SELECT record_id FROM health_connect_records ORDER BY record_id').all() as Array<{ record_id: string }>)
      .map((row) => row.record_id);
    assert.deepEqual(ids, fixture.expectedRemainingIds);
  } finally {
    repository.close();
  }
});

test('The shared confirmed-deletion case is a valid batch and the field is strict', () => {
  const { request } = fixture.confirmedDeleteCase;
  const parsed = healthConnectBatchSchema.safeParse(request);
  assert.ok(parsed.success, parsed.success ? '' : JSON.stringify(parsed.error.issues));
  assert.deepEqual(parsed.data.reconcile, request.reconcile);
  assert.equal(healthConnectBatchSchema.safeParse({
    ...request, reconcile: { ...request.reconcile, confirmDelete: { expected: 25, all: true } },
  }).success, false);
});

test('The shared confirmed-deletion case is refused without confirmation and applied and audited with it', async () => {
  const contract = fixture.confirmedDeleteCase;
  const series = contract.seedSeries;
  const first = Date.parse(series.firstStart);
  const generated = Array.from({ length: series.count }, (_, index) => {
    const start = new Date(first + index * series.everyMinutes * 60_000).toISOString();
    const end = new Date(first + (index * series.everyMinutes + series.durationMinutes) * 60_000).toISOString();
    return {
      id: `${series.idPrefix}${String(index + 1).padStart(2, '0')}`,
      dataType: series.dataType,
      dataOrigin: series.dataOrigin,
      startTime: start,
      endTime: end,
      lastModifiedTime: end,
      payload: { count: 10 },
    };
  });
  const repository = new Repository(':memory:');
  const ingest = createIngestApp(repository);
  const post = (body: unknown) => ingest.request('/api/ingest/health-connect', { method: 'POST', headers, body: JSON.stringify(body) });
  try {
    const seeded = await post({
      syncId: 'fixture-contract-confirm-seed-0001',
      deviceId: contract.request.deviceId,
      observedAt: '2026-09-09T00:00:00Z',
      records: [...contract.seedRecords, ...generated],
      deletedRecordIds: [],
    });
    assert.equal(seeded.status, 201);

    // Without the confirmation the same window is refused (as an old client would see it).
    const { confirmDelete: _confirmDelete, ...unconfirmed } = contract.request.reconcile;
    const refused = await post({ ...contract.request, syncId: 'fixture-contract-confirm-0000', reconcile: unconfirmed });
    assert.equal(refused.status, 409);
    assert.deepEqual((await refused.json() as { reconcile: unknown }).reconcile, contract.expectedRefusalWithoutConfirmation);

    const response = await post(contract.request);
    assert.equal(response.status, 200);
    const body = await response.json() as { deleted: number; reconciled: Record<string, unknown> };
    assert.equal(body.deleted, contract.expectedResponse.deleted);
    assert.deepEqual(body.reconciled, contract.expectedResponse.reconciled);

    const raw = (repository as unknown as { db: DatabaseSync }).db;
    const ids = (raw.prepare('SELECT record_id FROM health_connect_records ORDER BY record_id').all() as Array<{ record_id: string }>)
      .map((row) => row.record_id);
    assert.deepEqual(ids, contract.expectedRemainingIds);
    const audit = raw.prepare(`SELECT device_id, data_type, window_start, window_end, deleted_count, checked_count
      FROM health_connect_confirmed_deletes`).all() as Array<Record<string, unknown>>;
    assert.deepEqual(audit.map((row) => ({ ...row })), [contract.expectedAudit]);
  } finally {
    repository.close();
  }
});
