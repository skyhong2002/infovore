import assert from 'node:assert/strict';
import test from 'node:test';
import { app, repository } from '../src/index.js';
import { createIngestApp } from '../src/ingest.js';
import { Repository } from '../src/data/database.js';
import { distanceBetween, locationDayBounds, MAX_DAY_POINTS } from '../src/location/store.js';

// npm test sets INGEST_TOKEN, and the location token falls back to it (through HEALTH_CONNECT_TOKEN).
const TOKEN = 'test-token-with-at-least-32-characters';
const auth = { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' };
const ingest = createIngestApp(repository);

const post = (body: unknown, headers: Record<string, string> = auth) =>
  ingest.request('/api/ingest/location/batches', { method: 'POST', headers, body: JSON.stringify(body) });

test('location ingestion is authenticated, validated and idempotent', async () => {
  const batch = {
    deviceId: 'phone-1',
    source: 'live',
    points: [
      { time: '2026-03-02T01:00:00.000Z', lat: 25.0330, lng: 121.5654, accuracy: 12 },
      { time: '2026-03-02T01:01:00.000Z', lat: 25.0340, lng: 121.5654, accuracy: 15, speed: 1.2 },
    ],
  };
  assert.equal((await post(batch, { 'Content-Type': 'application/json' })).status, 401);
  assert.equal((await post(batch, { ...auth, Authorization: `Bearer ${'x'.repeat(TOKEN.length)}` })).status, 401);
  assert.equal((await post({ ...batch, points: [] })).status, 400, 'an empty batch is refused');
  assert.equal((await post({ ...batch, points: [{ time: 'nope', lat: 25, lng: 121 }] })).status, 400);
  assert.equal((await post({ ...batch, points: [{ time: '2026-03-02T01:00:00Z', lat: 95, lng: 121 }] })).status, 400);
  assert.equal((await post({ ...batch, deviceId: 'bad id' })).status, 400);

  const first = await post(batch);
  assert.equal(first.status, 200);
  assert.deepEqual(await first.json(), { ok: true, points: 2, visits: 0, activities: 0 });
  const again = await post(batch);
  assert.deepEqual(await again.json(), { ok: true, points: 0, visits: 0, activities: 0 }, 'a resent batch adds nothing');

  const status = await ingest.request('/api/ingest/location/status', { headers: auth });
  const body = await status.json() as { status: string; latest: { lat: number } };
  assert.equal(body.status, 'ready');
  assert.ok(body.latest);
});

test('a Timeline import stores visits and trips that a newer export can refine', () => {
  const repo = new Repository(':memory:');
  const visit = { start: '2026-03-03T01:00:00+08:00', end: '2026-03-03T09:00:00+08:00', lat: 25.04, lng: 121.53, placeId: 'ChIJ-home', semanticType: 'HOME' };
  const trip = { start: '2026-03-03T09:00:00+08:00', end: '2026-03-03T09:30:00+08:00', startLat: 25.04, startLng: 121.53, endLat: 25.05, endLng: 121.57, distanceMeters: 4200, mode: 'IN_BUS' };
  assert.deepEqual(repo.location.ingest({ deviceId: 'phone-1', source: 'timeline', points: [], visits: [visit], activities: [trip] }),
    { points: 0, visits: 1, activities: 1 });
  repo.location.ingest({ deviceId: 'phone-1', source: 'timeline', points: [], visits: [{ ...visit, end: '2026-03-03T09:05:00+08:00' }], activities: [] });

  const day = repo.location.day('2026-03-03');
  assert.equal(day.visits.length, 1);
  assert.equal(day.visits[0].end, '2026-03-03T01:05:00.000Z', 'the re-import replaced the visit');
  assert.equal(day.visits[0].semanticType, 'HOME');
  assert.equal(day.activities[0].mode, 'IN_BUS');
  assert.equal(day.distanceMeters, 4200, 'without phone fixes the Timeline trip distance is used');
  assert.deepEqual(repo.location.status().timelineRange, { from: '2026-03-02T17:00:00.000Z', to: '2026-03-03T01:30:00.000Z' });
  // The previous Taipei day does not include it.
  assert.equal(repo.location.day('2026-03-02').visits.length, 0);
  repo.close();
});

test('a day uses Asia/Taipei bounds, thins long tracks and measures only precise fixes', () => {
  const repo = new Repository(':memory:');
  const { start, end } = locationDayBounds('2026-04-01');
  assert.equal(new Date(start).toISOString(), '2026-03-31T16:00:00.000Z');
  assert.equal(end - start, 86_400_000);

  const points = Array.from({ length: 1_000 }, (_, i) => ({
    time: new Date(start + i * 60_000).toISOString(), lat: i === 500 ? 26 : 25 + i * 0.0001, lng: 121.5, accuracy: i === 500 ? 2_000 : 10,
  }));
  for (let i = 0; i < 5; i++) {
    repo.location.ingest({ deviceId: 'phone-1', source: 'live', points: points.map((p) => ({ ...p, time: new Date(Date.parse(p.time) + i * 1_000).toISOString() })), visits: [], activities: [] });
  }
  repo.location.ingest({ deviceId: 'phone-1', source: 'live', points: [{ time: new Date(end).toISOString(), lat: 0, lng: 0 }], visits: [], activities: [] });
  const day = repo.location.day('2026-04-01');
  assert.equal(day.points.length, MAX_DAY_POINTS);
  assert.equal(day.thinned, true);
  assert.ok(day.points.every((p) => p.lat !== 0), 'the next day\'s midnight point is excluded');
  const straight = distanceBetween({ lat: 25, lng: 121.5 }, { lat: 25 + 999 * 0.0001, lng: 121.5 });
  // The repeated passes sit on the same spots, and the imprecise fix 100 km away adds no detour.
  assert.ok(Math.abs(day.distanceMeters - straight) < 2, `${day.distanceMeters} vs ${straight}`);
  repo.close();
});

test('the private location page and reads need the token and stay out of public listings', async () => {
  const page = await app.request('/location');
  assert.equal(page.status, 200);
  assert.match(page.headers.get('x-robots-tag') ?? '', /noindex/);
  const html = await page.text();
  assert.match(html, /<script src="\/location\.js" defer><\/script>/);
  assert.doesNotMatch(html, /121\.5654/, 'the shell carries no data');
  assert.equal((await app.request('/location.js')).status, 200);

  assert.equal((await app.request('/api/location/day?day=2026-03-02')).status, 401);
  assert.equal((await app.request('/api/location/status')).status, 401);
  const bad = await app.request('/api/location/day?day=2026-02-30', { headers: auth });
  assert.equal(bad.status, 400);
  const day = await app.request('/api/location/day?day=2026-03-02', { headers: auth });
  assert.equal(day.status, 200);
  assert.equal(day.headers.get('cache-control'), 'no-store');
  const body = await day.json() as { points: unknown[] };
  assert.equal(body.points.length, 2);

  for (const path of ['/sitemap.xml', '/api/feed.json', '/feed.xml']) {
    const response = await app.request(path);
    if (response.status !== 200) continue;
    assert.doesNotMatch(await response.text(), /\/location|121\.5654/, path);
  }
});

test('the location tables are created on every boot without bumping the schema version', async () => {
  const { mkdtempSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { DatabaseSync } = await import('node:sqlite');
  const dir = mkdtempSync(join(tmpdir(), 'infovore-location-'));
  try {
    const path = join(dir, 'db.sqlite');
    const first = new Repository(path);
    first.location.ingest({ deviceId: 'phone-1', source: 'live', points: [{ time: '2026-05-01T00:00:00Z', lat: 25, lng: 121 }], visits: [], activities: [] });
    first.close();
    const second = new Repository(path);
    assert.equal(second.location.status().points, 1, 'reopening keeps the data');
    second.close();
    const raw = new DatabaseSync(path);
    assert.equal((raw.prepare('PRAGMA user_version').get() as { user_version: number }).user_version, 21);
    raw.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
