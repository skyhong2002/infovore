import assert from 'node:assert/strict';
import test from 'node:test';

// Config is read when the app loads, so enable PocketLog before importing it.
process.env.POCKETLOG_URL = 'http://pocketlog.test:8080';
process.env.POCKETLOG_TOKEN = 'a'.repeat(64);
const { app, repository } = await import('../src/index.js');
const { Repository } = await import('../src/data/database.js');
const { buildSnapshot } = await import('../src/pocketlog/store.js');
const { syncPocketlog, PocketlogHttpError } = await import('../src/pocketlog/sync.js');

const H = 3_600_000;
const at = (iso: string) => Date.parse(iso);
const categories = [
  { id: 'work', name: '工作', color: '#b9a4ed', role: 'focus' },
  { id: 'social_media', name: '社群', color: '#e69c9c', role: 'distraction' },
  { id: 'idle', name: '閒置', color: '#92949e', role: 'neutral' },
];

interface Stored { id: string; start_ms: number; end_ms: number; category: string; app: string; title: string; summary: string; edited?: string; source?: string }

// A PocketLog stand-in: clips to the requested range, pages two at a time, checks the key.
function fakePocketlog(journal: Stored[], options: { epoch?: () => number; token?: string } = {}) {
  const calls: string[] = [];
  const fetcher = (async (input: string | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    calls.push(url.pathname + url.search);
    assert.equal(init?.redirect, 'error');
    if ((init?.headers as Record<string, string>).Authorization !== `Bearer ${options.token ?? 'a'.repeat(64)}`) return new Response('{"error":"unauthorized"}', { status: 401 });
    if (url.pathname === '/v1/workspace') return Response.json({ revision: 1, categories, rules: [] });
    const from = Number(url.searchParams.get('from_ms')), to = Number(url.searchParams.get('to_ms'));
    assert.ok(to - from <= 30 * 24 * H, 'at most 30 days per read');
    const after = url.searchParams.get('after_id');
    const rows = journal.filter((a) => a.end_ms > from && a.start_ms < to).sort((a, b) => a.start_ms - b.start_ms || a.id.localeCompare(b.id));
    const start = after ? rows.findIndex((a) => a.id === after) + 1 : 0;
    const page = rows.slice(start, start + 2);
    const clip = (a: Stored) => ({ start_ms: Math.max(from, a.start_ms), end_ms: Math.min(to, a.end_ms) });
    return Response.json({
      activities: page.map((a) => ({ id: a.id, app: a.app, category: a.category, ...clip(a) })),
      cards: page.map((a) => ({ id: a.id, app: a.app, category: a.edited ?? a.category, title: a.title, summary: a.summary, source: a.source ?? 'ai', ...clip(a) })),
      next_cursor: start + 2 < rows.length ? { after_start_ms: page.at(-1)!.start_ms, after_id: page.at(-1)!.id } : null,
      journal_epoch: options.epoch?.() ?? 5, scanned: page.length,
    });
  }) as typeof fetch;
  return { fetcher, calls };
}

const config = { baseUrl: 'http://pocketlog.test:8080', token: 'a'.repeat(64), intervalMinutes: 15 };

