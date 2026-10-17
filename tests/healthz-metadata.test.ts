import assert from 'node:assert/strict';
import test from 'node:test';
import { gunzipSync } from 'node:zlib';

// This file deliberately imports the real app only after configuring an empty
// in-memory repository and a fail-closed network stub. No card build is needed.
test('healthz reads metadata without entering cold snapshot/card middleware', async (t) => {
  process.env.NODE_ENV = 'test';
  process.env.DATABASE_PATH = ':memory:';
  process.env.SOURCES = 'backloggd,kitsu,statsfm,simkl,goodreads,youtube,health,dayflow,computai';
  process.env.DAYFLOW_TOKEN = 'synthetic-dayflow-token-at-least-32-characters';
  process.env.COMPUTAI_TOKEN = 'synthetic-computai-token-at-least-32-characters';
  // Avoid the separate pre-listen Health-card restore during import. Enable
  // Health metadata below, once the empty test app has been constructed.
  process.env.HEALTH_CONNECT_TOKEN = '';
  process.env.INGEST_TOKEN = '';
  process.env.PUBLIC_BASE_URL = 'http://localhost:3000';
  process.env.MAX_SOURCE_AGE_HOURS = '1';
  const originalFetch = globalThis.fetch;
  const network = t.mock.method(globalThis, 'fetch', async (input: string | URL | Request, init?: RequestInit) => {
    // Satori initializes bundled Yoga WASM with a data: URI during import.
    // Allow only that in-memory protocol; HTTP remains fail-closed.
    if (String(input).startsWith('data:')) return originalFetch(input, init);
    throw new Error('network is forbidden in the metadata health test');
  });
  const { config } = await import('../src/config.js');
  const { app, repository } = await import('../src/index.js');
  const { getCache, restoreCache } = await import('../src/data/cache.js');
  assert.ok(network.mock.calls.every(({ arguments: args }) => String(args[0]).startsWith('data:')));
  network.mock.resetCalls(); // From this point, even an in-memory fetch is unexpected.
  t.after(() => repository.close());
  config.healthConnect.token = 'synthetic-health-token-at-least-32-characters';

  const now = Date.parse('2026-10-18T04:00:00.000Z');
  t.mock.method(Date, 'now', () => now);
  let pushedAt: string | null = null;
  t.mock.method(repository, 'healthConnectStatus', () => ({
    lastSyncedAt: pushedAt, totalStored: 1,
    lastDeviceId: 'private-synthetic-device', recordsByType: { steps: 1 },
  }));
  t.mock.method(repository.dayflow, 'status', () => ({
    lastSyncedAt: pushedAt, firstDay: null, lastDay: null, days: 0, revision: 1,
  }));
  t.mock.method(repository.computai, 'status', () => ({ lastSyncedAt: pushedAt, revision: 1 }));
  const dayflowSnapshot = t.mock.method(repository.dayflow, 'snapshot', () => {
    throw new Error('health must not rebuild Dayflow snapshots');
  });
  const computaiSnapshot = t.mock.method(repository.computai, 'snapshot', () => {
    throw new Error('health must not initiate ComputAI cards');
  });
  const healthSnapshot = t.mock.method(repository, 'healthConnectSnapshot', () => {
    throw new Error('health must not rebuild Health cards');
  });

  const polled = ['backloggd', 'kitsu', 'statsfm', 'simkl', 'goodreads', 'youtube'];
  const allSources = [...polled, 'health', 'dayflow', 'computai'];
  const maxAge = 60 * 60_000;
  const seed = (ageMs: number, errors: string[] = []) => {
    pushedAt = new Date(now - ageMs).toISOString();
    for (const source of polled) {
      restoreCache(`data:${source}`, { source, synthetic: true }, now - ageMs,
        errors.includes(source) ? 'synthetic upstream timeout' : undefined);
    }
  };
  const probe = async () => {
    const response = await app.request('/healthz?probe=startup');
    const body = await response.json() as {
      status: string; maxSourceAgeHours: number;
      sources: Array<{ source: string; fresh: boolean; ageMs: number | null; error: string | null }>;
    };
    assert.equal(body.maxSourceAgeHours, 1);
    assert.deepEqual(body.sources.map((source) => source.source), allSources);
    assert.doesNotMatch(JSON.stringify(body), /private-synthetic-device|recordsByType|synthetic":true/);
    return { response, body };
  };

  await t.test('missing snapshots and syncs remain unhealthy', async () => {
    const { response, body } = await probe();
    assert.equal(response.status, 503);
    assert.equal(body.status, 'unhealthy');
    assert.ok(body.sources.every((source) => !source.fresh && source.ageMs === null && source.error === null));
  });
  await t.test('all nine fresh sources remain healthy', async () => {
    seed(60_000);
    const { response, body } = await probe();
    assert.equal(response.status, 200);
    assert.equal(body.status, 'healthy');
    assert.ok(body.sources.every((source) => source.fresh && source.ageMs === 60_000 && source.error === null));
  });
  await t.test('HEAD preserves health status without a body or render work', async () => {
    seed(60_000);
    const response = await app.request('/healthz', { method: 'HEAD', headers: { 'Accept-Encoding': 'gzip' } });
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type') ?? '', /application\/json/);
    assert.equal(response.headers.get('content-encoding'), null);
    assert.equal(await response.text(), '');
    seed(maxAge + 1);
    assert.equal((await app.request('/healthz', { method: 'HEAD' })).status, 503);
  });
  await t.test('compressed GET still returns metadata without render work', async () => {
    seed(60_000);
    const response = await app.request('/healthz', { headers: { 'Accept-Encoding': 'gzip' } });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('content-encoding'), 'gzip');
    const body = JSON.parse(gunzipSync(Buffer.from(await response.arrayBuffer())).toString());
    assert.equal(body.status, 'healthy');
    assert.deepEqual(body.sources.map((source: { source: string }) => source.source), allSources);
  });
  await t.test('five errors remain visible even when all nine sources are fresh', async () => {
    seed(20 * 60_000, polled.filter((source) => source !== 'goodreads'));
    const before = polled.map((source) => getCache(`data:${source}`));
    const { response, body } = await probe();
    assert.equal(response.status, 200);
    assert.equal(body.status, 'degraded');
    assert.ok(body.sources.every((source) => source.fresh));
    assert.equal(body.sources.filter((source) => source.error === 'synthetic upstream timeout').length, 5);
    assert.deepEqual(polled.map((source) => getCache(`data:${source}`)), before, 'probing preserves data, ages and errors');
  });
  await t.test('the age boundary stays inclusive and one stale source degrades health', async () => {
    seed(maxAge);
    assert.equal((await probe()).body.status, 'healthy');
    restoreCache('data:kitsu', { source: 'kitsu', synthetic: true }, now - maxAge - 1);
    const { response, body } = await probe();
    assert.equal(response.status, 200);
    assert.equal(body.status, 'degraded');
    assert.deepEqual(body.sources.find((source) => source.source === 'kitsu'), {
      source: 'kitsu', fresh: false, ageMs: maxAge + 1, error: null,
    });
  });
  await t.test('all stale sources remain unhealthy', async () => {
    seed(maxAge + 1);
    const { response, body } = await probe();
    assert.equal(response.status, 503);
    assert.equal(body.status, 'unhealthy');
    assert.ok(body.sources.every((source) => !source.fresh && source.ageMs === maxAge + 1));
  });

  assert.equal(dayflowSnapshot.mock.callCount(), 0);
  assert.equal(computaiSnapshot.mock.callCount(), 0);
  assert.equal(healthSnapshot.mock.callCount(), 0);
  assert.equal(network.mock.callCount(), 0);
  for (const source of ['dayflow', 'computai']) assert.equal(getCache(`data:${source}`), undefined);
  for (const name of ['dayflow', 'ai-agents', 'ai-agents-light']) assert.equal(getCache(`svg:${name}`), undefined);
});
