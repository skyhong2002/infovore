import assert from 'node:assert/strict';
import test from 'node:test';
import { sleepAxis, sleepDays, sleepHour, sleepSession } from '../src/health/sleep.js';
import { sleepSection } from '../src/output/sleep.js';
import { Repository } from '../src/data/database.js';

const at = (hour: number) => new Date(Date.parse('2026-09-03T12:00:00Z') + hour * 3_600_000).toISOString();
const stage = (from: number, to: number, value: unknown) => ({ startTime: at(from), endTime: at(to), stage: value });

test('sleep stages calculate actual sleep, awake, and efficiency without a vendor score', () => {
  const session = sleepSession(at(0), at(8), [
    stage(0, 0.5, 1), stage(0.5, 2, 4), stage(2, 4, 5), stage(4, 6, 6), stage(6, 7.5, 2), stage(7.5, 8, 7),
  ]);
  assert.equal(session.sessionSeconds, 8 * 3600);
  assert.equal(session.asleepSeconds, 7 * 3600);
  assert.equal(session.efficiency, 88);
  assert.deepEqual(session.stageSeconds, { awake: 3600, light: 5400, deep: 7200, rem: 7200, asleep: 5400, unknown: 0 });
});

test('gaps, invalid stages, and conflicting overlaps are unknown, not fabricated sleep', () => {
  const session = sleepSession(at(0), at(8), [
    stage(-2, 2, 5), stage(1, 2, 5), // Clipped and deduplicated.
    stage(3, 4, 999), stage(4, 5, '4'), // Unrecognised and incorrectly typed.
    stage(5, 7, 4), stage(6, 9, 6), // Conflict from 6 to 7; clipped at session end.
    stage(5, 3, 4), { startTime: 'invalid', endTime: at(4), stage: 4 }, null,
  ]);
  assert.equal(session.stageSeconds.deep, 7200);
  assert.equal(session.stageSeconds.unknown, 4 * 3600);
  assert.equal(session.stageSeconds.light, 3600);
  assert.equal(session.stageSeconds.rem, 3600);
  assert.equal(session.efficiency, null);
  assert.equal(Object.values(session.stageSeconds).reduce((sum, value) => sum + value, 0), session.sessionSeconds);
  assert.equal(session.segments[0]?.startTime, at(0));
  assert.equal(session.segments.at(-1)?.endTime, at(8));
  assert.equal(sleepSession(at(0), at(8), null).asleepSeconds, 0);
  assert.equal(sleepSession(at(0), at(0), []).efficiency, null);
  assert.equal(sleepSession(at(0), at(8), [stage(0, 8, 3)]).stageSeconds.awake, 8 * 3600);
});

test('clock coordinates align midnight and preserve late naps and earlier bedtimes', () => {
  assert.equal(sleepHour('2026-09-04', at(0)), 20);
  assert.equal(sleepHour('2026-09-04', at(4)), 24);
  assert.equal(sleepHour('2026-09-04', at(8)), 28);
  const days = sleepDays([
    { day: '2026-09-04', start_at: at(-2), end_at: at(8), stages_json: '[]' },
    { day: '2026-09-04', start_at: at(18), end_at: at(19), stages_json: '{bad' },
  ]);
  assert.equal(days[0]?.sessions, 2);
  assert.equal(days[0]?.sessionSeconds, 11 * 3600);
  const axis = sleepAxis(days);
  assert.equal(axis.start, 16);
  assert.equal(axis.end, 40);
  for (const tick of [20, 24, 28, 32, 36]) assert.ok(axis.ticks.includes(tick));
  assert.deepEqual(sleepAxis([]), { start: 20, end: 36, ticks: Array.from({ length: 17 }, (_, i) => i + 20) });
});

test('repository publishes only selected sleep fields and renders stage detail with Taipei clocks', () => {
  const repository = new Repository(':memory:');
  try {
    repository.ingestHealthConnect({
      syncId: 'sleep-stage-test', deviceId: 'private-device', observedAt: at(9), deletedRecordIds: [],
      records: [{ id: 'private-id', dataType: 'sleep_session', dataOrigin: 'private-origin',
        startTime: at(0), endTime: at(8), lastModifiedTime: at(9),
        payload: { notes: 'private-notes', title: 'private-title', stages: [stage(0, 1, 1), stage(1, 4, 5), stage(4, 8, 6)] },
      }],
    });
    const extra = repository.healthConnectSnapshot('Sky', new Date(at(9))).extra;
    assert.equal(extra.sleep?.days[0]?.day, '2026-09-04');
    assert.equal(extra.sleep?.days[0]?.intervals[0]?.efficiency, 88);
    assert.doesNotMatch(JSON.stringify(extra.sleep), /private-|notes|title|dataOrigin/);
    const page = sleepSection(extra);
    for (const value of ['21:00', '04:00', '7h 0m', '88%', '深睡', 'REM', '清醒', '8pm', '12am', '4am', '8am', '12pm']) {
      assert.ok(page.includes(value), `Missing ${value}`);
    }
    assert.match(page, /sleep-segment deep/);
    assert.match(page, /sleep-segment rem/);
    assert.match(page, /<details class="sleep-row">/);
    assert.match(page, /<summary class="sleep-row-summary"/);
    assert.doesNotMatch(page, /<details[^>]*\sopen[\s>]/);
    assert.doesNotMatch(page, /class="sleep-range"/);
    assert.match(page, /非睡眠評分/);
    assert.match(page, /left:25%;width:25%/); // Midnight–4am on a 20:00–12:00 axis.
  } finally { repository.close(); }
});

test('sleep projection retains all sessions on the latest 30 wake-up days only', () => {
  const repository = new Repository(':memory:');
  try {
    const records = Array.from({ length: 35 }, (_, i) => ({
      id: `night-${i}`, dataType: 'sleep_session' as const, dataOrigin: 'fixture',
      startTime: at(-24 * i), endTime: at(8 - 24 * i), lastModifiedTime: at(9), payload: {},
    }));
    records.push({ ...records[0]!, id: 'extra-nap', startTime: at(17), endTime: at(18) });
    repository.ingestHealthConnect({ syncId: 'sleep-window-test', deviceId: 'fixture-device',
      observedAt: at(20), deletedRecordIds: [], records });
    const sleep = repository.healthConnectSnapshot('Sky', new Date(at(20))).extra.sleep!;
    assert.equal(sleep.totalSessions, 36);
    assert.equal(sleep.days.length, 30);
    assert.equal(sleep.days[0]?.day, '2026-09-04');
    assert.equal(sleep.days[0]?.intervals.length, 2);
    assert.equal(sleep.days.at(-1)?.day, '2026-08-06');
    assert.equal(sleep.days.reduce((sum, day) => sum + day.sessions, 0), 31);
  } finally { repository.close(); }
});
