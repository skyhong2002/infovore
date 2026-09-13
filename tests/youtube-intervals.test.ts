import test from 'node:test';
import assert from 'node:assert/strict';
import { config } from '../src/config.js';
import { Repository } from '../src/data/database.js';
import { syncYoutubeIntervals } from '../src/sources/youtube.js';

const now = new Date('2026-09-06T12:00:00+08:00');
const at = (value: string) => `2026-09-${value}+08:00`;

function mockFetch(pages: Array<Record<string, unknown>>): { calls: string[]; restore: () => void } {
  const calls: string[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    calls.push(url + ' ' + String((init?.headers as Record<string, string>)?.Authorization));
    const body = pages[Math.min(calls.length - 1, pages.length - 1)] ?? { intervals: [], nextSince: null };
    return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  return { calls, restore: () => { globalThis.fetch = original; } };
}

test('intervals sync pages by eventId, prefers measured seconds, and stores no titles', async () => {
  const repository = new Repository(':memory:');
  const previous = config.urtube.dashboardToken;
  config.urtube.dashboardToken = 'dash-token';
  const fetcher = mockFetch([
    { nextSince: at('06T01:00:00'), intervals: [
      { eventId: 'e1', videoId: 'v1', title: 'PRIVATE TITLE', channelTitle: 'PRIVATE CHANNEL', watchedAt: at('06T00:00:00'), precision: 'exact', durationSeconds: 900, actualWatchedSeconds: 1800, estimatedWatchSeconds: 600 },
      { eventId: 'e2', title: 'PRIVATE', watchedAt: at('06T01:00:00'), precision: 'exact', durationSeconds: 900, actualWatchedSeconds: null, estimatedWatchSeconds: 1200 },
    ] },
    { nextSince: null, intervals: [
      { eventId: 'e2', title: 'PRIVATE', watchedAt: at('06T01:00:00'), precision: 'exact', durationSeconds: 900, actualWatchedSeconds: null, estimatedWatchSeconds: 3600 },
      { eventId: 'e3', title: 'PRIVATE', watchedAt: at('05T12:00:00'), precision: 'day', durationSeconds: 900, actualWatchedSeconds: null, estimatedWatchSeconds: 7200 },
    ] },
  ]);
  try {
    assert.equal(await syncYoutubeIntervals(repository), 4);
    assert.equal(fetcher.calls.length, 2);
    assert.match(fetcher.calls[0], /\/u\/[^/]+\/intervals\.json\?since=2000-01-01T00%3A00%3A00\.000Z&limit=5000 Bearer dash-token$/);
    assert.match(fetcher.calls[1], /since=2026-09-06T01%3A00%3A00%2B08%3A00/);

    const days = repository.activityCoverage(now, { dayflow: false, health: false });
    // e1 measured 30 min, e2 revised to 60 min by the second page, e3 day-precision excluded.
    assert.equal(days[0].recordedSeconds, 1800 + 3600);
    assert.equal(days[1].recordedSeconds, 0);
    assert.deepEqual(days[0].lanes, [{ source: 'youtube', spans: [{ startHour: 0, endHour: 0.5 }, { startHour: 1, endHour: 2 }] }]);
    const rows = (repository as any).db.prepare('SELECT * FROM youtube_watch_intervals ORDER BY event_id').all();
    assert.doesNotMatch(JSON.stringify(rows), /PRIVATE|v1/);
    assert.deepEqual(rows.map((row: Record<string, unknown>) => [row.event_id, row.seconds, row.method, row.precision]),
      [['e1', 1800, 'measured', 'exact'], ['e2', 3600, 'estimated', 'exact'], ['e3', 7200, 'estimated', 'day']]);

    // The next sync re-reads one day before the checkpoint so revised estimates land.
    fetcher.calls.length = 0;
    await syncYoutubeIntervals(repository);
    assert.match(fetcher.calls[0], /since=2026-09-04T17%3A00%3A00\.000Z/);
  } finally {
    fetcher.restore();
    config.urtube.dashboardToken = previous;
    repository.close();
  }
});

test('intervals sync is skipped without a dashboard token', async () => {
  const repository = new Repository(':memory:');
  const previous = config.urtube.dashboardToken;
  config.urtube.dashboardToken = '';
  const fetcher = mockFetch([]);
  try {
    assert.equal(await syncYoutubeIntervals(repository), null);
    assert.equal(fetcher.calls.length, 0);
  } finally {
    fetcher.restore();
    config.urtube.dashboardToken = previous;
    repository.close();
  }
});
