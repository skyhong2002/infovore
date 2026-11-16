import assert from 'node:assert/strict';
import test from 'node:test';
import { repository } from '../src/index.js';
import { handleMcpRequest } from '../src/mcp.js';
import type { Activity } from '../src/data/types.js';
import {
  createWallpaperSource, findWork, normalize, parseCatalog, searchWallpapers, wallpaperGaps,
} from '../src/wallpapers.js';

const catalog = parseCatalog({
  works: [
    { id: 'persona-5', title: 'Persona 5', kind: 'game', count: 2 },
    { id: 'final-fantasy-vii', title: 'Final Fantasy VII', kind: 'game', count: 1 },
    { id: 'up', title: 'Up', kind: 'movie', count: 1 },
    { id: 'daft-punk', title: 'Daft Punk', kind: 'music', count: 1 },
    { id: 'steins-gate', title: 'Steins;Gate', kind: 'anime', count: 1 },
  ],
  wallpapers: [
    { id: 'aaa', caption: 'take your heart', device: 'phone', width: 1080, height: 1920, works: ['persona-5'], emotion: 'anger', palette: ['#d00e2d'], reviewed: true },
    { id: 'bbb', caption: 'Futaba', device: 'phone', width: 854, height: 1608, works: ['persona-5'], emotion: 'joy', palette: [], reviewed: true },
    { id: 'ccc', caption: 'cloud remake', device: 'desktop', width: 1920, height: 1080, works: ['final-fantasy-vii'], emotion: 'anger', palette: [], reviewed: false },
    { id: 'ddd', caption: 'up', device: 'desktop', width: 1920, height: 1080, works: ['up'], emotion: 'joy', palette: [], reviewed: true },
    { id: 'eee', caption: 'get lucky', device: 'desktop', width: 1920, height: 1080, works: ['daft-punk'], emotion: 'joy', palette: [], reviewed: true },
    { id: 'fff', caption: 'El Psy Congroo', device: 'desktop', width: 1920, height: 1080, works: ['steins-gate'], emotion: 'ennui', palette: [], reviewed: true },
    { id: 'ggg', caption: 'unsorted', device: 'desktop', width: 1920, height: 1080, works: [], emotion: null, palette: [], reviewed: false },
  ],
}, 'https://wall.example/');

function activity(over: Partial<Activity> & Pick<Activity, 'title' | 'mediaKind'>): Activity {
  return {
    id: over.title, dedupeKey: over.title, source: 'backloggd', sourceItemId: null, type: 'play', image: '',
    status: 'playing', occurredAt: '2026-11-10T00:00:00.000Z', occurredAtPrecision: 'day', rating: null,
    visibility: 'public', extra: {}, firstSeenAt: '2026-11-10T00:00:00.000Z', lastSeenAt: '2026-11-10T00:00:00.000Z', ...over,
  };
}

test('normalize folds case, accents and punctuation but keeps CJK', () => {
  assert.equal(normalize('Steins;Gate'), 'steins gate');
  assert.equal(normalize('  Pokémon: Red  '), 'pokemon red');
  assert.equal(normalize('魔龍的佔據!'), '魔龍的佔據');
});

test('work matching: edition suffixes match, near-misses and short titles do not', () => {
  assert.equal(findWork(catalog, 'Persona 5')?.id, 'persona-5');
  assert.equal(findWork(catalog, 'Persona 5 Royal')?.id, 'persona-5');
  assert.equal(findWork(catalog, 'persona-5')?.id, 'persona-5');
  assert.equal(findWork(catalog, 'Final Fantasy VII Rebirth')?.id, 'final-fantasy-vii');
  assert.equal(findWork(catalog, 'Final Fantasy VIII'), undefined, 'VIII must not match VII');
  assert.equal(findWork(catalog, 'Persona 50'), undefined, 'whole words only');
  assert.equal(findWork(catalog, 'Up')?.id, 'up');
  assert.equal(findWork(catalog, 'Cup of Life'), undefined, 'a short title only matches exactly');
  assert.equal(findWork(catalog, 'Super Mario Up'), undefined);
});

test('searchWallpapers filters by work, emotion, device and text, and builds image URLs', () => {
  const p5 = searchWallpapers(catalog, { work: 'Persona 5 Royal' });
  assert.equal(p5.total, 2);
  assert.deepEqual(p5.items.map((i) => i.id), ['aaa', 'bbb']);
  assert.equal(p5.items[0].thumbnailUrl, 'https://wall.example/thumbs/aaa.avif');
  assert.equal(p5.items[0].previewUrl, 'https://wall.example/view/aaa.avif');
  assert.deepEqual(p5.items[0].works, ['Persona 5']);

  assert.deepEqual(searchWallpapers(catalog, { work: 'Persona 5', emotion: 'joy' }).items.map((i) => i.id), ['bbb']);
  assert.deepEqual(searchWallpapers(catalog, { emotion: 'anger', device: 'desktop' }).items.map((i) => i.id), ['ccc']);
  assert.deepEqual(searchWallpapers(catalog, { query: 'psy' }).items.map((i) => i.id), ['fff']);
  assert.deepEqual(searchWallpapers(catalog, { query: 'steins' }).items.map((i) => i.id), ['fff'], 'matches the work title too');
  assert.equal(searchWallpapers(catalog, { work: 'Nonexistent Game' }).total, 0);
  assert.equal(searchWallpapers(catalog, { limit: 2 }).items.length, 2);
  assert.equal(searchWallpapers(catalog, { limit: 2 }).total, 7);
});

