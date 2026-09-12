import test from 'node:test';
import assert from 'node:assert/strict';
import { recordedCoverage, recordedShare } from '../src/data/coverage.js';
import { Repository } from '../src/data/database.js';

const now = new Date('2026-09-06T12:00:00+08:00');
const at = (value: string) => Date.parse(`2026-09-${value}+08:00`);

test('coverage preserves seven full days and merges overlaps across sources and midnight', () => {
  const days = recordedCoverage([
    { source: 'dayflow', start: at('05T23:00:00'), end: at('06T02:00:00') },
    { source: 'dayflow', start: at('06T01:00:00'), end: at('06T03:00:00') },
    { source: 'health-sleep', start: at('06T00:00:00'), end: at('06T08:00:00') },
    { source: 'health', start: at('06T11:00:00'), end: at('06T13:00:00') },
    { source: 'dayflow', start: NaN, end: NaN },
  ], now);
  assert.equal(days.length, 7);
  assert.equal(days[0].recordedSeconds, 9 * 3600);
  assert.equal(days[1].recordedSeconds, 3600);
  assert.equal(days[6].recordedSeconds, 0);
  assert.deepEqual(days[0].lanes.find(lane => lane.source === 'dayflow')?.spans, [{ startHour: 0, endHour: 3 }]);
  assert.deepEqual(days[0].lanes.find(lane => lane.source === 'health')?.spans, [{ startHour: 11, endHour: 12 }]);
});

test('Dayflow coverage crosses its 4am boundary without exposing narratives or counting errors', () => {
  const repository = new Repository(':memory:');
  try {
    repository.dayflow.ingest({ schemaVersion: 1, deviceId: 'private-mac', day: '2026-09-05',
      observedAt: '2026-09-06T04:00:00+08:00', timeZone: 'Asia/Taipei', dayBoundaryHour: 4, categories: [],
      cards: [
        { record_id: 1, start: '2026-09-05T23:00:00+08:00', end: '2026-09-06T02:00:00+08:00', category: 'Idle', duration_minutes: 180, title: 'PRIVATE NARRATIVE' },
        { record_id: 2, start: '2026-09-06T02:00:00+08:00', end: '2026-09-06T03:00:00+08:00', category: 'System', duration_minutes: 60, title: 'PRIVATE ERROR' },
      ] });
    const coverage = repository.activityCoverage(now);
    assert.equal(coverage[0].recordedSeconds, 7200);
    assert.equal(coverage[1].recordedSeconds, 3600);
    assert.doesNotMatch(JSON.stringify(coverage), /PRIVATE|private-mac|record_id/);
    assert.ok(repository.activityCoverage(now, { dayflow: false, health: false }).every(day => day.recordedSeconds === 0));
  } finally { repository.close(); }
});

test('listening coverage ends at the stream timestamp and never invents time for a point event', () => {
  const repository = new Repository(':memory:');
  try {
    repository.finishSync(repository.startSync('statsfm'), {
      source: 'statsfm', profile: { id: 'sky', name: 'Sky', avatar: '', url: '' }, stats: {}, extra: {},
      entries: [{ source: 'statsfm', sourceItemId: 'listen', kind: 'music', title: 'Track', image: '', rating: null,
        activityAt: '2026-09-06T01:00:00+08:00', extra: { durationMs: 7200000 } },
      { source: 'statsfm', sourceItemId: 'point', kind: 'music', title: 'Unknown duration', image: '', rating: null,
        activityAt: '2026-09-06T03:00:00+08:00', extra: {} }],
    });
    const days = repository.activityCoverage(now);
    assert.equal(days[0].recordedSeconds, 3600);
    assert.equal(days[1].recordedSeconds, 3600);
    assert.deepEqual(days[0].lanes[0].spans, [{ startHour: 0, endHour: 1 }]);
  } finally { repository.close(); }
});

test('recorded share divides by elapsed time, counting today only up to now', () => {
  const days = recordedCoverage([
    { source: 'health-sleep', start: at('06T00:00:00'), end: at('06T06:00:00') },
    { source: 'dayflow', start: at('05T00:00:00'), end: at('05T12:00:00') },
  ], now, 28);
  assert.equal(days.length, 28);
  // 18 h recorded out of 27 full days plus 12 h of today.
  assert.equal(recordedShare(days, now), 18 / (27 * 24 + 12));
  assert.equal(recordedShare([], now), null);
  assert.equal(recordedShare(recordedCoverage([], now, 28), now), 0);
});
