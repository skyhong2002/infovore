import assert from 'node:assert/strict';
import test from 'node:test';
import { Repository } from '../src/data/database.js';
import { taipeiDay, taipeiWindowStarts } from '../src/data/time.js';
import type { SourceSnapshot } from '../src/data/types.js';

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

test('migration creates the time ledger tables', () => {
  const repository = new Repository(':memory:');
  const raw = (repository as any).db;
  assert.equal((raw.prepare('PRAGMA user_version').get() as { user_version: number }).user_version, 9);
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

test('YouTube time mirrors urtube\'s per-day series and replaces it on every sync', () => {
  const repository = new Repository(':memory:');
  const snapshot = (daily: Array<{ day: string; watches: number; estimatedWatchSeconds: number }>): SourceSnapshot<unknown> => ({
    source: 'youtube', profile: { id: 'sky', name: 'Sky', avatar: '', url: '' },
    stats: { watchEvents: daily.length }, entries: [], extra: { daily },
  });
  const youtube = () => repository.timeSpent(NOW).sources.find((entry) => entry.source === 'youtube');
  repository.recordTimeLedger(snapshot([
    { day: '2026-08-02', watches: 3, estimatedWatchSeconds: 1200 },
    { day: '2026-07-23', watches: 1, estimatedWatchSeconds: 900 },
    { day: '2026-07-24', watches: 1, estimatedWatchSeconds: 0 },
  ]), NOW);
  assert.equal(youtube()?.method, 'estimated');
  assert.deepEqual(youtube()?.windows, { last24h: 1200, day: 1200, week: 1200, month: 1200, year: 2100, allTime: 2100 });
  // An upstream revision (a shorter estimate today, the July day gone) is
  // mirrored rather than accrued on top of the old series.
  repository.recordTimeLedger(snapshot([{ day: '2026-08-02', watches: 3, estimatedWatchSeconds: 600 }]), NOW);
  assert.deepEqual(youtube()?.windows, { last24h: 600, day: 600, week: 600, month: 600, year: 600, allTime: 600 });
  // An empty series (upstream outage, private dashboard) keeps the last good ledger.
  repository.recordTimeLedger(snapshot([]), NOW);
  assert.equal(youtube()?.windows.allTime, 600);
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

test('attended events count their scheduled span with a 2 h default, excluding private ones', () => {
  const repository = new Repository(':memory:');
  const event = (id: string, activityAt: string, overrides: Record<string, unknown> = {}) => ({
    sourceItemId: id, source: 'events', kind: 'event' as const, title: `Event ${id}`, image: '',
    status: 'attended', activityAt, rating: null, extra: {}, ...overrides,
  });
  repository.ingestEntries([
    event('scheduled', '2026-08-02T08:00:00Z', { extra: { durationMinutes: 90 } }), // 90 min, every window
    event('no-end', '2026-07-30T10:00:00Z'),                                        // defaults to 2 h, this week
    event('ticketed', '2026-07-30T12:00:00Z', { status: 'ticketed' }),              // not confirmed attended
    event('future', '2099-01-01T12:00:00Z'),                                        // has not happened
    event('secret', '2026-08-02T09:00:00Z', { visibility: 'private' as const }),    // stays out of public totals
  ]);
  const events = repository.timeSpent(NOW).sources.find((entry) => entry.source === 'events');
  assert.equal(events?.method, 'estimated');
  assert.deepEqual(events?.windows, {
    last24h: 5400, day: 5400, week: 12600, month: 5400, year: 12600, allTime: 12600,
  });
  repository.close();
});

test('finished books estimate reading time from page counts', () => {
  const repository = new Repository(':memory:');
  const book = (id: string, status: string, extra: Record<string, number>) => ({
    sourceItemId: id, source: 'goodreads', kind: 'book' as const, title: `Book ${id}`, image: '',
    status, activityAt: '2026-08-02T09:00:00Z', rating: null, extra,
  });
  repository.ingestEntries([
    book('finished', 'read', { pages: 300 }),   // 300 pages × 120 s
    book('reading', 'reading', { pages: 500 }), // not finished yet
    book('no-pages', 'read', {}),               // RSS had no page count
  ]);
  const goodreads = repository.timeSpent(NOW).sources.find((entry) => entry.source === 'goodreads');
  assert.equal(goodreads?.method, 'estimated');
  assert.deepEqual(goodreads?.windows, {
    last24h: 36000, day: 36000, week: 36000, month: 36000, year: 36000, allTime: 36000,
  });
  repository.close();
});

test('Backloggd daily playtime logs backfill history and accrue idempotently', () => {
  const repository = new Repository(':memory:');
  const snapshot = (sessions: Array<{ game: string; day: string; minutes: number }>): SourceSnapshot<unknown> => ({
    source: 'backloggd',
    profile: { id: 'sky', name: 'sky', avatar: '', url: '' },
    stats: { gamesPlayed: 2 },
    entries: [],
    extra: { yearExtras: '', sessions },
  });
  const history = [
    { game: 'game-a', day: '2026-08-02', minutes: 5 },
    { game: 'game-a', day: '2026-07-30', minutes: 30 },
    { game: 'game-b', day: '2026-04-10', minutes: 60 },
  ];

  // First sighting records the full visible history on its actual days —
  // dated logs backfill instead of seeding.
  repository.recordTimeLedger(snapshot(history), new Date('2026-08-02T08:00:00Z'));
  let backloggd = repository.timeSpent(NOW).sources.find((entry) => entry.source === 'backloggd');
  assert.equal(backloggd?.method, 'measured');
  assert.deepEqual(backloggd?.windows, { last24h: 300, day: 300, week: 2100, month: 300, year: 5700, allTime: 5700 });

  // Re-scraping the same history adds nothing.
  repository.recordTimeLedger(snapshot(history), new Date('2026-08-02T09:00:00Z'));
  assert.equal(repository.timeSpent(NOW).sources.find((entry) => entry.source === 'backloggd')?.windows.allTime, 5700);

  // Growth on an already-recorded day accrues only the difference; a shrunk
  // log keeps what was already recorded.
  repository.recordTimeLedger(snapshot([
    { game: 'game-a', day: '2026-08-02', minutes: 25 },
    { game: 'game-b', day: '2026-04-10', minutes: 30 },
  ]), new Date('2026-08-02T09:30:00Z'));
  backloggd = repository.timeSpent(NOW).sources.find((entry) => entry.source === 'backloggd');
  assert.equal(backloggd?.windows.day, 1500);
  assert.equal(backloggd?.windows.allTime, 6900);

  // Duplicate (game, day) rows — separate playthroughs — aggregate before
  // the watermark comparison.
  repository.recordTimeLedger(snapshot([
    { game: 'game-a', day: '2026-08-02', minutes: 20 },
    { game: 'game-a', day: '2026-08-02', minutes: 15 },
  ]), new Date('2026-08-02T09:45:00Z'));
  backloggd = repository.timeSpent(NOW).sources.find((entry) => entry.source === 'backloggd');
  assert.equal(backloggd?.windows.day, 2100);
  assert.equal(backloggd?.windows.allTime, 7500);
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