test('wallpaperGaps separates covered works from works with no wallpaper', () => {
  const gaps = wallpaperGaps(catalog, [
    activity({ title: 'Persona 5 Royal', mediaKind: 'game', occurredAt: '2026-11-12T00:00:00.000Z' }),
    activity({ title: 'Persona 5 Strikers', mediaKind: 'game', occurredAt: '2026-11-05T00:00:00.000Z' }),
    activity({ title: 'Hades', mediaKind: 'game', rating: { value: 9, scale: 10 } }),
    activity({ title: 'Frieren', mediaKind: 'anime', source: 'kitsu', occurredAt: '2026-11-14T00:00:00.000Z' }),
    activity({ title: 'Frieren', mediaKind: 'anime', source: 'kitsu', occurredAt: '2026-11-01T00:00:00.000Z' }),
    activity({ title: 'One Last Kiss', mediaKind: 'music', extra: { artist: 'Daft Punk' } }),
    activity({ title: 'Some Other Song', mediaKind: 'music', extra: { artist: 'Unknown Band' } }),
    activity({ title: 'Meeting', mediaKind: 'event' }),
    activity({ title: 'Run', mediaKind: 'fitness' }),
  ], 60, 30);

  assert.deepEqual(gaps.covered.map((c) => c.work), ['Persona 5', 'Daft Punk'], 'most recent first; music matches by artist');
  const p5 = gaps.covered.find((c) => c.work === 'Persona 5')!;
  assert.equal(p5.wallpaperCount, 2);
  assert.deepEqual(p5.activityTitles.sort(), ['Persona 5 Royal', 'Persona 5 Strikers']);
  assert.equal(p5.lastActivityAt, '2026-11-12T00:00:00.000Z');
  assert.deepEqual(p5.samples, ['https://wall.example/thumbs/aaa.avif', 'https://wall.example/thumbs/bbb.avif']);

  assert.deepEqual(gaps.gaps.map((g) => g.title), ['Frieren', 'Hades'], 'newest first, deduplicated');
  assert.equal(gaps.gaps[0].lastActivityAt, '2026-11-14T00:00:00.000Z');
  assert.deepEqual(gaps.gaps.find((g) => g.title === 'Hades')?.rating, { value: 9, scale: 10 });
  assert.ok(!gaps.gaps.some((g) => ['Some Other Song', 'Meeting', 'Run'].includes(g.title)), 'unknown music and non-media never count as gaps');
});

test('the catalog source caches, refreshes after the TTL, and falls back to stale data on failure', async () => {
  let calls = 0;
  let fail = false;
  let clock = 1_000;
  const fetchImpl = (async () => {
    calls += 1;
    if (fail) return new Response('nope', { status: 503 });
    return Response.json({ works: [], wallpapers: [{ id: `v${calls}`, caption: 'x', device: 'desktop', width: 1, height: 1, works: [] }] });
  }) as typeof fetch;
  const source = createWallpaperSource('https://wall.example/api/wallpapers.json', { ttlMs: 60_000, fetchImpl, now: () => clock });

  assert.equal((await source.get()).wallpapers[0].id, 'v1');
  clock += 30_000;
  await source.get();
  assert.equal(calls, 1, 'served from cache inside the TTL');

  clock += 60_000;
  fail = true;
  assert.equal((await source.get()).wallpapers[0].id, 'v1', 'stale copy when the refresh fails');
  assert.equal(calls, 2);

  fail = false;
  clock += 60_000;
  assert.equal((await source.get()).wallpapers[0].id, 'v3', 'recovers once the catalog is reachable again');

  const cold = createWallpaperSource('https://wall.example/api/wallpapers.json', { fetchImpl: (async () => new Response('x', { status: 500 })) as typeof fetch });
  await assert.rejects(cold.get(), /HTTP 500/);
});

test('MCP wallpaper tools answer from the catalog and hide upstream failures', async () => {
  const call = async (name: string, args: Record<string, unknown>, source: { get(): Promise<typeof catalog> }) => {
    const response = await handleMcpRequest(repository, new Request('http://localhost:3000/mcp', {
      method: 'POST', headers: { host: 'localhost:3000', 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
    }), source);
    assert.equal(response.status, 200);
    return (await response.json() as { result: { structuredContent: Record<string, any> } }).result.structuredContent;
  };
  const ok = { get: async () => catalog };

  const forWork = await call('get_wallpapers_for_work', { work: 'Persona 5 Royal' }, ok);
  assert.equal(forWork.work, 'Persona 5');
  assert.equal(forWork.total, 2);
  assert.deepEqual(forWork.emotions, { anger: 1, joy: 1 });

  const missing = await call('get_wallpapers_for_work', { work: 'Nothing Like This' }, ok);
  assert.equal(missing.total, 0);

  const searched = await call('search_wallpapers', { emotion: 'joy', device: 'desktop' }, ok);
  assert.deepEqual(searched.items.map((i: { id: string }) => i.id), ['ddd', 'eee']);

  const gaps = await call('get_wallpaper_gaps', { days: 30 }, ok);
  assert.ok(Array.isArray(gaps.covered) && Array.isArray(gaps.gaps));

  const down = await call('search_wallpapers', {}, { get: async () => { throw new Error('connect ECONNREFUSED 10.0.0.1:443 secret-internal-host'); } });
  assert.equal(down.error, 'The wallpaper collection is temporarily unavailable');
  assert.doesNotMatch(JSON.stringify(down), /ECONNREFUSED|secret-internal-host/);
});
