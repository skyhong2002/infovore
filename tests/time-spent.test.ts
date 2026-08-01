import assert from 'node:assert/strict';
import test from 'node:test';
import { Repository } from '../src/data/database.js';
import { taipeiDay, taipeiWindowStarts } from '../src/data/time.js';
import type { SourceSnapshot } from '../src/data/types.js';
import type { YoutubeParsedArchive } from '../src/youtube/types.js';

// Sunday 18:00 Taipei. Calendar windows: day starts 2026-08-01T16:00Z,
// week (Monday) 2026-07-26T16:00Z, month 2026-07-31T16:00Z, year 2025-12-31T16:00Z.
const NOW = new Date('2026-08-02T10:00:00.000Z');

function simklSnapshot(totalMinutes: number, activityAt?: string): SourceSnapshot {
  return {
    source: 'simkl',
    profile: { id: '1', name: 'Sky', avatar: '', url: '' },
    stats: { moviesCompleted: 1, totalMinutes },
    entries: activityAt ? [{
      sourceItemId: 'movie-1', source: 'simkl', kind: 'movie', title: 'Movie', image: '',
      activityAt, rating: null, extra: {},
    }] : [],
    extra: {},
  };
}

test('Taipei calendar helpers anchor windows to UTC+8', () => {
  assert.equal(taipeiDay(NOW), '2026-08-02');
  assert.equal(taipeiDay('2026-08-01T16:00:00.000Z'), '2026-08-02');
  assert.equal(taipeiDay('2026-08-01T15:59:59.000Z'), '2026-08-01');
  const starts = taipeiWindowStarts(NOW);
  assert.equal(starts.day.toISOString(), '2026-08-01T16:00:00.000Z');
  assert.equal(starts.week.toISOString(), '2026-07-26T16:00:00.000Z');
  assert.equal(starts.month.toISOString(), '2026-07-31T16:00:00.000Z');
  assert.equal(starts.year.toISOString(), '2025-12-31T16:00:00.000Z');
});

test('migration v7 creates the time ledger tables', () => {
  const repository = new Repository(':memory:');
  const raw = (repository as any).db;
  assert.equal((raw.prepare('PRAGMA user_version').get() as { user_version: number }).user_version, 7);
  const tables = raw.prepare(
    "SELECT name FROM sqlite_master WHERE type='table' AND name IN ('time_ledger', 'time_ledger_state')"
  ).all() as Array<{ name: string }>;
  assert.deepEqual(tables.map((table) => table.name).sort(), ['time_ledger', 'time_ledger_state']);
  repository.close();
});

test('stats.fm windows sum local stream durations into rolling and calendar buckets', () => {
  const repository = new Repository(':memory:');
  const stream = (id: string, activityAt: string, durationMs: number) => ({
    sourceItemId: id, source: 'statsfm', kind: 'music' as const, title: `Track ${id}`, image: '',
    status: 'listened', activityAt, rating: null, extra: { durationMs },
  });
  repository.ingestEntries([
    stream('a', '2026-08-02T09:00:00Z', 600_000),   // 1 h ago: every window
    stream('b', '2026-07-30T10:00:00Z', 1_200_000), // this week, before the month started
    stream('c', '2026-04-24T10:00:00Z', 1_800_000), // this year only
  ]);
  const statsfm = repository.timeSpent(NOW).sources.find((entry) => entry.source === 'statsfm');
  assert.equal(statsfm?.method, 'measured');
  assert.deepEqual(statsfm?.windows, { last24h: 600, day: 600, week: 1800, month: 600, year: 3600, allTime: 3600 });
  repository.close();
});

test('stats.fm calendar windows prefer fresh remote totals and ignore stale ones', () => {
  const repository = new Repository(':memory:');
  repository.ingestEntries([{
    sourceItemId: 'a', source: 'statsfm', kind: 'music', title: 'Track', image: '',
    status: 'listened', activityAt: '2026-08-02T09:00:00Z', rating: null, extra: { durationMs: 600_000 },
  }]);
  const snapshot: SourceSnapshot = {
    source: 'statsfm',
    profile: { id: 'sky', name: 'Sky', avatar: '', url: '' },
    stats: { weeklyStreams: 1, weekMinutes: 120, monthMinutes: 300, yearMinutes: 1000, lifetimeMinutes: 5000 },
    entries: [],
    extra: {},
  };
  repository.finishSync(repository.startSync('statsfm'), snapshot, '2026-08-02T10:00:00.000Z');
  const fresh = repository.timeSpent(NOW).sources.find((entry) => entry.source === 'statsfm');
  assert.deepEqual(fresh?.windows, {
    last24h: 600, day: 600, week: 7200, month: 18000, year: 60000, allTime: 300000,
  });

  // A fetch from before the current week/month began cannot describe them;
  // those windows fall back to local streams. Year and lifetime still apply.
  repository.finishSync(repository.startSync('statsfm'), snapshot, '2026-07-20T00:00:00.000Z');
  const stale = repository.timeSpent(NOW).sources.find((entry) => entry.source === 'statsfm');
  assert.deepEqual(stale?.windows, {
    last24h: 600, day: 600, week: 600, month: 600, year: 60000, allTime: 300000,
  });
  repository.close();
});

