import assert from 'node:assert/strict';
import test from 'node:test';
import { load } from 'cheerio';
import { config, parsePushedDelayHours } from '../src/config.js';
import { app, repository } from '../src/index.js';
import { statusPage } from '../src/output/status.js';
import { platformSync } from '../src/output/overview.js';

const HOUR = 3_600_000;

test('device-pushed sources have their own delay threshold: Health 24 h by default, configurable', () => {
  assert.deepEqual(parsePushedDelayHours('', 36), { health: 24, dayflow: 36, computai: 36 });
  // Never longer than the general threshold by default.
  assert.deepEqual(parsePushedDelayHours('', 12), { health: 12, dayflow: 12, computai: 12 });
  assert.deepEqual(parsePushedDelayHours('health:18, dayflow:48', 36), { health: 18, dayflow: 48, computai: 36 });
  for (const bad of ['youtube:2', 'health', 'health:0', 'health:-1', 'health:soon', ':4']) {
    assert.throws(() => parsePushedDelayHours(bad, 36), /PUSHED_DELAY_HOURS/, bad);
  }
  assert.equal(config.delayAfterHours('health'), 24);
  assert.equal(config.delayAfterHours('youtube'), config.maxSourceAgeHours);
  assert.equal(config.delayAfterHours('dayflow'), config.maxSourceAgeHours);
});

test('the status page calls Health delayed after its own threshold, and fetched platforms after the general one', () => {
  const now = new Date('2026-11-12T08:00:00Z');
  const ago = (hours: number) => new Date(now.getTime() - hours * HOUR).toISOString();
  const page = load(statusPage({ ownerName: 'Sample', maxSourceAgeHours: 36, intervalMinutes: 60, nextScheduledAt: null, running: [], now,
    sources: [
      { source: 'health', lastFetched: ago(30), error: null, json: '/api/health.json', delayed: true, delayAfterHours: 24 },
      { source: 'kitsu', lastFetched: ago(30), error: null, json: '/api/kitsu.json', delayed: false, delayAfterHours: 36 },
    ] }));
  const [health, kitsu] = page('tbody tr').toArray().map((row) => page(row).text());
  assert.match(health!, /Delayed[\s\S]*older than 24 h[\s\S]*check that the device app is running/);
  assert.match(kitsu!, /Fresh/);
  assert.match(page('.page-intro p').first().text(), /1 of 2 platforms are behind/);
  assert.match(page('.feed-note').text(), /over 36 hours \(device-pushed: Health after 24 hours\)/);
  // Without per-source thresholds (an older view), the general one applies as before.
  const legacy = load(statusPage({ ownerName: 'Sample', maxSourceAgeHours: 36, intervalMinutes: 60, nextScheduledAt: null, running: [], now,
    sources: [{ source: 'health', lastFetched: ago(30), error: null, json: '/api/health.json' }] }));
  assert.match(legacy('tbody').text(), /Fresh/);
  assert.doesNotMatch(legacy('.feed-note').text(), /device-pushed:/);
});

test('the homepage card uses the source threshold', () => {
  const now = new Date('2026-11-12T08:00:00Z');
  const at = now.getTime() - 30 * HOUR;
  assert.equal(platformSync(at, config.delayAfterHours('health'), now).state, 'stale');
  assert.equal(platformSync(at, config.delayAfterHours('kitsu'), now).state, 'fresh');
});

test('/healthz and /status report Health delayed after a day without a push; the overall status rule is unchanged', async () => {
  const pushedAt = new Date(Date.now() - 30 * HOUR).toISOString();
  repository.ingestHealthConnect({
    syncId: 'fixture-delay-sync-0001', deviceId: 'fixture-delay-phone', observedAt: pushedAt,
    records: [{ id: 'fixture-delay-steps', dataType: 'steps', dataOrigin: 'com.example.fixture', startTime: pushedAt, endTime: pushedAt,
      lastModifiedTime: pushedAt, payload: { count: 10 } }],
    deletedRecordIds: [],
  }, pushedAt);

  const healthz = await (await app.request('/healthz')).json() as {
    status: string; maxSourceAgeHours: number;
    sources: Array<{ source: string; fresh: boolean; ageMs: number | null; error: string | null; delayed: boolean; delayAfterHours: number }>;
  };
  const health = healthz.sources.find((source) => source.source === 'health')!;
  // Still fresh by MAX_SOURCE_AGE_HOURS (36 h), but delayed by its own 24 h.
  assert.equal(health.fresh, true);
  assert.equal(health.delayed, true);
  assert.equal(health.delayAfterHours, 24);
  // The existing fields keep their names and order; the new ones come after.
  assert.deepEqual(Object.keys(health), ['source', 'fresh', 'ageMs', 'error', 'delayed', 'delayAfterHours']);
  for (const source of healthz.sources) {
    assert.equal(source.delayAfterHours, config.delayAfterHours(source.source));
    if (source.source !== 'health') assert.equal(source.delayed, !source.fresh, source.source);
  }
  // healthy/degraded/unhealthy still come from `fresh` and `error` only.
  const freshCount = healthz.sources.filter((source) => source.fresh).length;
  const expected = freshCount === 0 ? 'unhealthy' : healthz.sources.every((source) => source.fresh && !source.error) ? 'healthy' : 'degraded';
  assert.equal(healthz.status, expected);

  const status = await (await app.request('/status.json')).json() as { sources: Array<{ source: string; delayed: boolean; delayAfterHours: number }> };
  assert.deepEqual(status.sources.filter((source) => source.source === 'health').map(({ delayed, delayAfterHours }) => ({ delayed, delayAfterHours })),
    [{ delayed: true, delayAfterHours: 24 }]);
  const page = load(await (await app.request('/status', { headers: { accept: 'text/html' } })).text());
  const row = page('tbody tr').filter((_, tr) => page(tr).find('th a[href="/platforms/health"]').length > 0).text();
  assert.match(row, /Delayed[\s\S]*older than 24 h/);
});
