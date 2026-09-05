import assert from 'node:assert/strict';
import test from 'node:test';
import { load } from 'cheerio';
import { Resvg } from '@resvg/resvg-js';
import { Repository } from '../src/data/database.js';
import { sleepSession } from '../src/health/sleep.js';
import { buildHealthCard, buildHealthSleepCard, buildHealthSleepStagesCard, buildHealthExerciseCard, buildHealthStepsCard } from '../src/output/health.js';
import { logo } from '../src/output/render.js';

const builders = [buildHealthCard, buildHealthSleepCard, buildHealthSleepStagesCard, buildHealthExerciseCard, buildHealthStepsCard];
const now = new Date('2026-09-05T10:00:00Z');
const description = (svg: string) => load(svg, { xmlMode: true })('desc').text();

test('all five Health cards render empty data with consistent frames and offline branding', async () => {
  const db = new Repository(':memory:');
  try {
    for (const build of builders) {
      const svg = await build(db.healthConnectSnapshot('Sky <&>', now));
      assert.match(svg, /^<svg width="520"/);
      assert.ok(svg.includes(logo('healthconnect')));
      assert.match(description(svg), /Sky <&>/);
      assert.match(description(svg), /No /);
      assert.doesNotMatch(svg, /NaN|Infinity/);
    }
  } finally { db.close(); }
});

test('sleep cards preserve Taipei overnight timing, naps, actual stages and missing-data semantics', async () => {
  const db = new Repository(':memory:');
  try {
    const data = db.healthConnectSnapshot('Sky', now);
    const main = sleepSession('2026-07-01T15:00:00Z', '2026-07-01T23:00:00Z', [
      { startTime: '2026-07-01T15:00:00Z', endTime: '2026-07-01T16:00:00Z', stage: 1 },
      { startTime: '2026-07-01T16:00:00Z', endTime: '2026-07-01T19:00:00Z', stage: 5 },
      { startTime: '2026-07-01T19:00:00Z', endTime: '2026-07-01T23:00:00Z', stage: 6 },
    ]);
    const nap = sleepSession('2026-07-02T05:00:00Z', '2026-07-02T06:00:00Z', []);
    data.extra.sleep = { totalSessions: 2, days: [{ day: '2026-07-02', sessionSeconds: 32400, sessions: 2, intervals: [main, nap] }] };
    const latest = description(await buildHealthCard(data));
    assert.match(latest, /23:00–07:00 · 7h 0m/);
    assert.match(latest, /13:00–14:00 · —/);
    assert.doesNotMatch(latest, /Efficiency|88%|100%|ALL RECEIVED RECORDS/);
    const rhythm = description(await buildHealthSleepCard(data));
    for (const label of ['8pm', '12am', '4am', '8am', '12pm', '4pm', '23:00–07:00', '13:00–14:00', '07-02']) assert.ok(rhythm.includes(label), label);
    const stages = description(await buildHealthSleepStagesCard(data));
    assert.match(stages, /≥ 7h 0m · —/);
    assert.doesNotMatch(stages, /88%|100%/);
    data.extra.sleep.days[0]!.intervals = [nap];
    data.extra.sleep.days[0]!.sessionSeconds = 3600;
    const missing = description(await buildHealthCard(data));
    assert.match(missing, /13:00–14:00 · —/);
    assert.doesNotMatch(missing, /100%/);
  } finally { db.close(); }
});

test('steps card draws historical recorded days outside the recent window without exposing raw identifiers', async () => {
  const db = new Repository(':memory:');
  try {
    db.ingestHealthConnect({ syncId: 'cards-steps-test', deviceId: 'private-device', observedAt: now.toISOString(), deletedRecordIds: [], records: [
      { id: 'private-step', dataType: 'steps', dataOrigin: 'private-origin', startTime: '2026-01-01T17:00:00Z', endTime: '2026-01-01T18:00:00Z', lastModifiedTime: '2026-01-01T18:00:00Z', payload: { count: 4321 } },
    ] });
    const data = db.healthConnectSnapshot('Sky', now);
    assert.equal(data.extra.daily.length, 0);
    assert.deepEqual(data.extra.steps?.days, [{ day: '2026-01-02', steps: 4321 }]);
    const svg = await buildHealthStepsCard(data);
    assert.match(description(svg), /2026-01-02/);
    assert.match(description(svg), /4,321/);
    assert.doesNotMatch(svg, /private-step|private-device|private-origin|No positive/);
  } finally { db.close(); }
});

