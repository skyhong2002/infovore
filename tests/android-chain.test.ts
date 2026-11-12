import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test, { mock } from 'node:test';
import { load } from 'cheerio';
import { app, repository } from '../src/index.js';
import { createIngestApp } from '../src/ingest.js';

// The phone → ingest → public pages chain, reproducible in CI. The Android test
// android/app/src/test/java/tw/skyhong/infovore/health/robo/SyncFlowUiTest.kt
// presses "立即同步" on the real MainActivity and records every request the app
// sends (real HealthSyncEngine and InfovoreApi, synthetic Health Connect
// records, fixed clock and batch ids) into this golden file, failing when the
// app's requests change. Here the same requests go, in order, into the real
// ingest service; its answers must be the ones the Android test's fake server
// gave the app, and the public pages must show the synthetic records' public
// summary without any raw field. A format or behaviour change on either side
// fails one of the two tests.

interface GoldenRequest {
  method: string;
  path: string;
  authorization: string;
  contentType: string;
  body: { syncId: string; deviceId: string; records: Array<{ id: string; dataOrigin: string }>; reconcile?: { dataType: string } };
  response: { status: number; inserted: number; updated: number; deleted: number; reconciled: boolean };
}

const golden = JSON.parse(readFileSync(new URL('./fixtures/android-sync-golden.json', import.meta.url), 'utf8')) as {
  phoneClock: string;
  requests: GoldenRequest[];
};

const ingest = createIngestApp(repository);

function replay(request: GoldenRequest) {
  return ingest.request(request.path, {
    method: request.method,
    headers: { authorization: request.authorization, 'content-type': request.contentType },
    body: JSON.stringify(request.body),
  });
}

// Raw values that exist only in the phone's batches: record ids, the source
// app's package, the device and batch ids, free-text notes, per-sample fields.
const golden0 = golden.requests[0].body;
const rawValues = [
  ...new Set(golden.requests.flatMap((request) => request.body.records.map((record) => record.id))),
  golden0.records[0].dataOrigin,
  golden0.deviceId,
  'android-golden-sync-',
  'golden private',
  'beatsPerMinute',
];

test('the recorded Android sync is a complete first sync of every synced type', () => {
  const requests = golden.requests;
  assert.ok(requests.length >= 2);
  for (const request of requests) {
    assert.equal(request.method, 'POST');
    assert.equal(request.path, '/api/ingest/health-connect');
    assert.equal(request.contentType, 'application/json');
  }
  const types = new Set(requests.flatMap((request) => request.body.records.map((record) => (record as unknown as { dataType: string }).dataType)));
  assert.deepEqual([...types].sort(), ['body_fat', 'distance', 'exercise_session', 'heart_rate', 'sleep_session', 'steps', 'total_calories_burned', 'weight']);
  // Every type was also reconciled once (the rescan of a first sync).
  assert.deepEqual(requests.filter((request) => request.body.reconcile).map((request) => request.body.reconcile!.dataType).sort(), [...types].sort());
  assert.equal(new Set(requests.map((request) => request.body.syncId)).size, requests.length, 'one batch id per request');
});

