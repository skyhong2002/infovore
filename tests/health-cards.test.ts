import assert from 'node:assert/strict';
import test from 'node:test';
import { load } from 'cheerio';
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
    assert.match(latest, /Sleep onset · 00:00 · Final wake · 07:00 · Time asleep · 7h 0m/);
    assert.match(latest, /Record 23:00/);
    assert.match(latest, /88%/);
    assert.match(latest, /Longest of 2 sessions/);
    const rhythm = description(await buildHealthSleepCard(data));
    for (const label of ['8pm', '12am', '4am', '8am', '12pm', '4pm', '23:00–07:00', '13:00–14:00', '07-02']) assert.ok(rhythm.includes(label), label);
    const stages = description(await buildHealthSleepStagesCard(data));
    assert.match(stages, /≥ 7h 0m · —/);
    assert.doesNotMatch(stages, /88%|100%/);
    data.extra.sleep.days[0]!.intervals = [nap];
    data.extra.sleep.days[0]!.sessionSeconds = 3600;
    const missing = description(await buildHealthCard(data));
    assert.match(missing, /Sleep onset · — · Final wake · — · Time asleep · —/);
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
