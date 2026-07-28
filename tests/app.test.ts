import assert from 'node:assert/strict';
import test from 'node:test';
import { app, repository } from '../src/index.js';
import { createIngestApp } from '../src/ingest.js';
import { setCache } from '../src/data/cache.js';
import type { SourceSnapshot } from '../src/data/types.js';

const ingestApp = createIngestApp(repository);

test('event ingestion requires auth and never exposes private events', async () => {
  const unauthorized = await ingestApp.request('/api/ingest/events', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
  assert.equal(unauthorized.status, 401);

  const ingest = async (body: Record<string, unknown>) => ingestApp.request('/api/ingest/events', {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer test-token-with-at-least-32-characters' }, body: JSON.stringify(body),
  });
  const publicResponse = await ingest({
    id: 'public-event', title: 'Future Concert', startAt: '2099-08-01T12:00:00Z',
    image: 'https://example.test/concert.webp', tags: ['音樂會'],
    venue: 'Public Hall', url: 'https://example.test/events/concert', status: 'upcoming',
  });
  assert.equal(publicResponse.status, 201);
  const privateResponse = await ingest({
    id: 'private-event', title: 'Private Ticket', startAt: '2099-09-01T12:00:00Z',
    image: 'https://example.test/private.webp', visibility: 'private',
  });
  assert.equal(privateResponse.status, 201);

  const timeline = await (await app.request('/api/activities.json?kind=event&limit=1&offset=0')).json() as { total: number; data: Array<{ title: string }> };
  assert.equal(timeline.total, 1);
  assert.equal(timeline.data[0].title, 'Future Concert');
  assert.deepEqual((timeline as any).data[0].extra.tags, ['音樂會']);
  const feed = await (await app.request('/feed.xml')).text();
  assert.match(feed, /Future Concert/);
  assert.doesNotMatch(feed, /Private Ticket/);
});

test('profile, now and Wrapped pages render from durable activities', async () => {
  repository.ingestEntries([{
    source: 'kitsu', sourceItemId: 'home-entry', kind: 'anime', title: 'Homepage Anime',
    image: 'https://example.test/home.jpg', status: 'current',
    activityAt: '2026-07-01T12:00:00Z', rating: { value: 9, scale: 10 }, extra: { progress: 12 },
  }], '2026-07-01T13:00:00Z');
  const home = await app.request('/');
  assert.equal(home.status, 200);
  const homeHtml = await home.text();
  assert.match(homeHtml, /More recent highlights/);
  assert.match(homeHtml, /Homepage Anime/);
  assert.match(homeHtml, /Kitsu/);
  assert.match(homeHtml, /href="\/platforms\/kitsu"/);
  assert.match(homeHtml, /Balanced timeline/);
  assert.match(homeHtml, /highlights from/);
  assert.match(homeHtml, /Personal infoboard/);
  assert.match(homeHtml, /The useful things first/);
  assert.match(homeHtml, /Up next/);
  assert.match(homeHtml, /In progress/);
  assert.match(homeHtml, /Future Concert/);
  assert.match(homeHtml, /Latest signal from each platform/);
  assert.doesNotMatch(homeHtml, /One timeline for everything worth remembering/);
  assert.match(homeHtml, /href="\/" aria-current="page">Home/);
  assert.match(homeHtml, /property="og:image" content="http:\/\/localhost:3000\/og\.png"/);
  assert.doesNotMatch(homeHtml, /src="\/card\//);
  const og = await app.request('/og.png');
  assert.equal(og.status, 200);
  assert.equal(og.headers.get('content-type'), 'image/png');
  const cards = await app.request('/cards');
  assert.equal(cards.status, 200);
  const cardsHtml = await cards.text();
  assert.match(cardsHtml, /Shareable view/);
  assert.match(cardsHtml, /href="\/cards" aria-current="page">Cards/);
  assert.match(cardsHtml, /\.card-gallery-row\{align-items:flex-start;display:flex;flex-wrap:wrap;gap:16px\}/);
  assert.match(cardsHtml, /\.card-gallery-row img\{display:block;height:auto;max-width:100%;width:520px\}/);
  const profile = await app.request('/profile');
  assert.equal(profile.status, 200);
  assert.match(await profile.text(), /The archive/);
  const now = await app.request('/now');
  const nowHtml = await now.text();
  assert.match(nowHtml, /Future Concert/);
  assert.match(nowHtml, /href="\/now" aria-current="page">Now/);
  const wrappedJson = await (await app.request('/api/wrapped/2099.json')).json() as { totalActivities: number };
  assert.equal(wrappedJson.totalActivities, 1);
  const wrapped = await app.request('/wrapped/2099');
  const wrappedHtml = await wrapped.text();
  assert.match(wrappedHtml, /2099 Wrapped/);
  assert.match(wrappedHtml, /Archive · annual view/);
  assert.match(wrappedHtml, /href="\/profile" aria-current="page">Archive/);
});

test('platform index and dedicated mirrors render source-native content', async () => {
  const statsfm: SourceSnapshot<{
    topAlbums: Array<{ name: string; artist: string; image: string; streams: number }>;
    topArtists: Array<{ name: string; image: string; streams: number }>;
  }> = {
    source: 'statsfm',
    profile: { id: 'sky', name: 'Sky', avatar: 'https://example.test/avatar.jpg', url: 'https://stats.fm/sky' },
    stats: { weeklyStreams: 42, weeklyMinutes: 180 },
    entries: [{
      source: 'statsfm', sourceItemId: 'track', kind: 'music', title: 'Mirror Song',
      image: 'https://example.test/song.jpg', status: 'listened',
      activityAt: '2026-07-28T12:00:00Z', rating: null, extra: { artist: 'Mirror Artist', album: 'Mirror Album' },
    }],
    extra: {
      topAlbums: [{ name: 'Mirror Album', artist: 'Mirror Artist', image: 'https://example.test/album.jpg', streams: 12 }],
      topArtists: [{ name: 'Mirror Artist', image: 'https://example.test/artist.jpg', streams: 20 }],
    },
  };
  setCache('data:statsfm', statsfm);

  const index = await app.request('/platforms');
  const indexHtml = await index.text();
  assert.equal(index.status, 200);
  assert.match(indexHtml, /Platform mirror/);
  assert.match(indexHtml, /href="\/platforms\/statsfm"/);
  assert.match(indexHtml, /Manual events/);
  assert.match(indexHtml, /href="\/platforms" aria-current="page">Platforms/);
  assert.match(indexHtml, /href="\/">Home/);

  const mirror = await app.request('/platforms/statsfm');
  const mirrorHtml = await mirror.text();
  assert.equal(mirror.status, 200);
  assert.match(mirrorHtml, /Mirror Song/);
  assert.match(mirrorHtml, /Mirror Album/);
  assert.match(mirrorHtml, /Top albums this week/);
  assert.match(mirrorHtml, /weekly streams/);
  assert.match(mirrorHtml, /<h2>Cards<\/h2>/);
  assert.match(mirrorHtml, /src="\/card\/statsfm\.webp\?v=/);
  assert.match(mirrorHtml, /src="\/card\/statsfm-albums\.webp\?v=/);
  assert.match(mirrorHtml, /src="\/card\/statsfm-artists\.webp\?v=/);
  assert.match(mirrorHtml, /\.platform-card-grid a\{border-radius:10px;display:block;flex:0 1 520px/);
  assert.match(mirrorHtml, /\.platform-card-grid img\{display:block;height:auto;max-width:100%;width:520px\}/);

  const manual = await app.request('/platforms/events');
  assert.equal(manual.status, 200);
  assert.match(await manual.text(), /Future Concert/);
  assert.equal((await app.request('/platforms/unknown')).status, 404);
});

test('MCP Streamable HTTP exposes the managed lifelog tools', async () => {
  const call = async (body: Record<string, unknown>) => {
    const response = await app.request('/mcp', {
      method: 'POST', headers: { host: 'localhost:3000', 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      body: JSON.stringify(body),
    });
    assert.equal(response.status, 200);
    return response.json() as Promise<{ result: Record<string, any> }>;
  };
  const initialized = await call({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } } });
  assert.equal(initialized.result.serverInfo.name, 'infovore');
  const listed = await call({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
  assert.deepEqual(listed.result.tools.map((tool: { name: string }) => tool.name), [
    'get_recent_activities', 'search_lifelog', 'get_current_media', 'get_upcoming_events', 'get_annual_summary',
  ]);
  const summary = await call({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'get_annual_summary', arguments: { year: 2099 } } });
  assert.equal(summary.result.structuredContent.totalActivities, 1);
  const badHost = await app.request('http://evil.test/mcp', { method: 'POST', headers: { host: 'evil.test' } });
  assert.equal(badHost.status, 421);
});

test.after(() => repository.close());