test('the sync keeps intervals, categories and vocabulary keywords, never titles or apps', async () => {
  const repo = new Repository(':memory:');
  const now = new Date('2026-11-18T12:00:00+08:00');
  const journal: Stored[] = [
    // Crosses the 04:00 day boundary, and the 3-day re-read below clips it.
    { id: 'a1', start_ms: at('2026-11-15T03:00:00+08:00'), end_ms: at('2026-11-15T05:00:00+08:00'), category: 'unsorted', edited: 'work',
      app: 'com.secret.app', title: 'Debugging the Kotlin build with my friend Alice', summary: 'Private chat about 0912-345-678' },
    { id: 'a2', start_ms: at('2026-11-16T10:00:00+08:00'), end_ms: at('2026-11-16T11:00:00+08:00'), category: 'social_media',
      app: 'com.facebook.katana', title: 'Scrolling Facebook', summary: '' },
    { id: 'a3', start_ms: at('2026-11-17T10:00:00+08:00'), end_ms: at('2026-11-17T10:30:00+08:00'), category: 'idle',
      app: 'com.android.systemui', title: 'Lock screen', summary: '' },
    { id: 'a4', start_ms: at('2026-11-18T09:00:00+08:00'), end_ms: at('2026-11-18T09:45:00+08:00'), category: 'work',
      app: 'com.github.android', title: 'Reviewing a GitHub pull request on com.github.android', summary: '' },
    // App-only cards are titled with the package name: no keywords from them.
    { id: 'a5', start_ms: at('2026-11-18T10:00:00+08:00'), end_ms: at('2026-11-18T10:05:00+08:00'), category: 'unsorted',
      app: 'com.google.android.apps.maps', title: 'com.google.android.apps.maps', summary: '', source: 'app_only' },
  ];
  const { fetcher, calls } = fakePocketlog(journal);
  const first = await syncPocketlog(repo.pocketlog, config, now, fetcher);
  assert.equal(first.read, 5);
  assert.ok(calls.filter((c) => c.startsWith('/v1/activities')).length > 13, 'the first run backfills in 30-day reads');
  const stored = repo.pocketlog.activities();
  assert.deepEqual(stored.map((a) => [a.id, a.category]), [['a1', 'work'], ['a2', 'social_media'], ['a3', 'idle'], ['a4', 'work'], ['a5', 'unsorted']]);
  assert.deepEqual(stored[0].keywords, ['Kotlin', 'Debugging']);
  assert.deepEqual(stored[3].keywords, ['GitHub', 'Code review'], 'no Android from the package name');
  assert.deepEqual(stored[4].keywords, []);
  const dump = JSON.stringify(stored) + JSON.stringify(repo.pocketlog.categories());
  for (const secret of ['Alice', '0912', 'com.secret.app', 'Scrolling', 'Lock screen']) assert.ok(!dump.includes(secret), secret);

  // A later short re-read only sees a clipped part of a1; the stored interval stays whole.
  const later = new Date(+now + 26 * H);
  const recent = await syncPocketlog(repo.pocketlog, config, later, fakePocketlog(journal).fetcher);
  assert.ok(recent.read >= 4);
  assert.equal(repo.pocketlog.activities()[0].start, journal[0].start_ms);
  assert.equal(repo.pocketlog.activities()[0].end, journal[0].end_ms);

  const snapshot = buildSnapshot(repo.pocketlog.activities(), repo.pocketlog.categories(), repo.pocketlog.status(), 'Sky', now);
  const days = Object.fromEntries(snapshot.extra.daily.map((d) => [d.day, d]));
  assert.equal(days['2026-11-14'].trackedMinutes, 60, 'before 04:00 belongs to the previous day');
  assert.equal(days['2026-11-15'].trackedMinutes, 60);
  assert.equal(days['2026-11-15'].categories[0].name, '工作');
  assert.equal(days['2026-11-17'].idleMinutes, 30);
  assert.equal(days['2026-11-17'].activeMinutes, 0);
  assert.equal(snapshot.stats.todayMinutes, 50);
  assert.equal(snapshot.stats.weeklyHours, 2.3, 'Mon 16th onwards: 60 + 30 + 50 minutes');
  assert.ok(!JSON.stringify(snapshot).includes('pocketlog:'), 'private card handles stay internal');
  repo.close();
});

test('a deleted journal (new epoch) replaces the mirror; a refused key is recorded', async () => {
  const repo = new Repository(':memory:');
  const now = new Date('2026-11-18T12:00:00+08:00');
  let epoch = 5;
  const journal: Stored[] = [{ id: 'old', start_ms: +now - 5 * H, end_ms: +now - 4 * H, category: 'work', app: 'x', title: 'Python', summary: '' }];
  await syncPocketlog(repo.pocketlog, config, now, fakePocketlog(journal, { epoch: () => epoch }).fetcher);
  assert.deepEqual(repo.pocketlog.activities().map((a) => a.id), ['old']);
  epoch = 6;
  journal.splice(0, 1, { id: 'new', start_ms: +now - 2 * H, end_ms: +now - H, category: 'work', app: 'x', title: 'Rust', summary: '' });
  await syncPocketlog(repo.pocketlog, config, new Date(+now + H), fakePocketlog(journal, { epoch: () => epoch }).fetcher);
  assert.deepEqual(repo.pocketlog.activities().map((a) => [a.id, a.keywords]), [['new', ['Rust']]]);

  await assert.rejects(syncPocketlog(repo.pocketlog, config, now, fakePocketlog(journal, { token: 'b'.repeat(64) }).fetcher),
    (error) => error instanceof PocketlogHttpError && error.status === 401);
  repo.close();
});