test('the real ingest service answers the recorded Android sync as the app was told, and the public pages show it', async () => {
  // The public pages window on "now": read them a minute after the phone's recorded sync.
  const phoneClock = Date.parse(golden.phoneClock);
  mock.timers.enable({ apis: ['Date'], now: phoneClock + 60_000 });
  try {
    for (const [index, request] of golden.requests.entries()) {
      const response = await replay(request);
      const body = await response.json() as { inserted: number; updated: number; deleted: number; reconciled?: { deleted: number } };
      const label = `request ${index + 1} (${request.body.reconcile ? `reconcile ${request.body.reconcile.dataType}` : `${request.body.records.length} records`})`;
      assert.equal(response.status, request.response.status, label);
      assert.deepEqual(
        { inserted: body.inserted, updated: body.updated, deleted: body.deleted, reconciled: body.reconciled !== undefined },
        { inserted: request.response.inserted, updated: request.response.updated, deleted: request.response.deleted, reconciled: request.response.reconciled },
        label,
      );
      if (body.reconciled) assert.equal(body.reconciled.deleted, 0, `${label} deletes nothing on a first sync`);
    }

    const ingestStatus = await ingest.request('/api/ingest/health-connect/status', { headers: { authorization: golden.requests[0].authorization } });
    const recordsByType = (await ingestStatus.json() as { recordsByType: Record<string, number> }).recordsByType;
    assert.deepEqual(recordsByType, {
      body_fat: 1, distance: 1, exercise_session: 1, heart_rate: 1, sleep_session: 1, steps: 2, total_calories_burned: 1, weight: 1,
    });

    // /api/health.json: the public projection of the synthetic records.
    const healthJson = await (await app.request('/api/health.json')).json() as {
      data: {
        stats: { records: number; totalSteps: number; totalDistanceKm: number; workouts: number; totalExerciseSeconds: number };
        extra: {
          daily: Array<{ day: string; steps: number; heartRateAverage: number; heartRateMinimum: number; heartRateMaximum: number; exerciseSeconds: number }>;
          latest: { weightKilograms: number; bodyFatPercentage: number };
        };
      };
    };
    const { stats, extra } = healthJson.data;
    assert.equal(stats.records, 9);
    assert.equal(stats.totalSteps, 6543);
    assert.equal(stats.totalDistanceKm, 3.2);
    assert.equal(stats.workouts, 1);
    assert.equal(stats.totalExerciseSeconds, 1800);
    const day = extra.daily.find((entry) => entry.day === '2026-09-09');
    assert.ok(day, 'a daily summary for the synthetic day (Taipei time)');
    assert.equal(day.steps, 6543);
    assert.equal(day.exerciseSeconds, 1800);
    assert.deepEqual([day.heartRateAverage, day.heartRateMinimum, day.heartRateMaximum], [72, 64, 80]);
    assert.equal(extra.latest.weightKilograms, 68.4);
    assert.equal(extra.latest.bodyFatPercentage, 21.5);

    // /platforms/health: the readable summary.
    const platform = await app.request('/platforms/health');
    assert.equal(platform.status, 200);
    const platformHtml = await platform.text();
    assert.match(platformHtml, /6,543 steps/);
    assert.match(platformHtml, /Walking/);
    assert.match(platformHtml, /68\.4 kg/);
    assert.match(platformHtml, /72 bpm \(64–80\)/);
    assert.match(platformHtml, /id="sleep"/);

    // The homepage folds Health into its existing sections.
    const homeHtml = await (await app.request('/')).text();
    const home = load(homeHtml);
    const healthRow = home('#recent .home-recent-item').filter((_, item) => home(item).find('.home-recent-source').text() === 'Health');
    assert.equal(healthRow.length, 1);
    assert.match(healthRow.text(), /30 min exercise/);
    assert.ok(home('.home-coverage-lane[data-source="health-sleep"] span').length, 'the recorded sleep is on the coverage timeline');

    // /status.json: the device-pushed source is fresh as of the replayed sync.
    const status = await (await app.request('/status.json')).json() as {
      sources: Array<{ source: string; lastFetched: string | null; error: string | null; delayed: boolean }>;
    };
    const health = status.sources.find((source) => source.source === 'health');
    assert.ok(health, 'health is listed on the status page');
    assert.equal(health.error, null);
    assert.equal(health.delayed, false);
    assert.ok(health.lastFetched && Math.abs(Date.parse(health.lastFetched) - phoneClock) <= 60_000, `lastFetched ${health.lastFetched}`);

    // No raw field of the phone's batches reaches any public page.
    const publicBodies = [platformHtml, homeHtml, JSON.stringify(healthJson), JSON.stringify(status)];
    for (const path of ['/now', '/status', '/api/activities.json', '/feed.json', '/feed.xml']) {
      const response = await app.request(path);
      assert.equal(response.status, 200, path);
      publicBodies.push(await response.text());
    }
    const everything = publicBodies.join('\n');
    for (const raw of rawValues) assert.ok(!everything.includes(raw), `public pages leak ${raw}`);

    // The app retries a batch whose answer was lost: replaying the whole sync changes nothing.
    for (const request of golden.requests) {
      const response = await replay(request);
      assert.equal(response.status, 200);
      const body = await response.json() as { inserted: number; deleted: number; reconciled?: { alreadyApplied?: boolean } };
      assert.equal(body.inserted, 0);
      assert.equal(body.deleted, 0);
      if (request.body.reconcile) assert.equal(body.reconciled?.alreadyApplied, true);
    }
    const after = await (await app.request('/api/health.json')).json() as typeof healthJson;
    assert.equal(after.data.stats.records, 9);
    assert.equal(after.data.stats.totalSteps, 6543);
  } finally {
    mock.timers.reset();
  }
});
