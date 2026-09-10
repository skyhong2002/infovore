import test from 'node:test';
import assert from 'node:assert/strict';
import { app, repository } from '../src/index.js';
import { buildNowCard } from '../src/output/now.js';
import { rasterize } from '../src/output/render.js';
import type { Activity } from '../src/data/types.js';

function activity(overrides: Partial<Activity>): Activity {
  return { id: 'id', dedupeKey: 'key', source: 'goodreads', sourceItemId: null, type: 'book.reading', mediaKind: 'book',
    title: 'Title', image: '', status: 'reading', occurredAt: '2026-09-01T00:00:00Z', occurredAtPrecision: 'exact', rating: null,
    visibility: 'public', extra: {}, firstSeenAt: '2026-09-01T00:00:00Z', lastSeenAt: '2026-09-01T00:00:00Z', ...overrides };
}

test('now card renders in-progress media, upcoming events, latest activity and empty states', async () => {
  const svg = await buildNowCard('Sky', {
    current: [activity({ id: 'a', title: 'A Reading Book', extra: { author: 'Some Author' } })],
    upcoming: [activity({ id: 'b', source: 'events', mediaKind: 'event', type: 'event.upcoming', status: 'upcoming', title: 'Harmonica Night',
      occurredAt: '2026-12-24T11:30:00Z', extra: { venue: 'Taipei Zhongshan Hall' } })],
    recent: [activity({ id: 'c', source: 'statsfm', mediaKind: 'music', type: 'music.listened', status: 'listened', title: '好きでいて', extra: { artist: 'Ado' } })],
    updated: 'Sep 11, 04:00 GMT+8',
  });
  // Satori outlines text into glyph paths, so assert on geometry rather than strings.
  assert.match(svg, /width="520"/);
  assert.match(svg, /#f59b45/); // the "up next" event marker
  const png = await rasterize(svg, 'png', 1);
  assert.equal(png.readUInt32BE(16), 520);
  assert.ok(png.readUInt32BE(20) < 1000);
  const empty = await buildNowCard('Sky', { current: [], upcoming: [], recent: [], updated: null });
  assert.match(empty, /<svg/);
  assert.doesNotMatch(empty, /#f59b45/);
  const height = (source: string) => Number(/height="(\d+)"/.exec(source)![1]);
  assert.ok(height(svg) > height(empty), 'populated card is taller than the empty state');
});

test('now card route serves every format, revalidates by ETag and picks up newly synced media', async () => {
  const before = await app.request('/card/now.svg');
  assert.equal(before.status, 200);
  const etag = before.headers.get('etag')!;
  assert.equal((await app.request('/card/now.svg', { headers: { 'if-none-match': etag } })).status, 304);
  repository.finishSync(repository.startSync('goodreads'), {
    source: 'goodreads', profile: { id: 'sky', name: 'Sky', avatar: '', url: '' }, stats: {}, extra: {},
    entries: [{ source: 'goodreads', sourceItemId: 'now-card-book', kind: 'book', title: 'NOW CARD READING TEST', image: '', rating: null,
      status: 'reading', activityAt: '2026-09-01T00:00:00Z', extra: { author: 'Fixture Author' } }],
  });
  const after = await app.request('/card/now.svg');
  assert.equal(after.status, 200);
  assert.notEqual(after.headers.get('etag'), etag);
  assert.ok((await after.text()).length > (await (await app.request('/card/now.svg')).text()).length - 1);
  for (const format of ['png', 'webp']) {
    const response = await app.request(`/card/now.${format}?scale=1`);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('content-type'), `image/${format}`);
  }
  assert.match(await (await app.request('/cards')).text(), /now\.webp/);
});