test('a full sync removes rebuilt activity IDs and updates shortened intervals', async () => {
  const repo = new Repository(':memory:');
  const now = new Date('2026-11-18T12:00:00+08:00');
  const card = { category: 'work', app: 'x', title: 'Python', summary: '' };
  const retained = { ...card, id: 'same', start_ms: +now - 4 * H, end_ms: +now - 2 * H };
  const historical = { ...card, id: 'historical', start_ms: +now - 60 * 24 * H, end_ms: +now - 60 * 24 * H + H };
  const replaced = { ...card, id: 'old', start_ms: +now - 5 * 24 * H, end_ms: +now - 5 * 24 * H + H };
  await syncPocketlog(repo.pocketlog, config, now, fakePocketlog([retained, historical, replaced]).fetcher);

  const replacement = { ...replaced, id: 'new' };
  const shortened = { ...retained, start_ms: retained.start_ms + H, end_ms: retained.end_ms - H / 2 };
  const later = new Date(+now + 24 * H + 1);
  const { fetcher } = fakePocketlog([shortened, replacement]);
  await syncPocketlog(repo.pocketlog, config, later, fetcher);
  assert.deepEqual(repo.pocketlog.activities().map((a) => [a.id, a.start, a.end]), [
    ['historical', historical.start_ms, historical.end_ms],
    ['new', replacement.start_ms, replacement.end_ms],
    ['same', shortened.start_ms, shortened.end_ms],
  ]);

  await syncPocketlog(repo.pocketlog, config, new Date(+later + H), fetcher, true);
  assert.deepEqual(repo.pocketlog.activities().map((a) => a.id), ['new', 'same']);
  repo.close();
});

test('the PocketLog platform page, JSON and listings', async () => {
  const now = new Date();
  repository.pocketlog.save({ epoch: 1, full: true, categories: [{ id: 'work', name: '工作', color: '#b9a4ed', idle: false }],
    activities: [
      { id: 'p1', start: +now - 3 * H, end: +now - 2 * H, category: 'work', keywords: ['TypeScript'] },
      { id: 'p2', start: +now - 27 * H, end: +now - 26 * H, category: 'work', keywords: ['TypeScript'] },
    ] }, now);
  const page = await app.request('/platforms/pocketlog');
  assert.equal(page.status, 200);
  const body = await page.text();
  assert.match(body, /PocketLog/);
  assert.match(body, /工作/);
  assert.match(body, /Phone time is the Android app sessions PocketLog recorded/);
  assert.doesNotMatch(body, /search\?source=pocketlog/);
  for (const section of ['Distinctive lately', 'All recent keywords', 'Categories this week', 'Recent recorded days', 'Share cards']) {
    assert.ok(body.includes(section), section);
  }
  const json = await (await app.request('/api/pocketlog.json')).json() as {
    fetchedAt: string; data: { source: string; stats: { recordedDays: number }; entries: Array<{ status: string }> };
  };
  assert.equal(json.fetchedAt, now.toISOString());
  assert.equal(json.data.source, 'pocketlog');
  assert.ok(json.data.stats.recordedDays >= 1);
  assert.equal(json.data.entries[0].status, 'daily_summary');
  for (const name of ['pocketlog', 'pocketlog-keywords', 'pocketlog-categories']) {
    assert.ok(body.includes(`/card/${name}.webp?v=`));
    const svg = await app.request(`/card/${name}.svg`);
    assert.equal(svg.status, 200);
    assert.match(await svg.text(), /<svg/);
  }
  assert.match(await (await app.request('/platforms')).text(), /href="\/platforms\/pocketlog"/);
  const home = await (await app.request('/')).text();
  assert.match(home, /h active this week/);
  assert.match(home, /data-source="pocketlog"/, 'phone time is listed by platform');
  assert.match(home, /Phone · active/);
  const coverage = repository.activityCoverage(now, { dayflow: false, health: false, pocketlog: true });
  assert.ok(coverage.some((day) => day.lanes.some((lane) => lane.source === 'pocketlog')), 'phone lanes in the rhythm');
  assert.match(await (await app.request('/sitemap.xml')).text(), /\/platforms\/pocketlog/);
  const health = await (await app.request('/healthz')).json() as { sources: Array<{ source: string }> };
  assert.ok(health.sources.some((s) => s.source === 'pocketlog'));
});