test('YouTube windows reuse the estimation engine and match the dashboard total', () => {
  const repository = new Repository(':memory:');
  const watch = (eventId: string, videoId: string, watchedAt: string, actualWatchedSeconds: number) => ({
    eventId, videoId, title: `Video ${videoId}`, url: `https://www.youtube.com/watch?v=${videoId}`,
    channelId: null, channelTitle: null, channelUrl: null,
    watchedAt, actualWatchedSeconds, activityType: 'video' as const,
  });
  const archive: YoutubeParsedArchive = {
    archiveHash: 'time-spent-fixture',
    source: 'takeout',
    watches: [
      watch('w1', 'VID00000001', '2026-08-02T08:00:00Z', 1200),
      watch('w2', 'VID00000002', '2026-07-23T08:00:00Z', 900),
    ],
    searches: [],
  };
  repository.ingestYoutubeArchive(archive);
  const youtube = repository.timeSpent(NOW).sources.find((entry) => entry.source === 'youtube');
  assert.equal(youtube?.method, 'measured');
  assert.deepEqual(youtube?.windows, { last24h: 1200, day: 1200, week: 1200, month: 1200, year: 2100, allTime: 2100 });
  assert.equal(repository.youtubeDashboard('all', NOW).stats.estimatedWatchSeconds, 2100);
  repository.close();
});

test('lifetime-delta ledger seeds first, accumulates growth, and clamps recounts', () => {
  const repository = new Repository(':memory:');

  // First sighting seeds the watermark without recording any time.
  repository.recordTimeLedger(simklSnapshot(100), new Date('2026-08-01T10:00:00Z'));
  assert.equal(repository.timeSpent(NOW).sources.find((entry) => entry.source === 'simkl'), undefined);

  // +30 minutes since the watermark lands on the refresh's Taipei day.
  repository.recordTimeLedger(simklSnapshot(130), new Date('2026-08-02T09:00:00Z'));
  let simkl = repository.timeSpent(NOW).sources.find((entry) => entry.source === 'simkl');
  assert.equal(simkl?.method, 'estimated');
  assert.deepEqual(simkl?.windows, { last24h: 1800, day: 1800, week: 1800, month: 1800, year: 1800, allTime: 1800 });

  // A platform-side recount shrinking the total records nothing.
  repository.recordTimeLedger(simklSnapshot(120), new Date('2026-08-02T09:30:00Z'));
  simkl = repository.timeSpent(NOW).sources.find((entry) => entry.source === 'simkl');
  assert.equal(simkl?.windows.allTime, 1800);
  repository.close();
});

test('ledger deltas attribute to the newest entry activity since the watermark', () => {
  const repository = new Repository(':memory:');
  repository.recordTimeLedger(simklSnapshot(100), new Date('2026-08-01T10:00:00Z'));
  // The growth was observed on Aug 2 (UTC) but the newest watch happened on
  // Aug 1 14:00Z = Aug 1 22:00 Taipei — it belongs to the previous day.
  repository.recordTimeLedger(simklSnapshot(130, '2026-08-01T14:00:00Z'), new Date('2026-08-02T09:00:00Z'));
  const raw = (repository as any).db;
  const row = raw.prepare("SELECT day, seconds, method FROM time_ledger WHERE source='simkl'").get() as
    { day: string; seconds: number; method: string };
  assert.deepEqual({ ...row }, { day: '2026-08-01', seconds: 1800, method: 'estimated' });
  const simkl = repository.timeSpent(NOW).sources.find((entry) => entry.source === 'simkl');
  // Yesterday's ledger day sits inside week/month/year but not today.
  assert.deepEqual(simkl?.windows, { last24h: 0, day: 0, week: 1800, month: 1800, year: 1800, allTime: 1800 });
  repository.close();
});

test('Kitsu snapshots feed the ledger through animeSeconds', () => {
  const repository = new Repository(':memory:');
  const snapshot = (animeSeconds: number): SourceSnapshot => ({
    source: 'kitsu',
    profile: { id: 'sky', name: 'Sky', avatar: '', url: '' },
    stats: { animeCompleted: 3, animeHours: Math.round(animeSeconds / 3600), animeSeconds },
    entries: [],
    extra: {},
  });
  repository.recordTimeLedger(snapshot(720_000), new Date('2026-08-01T10:00:00Z'));
  repository.recordTimeLedger(snapshot(721_440), new Date('2026-08-02T09:00:00Z'));
  const kitsu = repository.timeSpent(NOW).sources.find((entry) => entry.source === 'kitsu');
  assert.equal(kitsu?.method, 'estimated');
  assert.equal(kitsu?.windows.day, 1440);
  assert.equal(kitsu?.windows.allTime, 1440);
  // Sources without a lifetime figure are a no-op.
  repository.recordTimeLedger({
    source: 'goodreads', profile: { id: 'g', name: 'G', avatar: '', url: '' }, stats: { books: 3 }, entries: [], extra: {},
  });
  assert.equal(repository.timeSpent(NOW).sources.some((entry) => entry.source === 'goodreads'), false);
  repository.close();
});

test('summary totals aggregate sources and keep a measured-only figure', () => {
  const repository = new Repository(':memory:');
  repository.ingestEntries([{
    sourceItemId: 'a', source: 'statsfm', kind: 'music', title: 'Track', image: '',
    status: 'listened', activityAt: '2026-08-02T09:00:00Z', rating: null, extra: { durationMs: 600_000 },
  }]);
  repository.recordTimeLedger(simklSnapshot(100), new Date('2026-08-01T10:00:00Z'));
  repository.recordTimeLedger(simklSnapshot(130), new Date('2026-08-02T09:00:00Z'));
  const summary = repository.timeSpent(NOW);
  assert.equal(summary.total.last24h, 600 + 1800);
  assert.equal(summary.measuredTotal.last24h, 600);
  assert.equal(summary.total.allTime, 600 + 1800);
  // Sorted by all-time descending.
  assert.deepEqual(summary.sources.map((entry) => entry.source), ['simkl', 'statsfm']);
  repository.close();
});
