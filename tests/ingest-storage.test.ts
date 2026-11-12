import assert from 'node:assert/strict';
import test from 'node:test';
import { Repository } from '../src/data/database.js';
import { createIngestApp } from '../src/ingest.js';

// A storage failure after validation must answer a retryable 503 (the sender keeps its
// batch), while invalid input stays a permanent 400. Synthetic data only.
const headers = { 'content-type': 'application/json', authorization: 'Bearer test-token-with-at-least-32-characters' };

async function withFailingStorage(
  fail: (repository: Repository) => void,
  run: (post: (path: string, body: unknown) => Response | Promise<Response>, repository: Repository) => Promise<void>,
) {
  const repository = new Repository(':memory:');
  const quiet = console.error;
  try {
    const ingest = createIngestApp(repository);
    const post = (path: string, body: unknown) =>
      ingest.request(path, { method: 'POST', headers, body: typeof body === 'string' ? body : JSON.stringify(body) });
    console.error = () => {};
    fail(repository);
    await run(post, repository);
  } finally {
    console.error = quiet;
    repository.close();
  }
}

async function assertRetryable503(response: Response) {
  assert.equal(response.status, 503);
  const body = await response.json() as { retryable?: boolean; error: string };
  assert.equal(body.retryable, true);
  assert.doesNotMatch(body.error, /synthetic/);
}

test('Health Connect ingest answers a retryable 503 when storage fails, and 400 for invalid batches', async () => {
  await withFailingStorage(
    (repository) => { repository.ingestHealthConnect = () => { throw new Error('synthetic storage outage'); }; },
    async (post) => {
      const batch = {
        syncId: 'fixture-storage-sync-01', deviceId: 'fixture-storage-phone', observedAt: '2026-09-10T00:00:00.000Z',
        records: [{
          id: 'storage-steps-1', dataType: 'steps', dataOrigin: 'com.garmin.fixture',
          startTime: '2026-09-02T08:00:00.000Z', endTime: '2026-09-02T08:15:00.000Z',
          lastModifiedTime: '2026-09-02T08:15:00.000Z', payload: { count: 100 },
        }],
        deletedRecordIds: [],
      };
      await assertRetryable503(await post('/api/ingest/health-connect', batch));
      assert.equal((await post('/api/ingest/health-connect', { ...batch, records: [{ id: 'no-type' }] })).status, 400);
      assert.equal((await post('/api/ingest/health-connect', '{not json')).status, 400);
    },
  );
});

test('Event ingest answers a retryable 503 when storage fails, and 400 for invalid events', async () => {
  await withFailingStorage(
    (repository) => { repository.ingestEntries = () => { throw new Error('synthetic storage outage'); }; },
    async (post) => {
      await assertRetryable503(await post('/api/ingest/events', {
        id: 'storage-event', title: 'Synthetic Concert', startAt: '2099-08-01T12:00:00Z', status: 'upcoming',
        image: 'https://example.test/concert.webp',
      }));
      assert.equal((await post('/api/ingest/events', { events: [] })).status, 400);
      assert.equal((await post('/api/ingest/events', { id: 'no-image', title: 'Synthetic', startAt: '2099-08-01T12:00:00Z' })).status, 400);
      assert.equal((await post('/api/ingest/events', '{not json')).status, 400);
    },
  );
});
