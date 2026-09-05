import assert from 'node:assert/strict';
import test from 'node:test';
import { load } from 'cheerio';
import { Repository } from '../src/data/database.js';
import { dashboardActivities } from '../src/health/home.js';
import { nowPage } from '../src/output/pages.js';

test('Now uses Taipei wake-up dates, shows sleep detail, and excludes future records', () => {
  const repository = new Repository(':memory:');
  try {
    const now = new Date('2026-09-05T02:00:00Z');
    repository.ingestHealthConnect({ syncId: 'now-health-sync', deviceId: 'private-device', observedAt: now.toISOString(), deletedRecordIds: [], records: [
      { id: 'private-sleep', dataType: 'sleep_session', dataOrigin: 'private-origin',
        startTime: '2026-09-04T15:00:00Z', endTime: '2026-09-04T23:00:00Z', lastModifiedTime: now.toISOString(),
        payload: { notes: 'private-note', stages: [
          { startTime: '2026-09-04T15:00:00Z', endTime: '2026-09-04T18:00:00Z', stage: 5 },
          { startTime: '2026-09-04T18:00:00Z', endTime: '2026-09-04T23:00:00Z', stage: 6 },
        ] },
      },
      { id: 'future-sleep', dataType: 'sleep_session', dataOrigin: 'private-origin',
        startTime: '2026-09-05T15:00:00Z', endTime: '2026-09-05T23:00:00Z', lastModifiedTime: now.toISOString(), payload: {},
      },
    ] });
    const snapshot = repository.healthConnectSnapshot('Sky', now);
    const activities = dashboardActivities([], snapshot, now);
    assert.equal(activities.length, 1);
    const page = load(nowPage('Sky', [], [], activities));
    const card = page('.health-activity');
    assert.equal(card.length, 1);
    assert.match(card.text(), /23:00–07:00/);
    assert.match(card.text(), /8h 0m 實睡/);
    assert.match(card.text(), /深睡 3h 0m · REM 5h 0m/);
    assert.match(card.find('time').text(), /Sep 5, 2026 · 07:00 GMT\+8 · 醒來/);
    assert.equal(card.find('img').attr('src'), '/logos/healthconnect.png');
    assert.equal(page('.content-section').first().find('.health-activity').length, 0);
    assert.doesNotMatch(page.html(), /private-note|private-device|private-origin|future-sleep/);
    assert.deepEqual(dashboardActivities(activities, null, now), [], 'disabled Health cannot leak stale projections');
  } finally { repository.close(); }
});

test('today’s day-only steps stay visible before 8am without inventing a clock time', () => {
  const repository = new Repository(':memory:');
  try {
    const now = new Date('2026-09-04T22:00:00Z'); // 6am in Taipei, September 5.
    repository.ingestHealthConnect({ syncId: 'now-steps-sync', deviceId: 'private-device', observedAt: now.toISOString(), deletedRecordIds: [], records: [{
      id: 'private-steps', dataType: 'steps', dataOrigin: 'private-origin',
      startTime: '2026-09-04T20:00:00Z', endTime: '2026-09-04T21:00:00Z', lastModifiedTime: now.toISOString(), payload: { count: 321 },
    }] });
    const activities = dashboardActivities([], repository.healthConnectSnapshot('Sky', now), now);
    assert.equal(activities.length, 1);
    assert.equal(activities[0]?.occurredAtPrecision, 'day');
    const card = load(nowPage('Sky', [], [], activities))('.health-activity');
    assert.match(card.text(), /321 steps/);
    assert.equal(card.find('time').text(), 'Sep 5, 2026 · 每日彙總');
  } finally { repository.close(); }
});
