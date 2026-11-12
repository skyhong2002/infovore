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
