import assert from 'node:assert/strict';
import test from 'node:test';
import { load } from 'cheerio';
import { Repository } from '../src/data/database.js';
import { homePage, type HomepageData } from '../src/output/home.js';
import { healthHomepageActivities, recordedSleepWindows } from '../src/health/home.js';

const home: HomepageData = {
  ownerName: 'Sky', avatar: '', lastUpdated: null, allActivities: [], recentActivities: [],
  sourceHighlights: [], timeSpent: null, publicActivityCount: 0, connectedSources: 1,
};

test('Health is integrated into the four existing homepage sections, never a standalone block', () => {
  const repository = new Repository(':memory:');
  try {
    repository.ingestHealthConnect({ syncId: 'homepage-health', deviceId: 'private-device',
      observedAt: '2026-09-05T02:00:00Z', deletedRecordIds: [], records: [
        { id: 'private-sleep', dataType: 'sleep_session', dataOrigin: 'private-origin',
          startTime: '2026-09-04T15:00:00Z', endTime: '2026-09-04T23:00:00Z', lastModifiedTime: '2026-09-04T23:00:00Z',
          payload: { notes: 'private-note', stages: [
            { startTime: '2026-09-04T15:00:00Z', endTime: '2026-09-04T18:00:00Z', stage: 5 },
            { startTime: '2026-09-04T18:00:00Z', endTime: '2026-09-04T23:00:00Z', stage: 6 },
          ] },
        },
        { id: 'private-workout', dataType: 'exercise_session', dataOrigin: 'private-origin',
          startTime: '2026-09-05T01:00:00Z', endTime: '2026-09-05T01:30:00Z', lastModifiedTime: '2026-09-05T01:30:00Z',
          payload: { exerciseType: 79, notes: 'private-note' },
        },
        { id: 'private-steps', dataType: 'steps', dataOrigin: 'private-origin',
          startTime: '2026-09-05T01:00:00Z', endTime: '2026-09-05T01:30:00Z', lastModifiedTime: '2026-09-05T01:30:00Z',
          payload: { count: 4321 },
        },
      ],
    });
    const now = new Date('2026-09-05T02:00:00Z');
    const snapshot = repository.healthConnectSnapshot('Sky', now);
    const activities = healthHomepageActivities(snapshot);
    assert.equal(activities.length, 3);
    assert.equal(activities.find(a => a.status === 'steps')?.occurredAtPrecision, 'day');
    const sleep = activities.find(a => a.status === 'sleep')!;
    assert.equal(sleep.occurredAt, '2026-09-04T23:00:00.000Z');
    const page = load(homePage({ ...home, allActivities: activities, recentActivities: activities,
      sourceHighlights: [sleep], healthSleepTime: repository.healthConnectSleepTime(now), timeSpent: repository.timeSpent(now),
    }));
    assert.equal(page('#health, .home-health, .sleep-row').length, 0);
    assert.match(page('.home-platform-scroller').text(), /Sleep · 睡眠/);
    assert.match(page('.home-platform-scroller').text(), /23:00–07:00/);
    assert.equal(page('.home-platform-scroller img').attr('src'), '/logos/healthconnect.png');
    assert.equal(page('[data-hour="7"] .home-rhythm-sleep').attr('data-count'), '1');
    assert.equal(page('[data-hour="9"] .home-rhythm-exercise').attr('data-count'), '1');
    assert.equal(page('[data-hour="8"] .home-rhythm-exercise').length, 0, 'steps are not midnight events');
    assert.match(page('[data-source="health-sleep"]').text(), /8h/);
    assert.match(page('[data-source="health"]').text(), /30m/);
    assert.equal(page('#recent .home-recent-item').length, 3);
    assert.match(page('#recent').text(), /8h 0m 實睡/);
    assert.match(page('#recent').text(), /30 min exercise/);
    assert.match(page('#recent').text(), /4,321 steps/);
    assert.equal(repository.timeSpent(now).sources.find(s => s.source === 'health')?.windows.allTime, 1800,
      'sleep must not be silently added to the exercise/media ledger');
    assert.doesNotMatch(page.html(), /private-note|private-sleep|private-device|private-origin/);
  } finally { repository.close(); }
});

test('sleep time includes all history, clips Taipei windows and future time, and merges overlaps', () => {
  const rows = [
    { start_at: '2026-09-04T15:00:00Z', end_at: '2026-09-04T23:00:00Z' },
    { start_at: '2026-09-04T16:00:00Z', end_at: '2026-09-04T22:00:00Z' },
    { start_at: '2026-07-01T15:00:00Z', end_at: '2026-07-01T23:00:00Z' },
    { start_at: '2026-09-05T01:00:00Z', end_at: '2026-09-05T04:00:00Z' },
    { start_at: '2026-09-06T01:00:00Z', end_at: '2026-09-06T04:00:00Z' },
  ];
  const windows = recordedSleepWindows(rows, new Date('2026-09-05T02:00:00Z'));
  assert.deepEqual(windows, { last24h: 9 * 3600, day: 8 * 3600, week: 9 * 3600,
    month: 9 * 3600, year: 17 * 3600, allTime: 17 * 3600 });
});

test('empty Health does not invent events or a sleep-time row', () => {
  const repository = new Repository(':memory:');
  try {
    assert.deepEqual(healthHomepageActivities(repository.healthConnectSnapshot('Sky')), []);
    const page = load(homePage({ ...home, healthSleepTime: repository.healthConnectSleepTime() }));
    assert.equal(page('#health, .home-health, [data-source="health-sleep"]').length, 0);
  } finally { repository.close(); }
});