test('overview shows three recorded days per category, with no efficiency or lifetime totals', async () => {
  const db = new Repository(':memory:');
  try {
    const data = db.healthConnectSnapshot('Sky', now);
    data.stats = { workouts: 98765, totalSteps: 987654321 };
    data.extra.steps = { days: [5, 4, 3, 2].map((day) => ({ day: `2026-01-0${day}`, steps: day * 1000 })) };
    data.extra.exercise = { days: [5, 4, 3, 2].map((day) => ({ day: `2026-02-0${day}`, seconds: day * 60, sessions: 2 })) };
    data.extra.sleep = { totalSessions: 87654, days: [5, 4, 3, 2].map((day) => ({
      day: `2026-03-0${day}`, sessionSeconds: 28800, sessions: 1,
      intervals: [sleepSession(`2026-03-0${day - 1}T16:00:00Z`, `2026-03-0${day}T00:00:00Z`, [])],
    })) };
    const overview = description(await buildHealthCard(data));
    assert.match(overview, /Latest 3 recorded days per category/);
    for (const label of ['SLEEP', 'WORKOUT', 'STEPS', '03-05', '03-04', '03-03', '2026-02-05', '2026-02-04', '2026-02-03', '2026-01-05', '2026-01-04', '2026-01-03', '2 workouts']) assert.ok(overview.includes(label), label);
    assert.doesNotMatch(overview, /03-02|2026-02-02|2026-01-02|Efficiency|100%|ALL RECEIVED|98765|87654/);
    data.extra.sleep.days = [];
    const missing = description(await buildHealthCard(data));
    assert.match(missing, /No sleep records/);
    assert.match(missing, /2026-02-05/);
    assert.match(missing, /2026-01-05/);
  } finally { db.close(); }
});

test('overview workout days include all sessions, independently of the 20-entry feed cap', () => {
  const db = new Repository(':memory:');
  try {
    const records = Array.from({ length: 23 }, (_, i) => {
      const day = i < 21 ? 5 : i === 21 ? 4 : 3;
      return { id: `private-workout-${i}`, dataType: 'exercise_session' as const, dataOrigin: 'private-origin',
        startTime: `2026-01-0${day}T00:00:00Z`, endTime: `2026-01-0${day}T00:10:00Z`,
        lastModifiedTime: `2026-01-0${day}T00:10:00Z`, payload: { exerciseType: 79 } };
    });
    db.ingestHealthConnect({ syncId: 'overview-workouts-test', deviceId: 'private-device', observedAt: now.toISOString(), deletedRecordIds: [], records });
    const data = db.healthConnectSnapshot('Sky', now);
    assert.deepEqual(data.extra.exercise?.days, [
      { day: '2026-01-05', seconds: 12600, sessions: 21 },
      { day: '2026-01-04', seconds: 600, sessions: 1 },
      { day: '2026-01-03', seconds: 600, sessions: 1 },
    ]);
    assert.doesNotMatch(JSON.stringify(data.extra.exercise), /private-/);
  } finally { db.close(); }
});

test('sleep, steps and exercise raster output preserves blank space between longest bar and values', async () => {
  const db = new Repository(':memory:');
  try {
    const data = db.healthConnectSnapshot('Sky', now);
    data.extra.steps = { days: [{ day: '2026-09-05', steps: 123456 }] };
    data.entries = [{ source: 'health', kind: 'fitness', title: 'Walking', status: 'workout', activityAt: '2026-09-05T00:00:00Z', image: '', rating: null, extra: { durationMinutes: 1234 } }];
    const session = sleepSession('2026-09-04T12:00:00Z', '2026-09-05T04:00:00Z', [
      { startTime: '2026-09-04T12:00:00Z', endTime: '2026-09-05T04:00:00Z', stage: 6 },
    ]);
    data.extra.sleep = { totalSessions: 1, days: [{ day: '2026-09-05', sessionSeconds: 57600, sessions: 1, intervals: [session] }] };
    for (const build of [buildHealthStepsCard, buildHealthSleepCard, buildHealthSleepStagesCard, buildHealthExerciseCard]) {
      const image = new Resvg(await build(data)).render();
      const pixels = image.pixels;
      const rgb = (x: number, y: number) => [...pixels.slice((y * image.width + x) * 4, (y * image.width + x) * 4 + 3)].join(',');
      let longest = { length: 0, end: 0, y: 0 };
      for (let y = 0; y < image.height; y++) {
        let length = 0;
        for (let x = 0; x < image.width; x++) {
          length = rgb(x, y) === '103,213,195' ? length + 1 : 0;
          if (length > longest.length) longest = { length, end: x, y };
        }
      }
      assert.ok(longest.length > 250, `${build.name}: full-width fixture bar found`);
      // Skip the anti-aliased bar edge / final gridline, then inspect the gutter.
      // Exercise labels sit above the thin bar's center; check that text band too.
      for (let dy = build === buildHealthExerciseCard ? -12 : 0; dy <= 0; dy++) {
        for (let dx = 3; dx <= 15; dx++) assert.equal(rgb(longest.end + dx, longest.y + dy), '17,20,24', `${build.name}: blank gutter at +${dx}px, ${dy}px`);
      }
    }
  } finally { db.close(); }
});
