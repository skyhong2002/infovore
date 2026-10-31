import assert from 'node:assert/strict';
import test from 'node:test';
import type { SourceSnapshot } from '../src/data/types.js';

// Exercise the real adapter -> refresh -> SQLite/cache -> health path. All
// upstream responses below are synthetic; no Goodreads or production writes.
test('unavailable Goodreads retains its last successful publication and visible source error', async (t) => {
  process.env.NODE_ENV = 'test';
  process.env.DATABASE_PATH = ':memory:';
  process.env.SOURCES = 'goodreads';
  process.env.HEALTH_CONNECT_TOKEN = '';
  process.env.INGEST_TOKEN = '';
  const { app, refreshSource, repository } = await import('../src/index.js');
  const { restoreCache, getCache } = await import('../src/data/cache.js');
  t.after(() => repository.close());
  t.mock.method(console, 'error', () => {});
  const fetchedAt = Date.now() - 60_000;
  const lastGood: SourceSnapshot = {
    source: 'goodreads',
    profile: { id: 'fixture', name: 'Reader', avatar: '', url: 'https://example.test/reader' },
    stats: { readCount: 6, currentlyReadingCount: 1, toReadCount: 9 },
    entries: [{ sourceItemId: '1', source: 'goodreads', kind: 'book', title: 'Keep this book', image: '',
      status: 'read', activityAt: '2026-10-01T00:00:00Z', rating: null, extra: {} }],
    extra: {},
  };
  repository.finishSync(repository.startSync('goodreads'), lastGood, new Date(fetchedAt).toISOString());
  restoreCache('data:goodreads', lastGood, fetchedAt);
  const before = repository.loadSnapshots().find((s) => s.snapshot.source === 'goodreads');
  const goodProfile = '<h1>Reader</h1><a href="?shelf=read">read (6)</a><a href="?shelf=currently-reading">reading (1)</a><a href="?shelf=to-read">queued (9)</a>';
  const rss = '<rss><channel></channel></rss>';

  for (const mode of ['404', 'HTML', 'missing-count'] as const) {
    await t.test(mode, async (t) => {
      t.mock.method(globalThis, 'fetch', async (input: string | URL | Request) => {
        if (String(input).includes('/user/show/')) return new Response(mode === 'missing-count' ? '<h1>Sign in</h1>' : goodProfile);
        return mode === '404' ? new Response('<html>Page not found</html>', { status: 404 })
          : new Response(mode === 'HTML' ? '<html>Sign in</html>' : rss);
      });
      // isRetry avoids scheduling the existing two-minute retry in this test.
      await refreshSource('goodreads', true);
      const cached = getCache<SourceSnapshot>('data:goodreads');
      assert.deepEqual(cached?.data, lastGood);
      assert.equal(cached?.fetchedAt, fetchedAt);
      const expected = mode === '404' ? /HTTP 404/ : mode === 'HTML' ? /RSS unavailable/ : /missing read shelf count/;
      assert.match(cached?.error ?? '', expected);
      const persisted = repository.loadSnapshots().find((s) => s.snapshot.source === 'goodreads');
      assert.deepEqual(persisted?.snapshot, before?.snapshot);
      assert.equal(persisted?.fetchedAt, before?.fetchedAt);
      assert.match(persisted?.error ?? '', expected);
      assert.equal(repository.latestRuns().find((run) => run.source === 'goodreads')?.status, 'error');
      assert.equal(repository.listActivities().filter((a) => a.source === 'goodreads').length, 1);
      const health = await (await app.request('/healthz')).json() as {
        status: string; sources: Array<{ source: string; fresh: boolean; error: string | null }>;
      };
      assert.equal(health.status, 'degraded');
      assert.match(health.sources.find((s) => s.source === 'goodreads')?.error ?? '', expected);
    });
  }
});
