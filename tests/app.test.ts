import assert from 'node:assert/strict';
import test from 'node:test';
import { strToU8, zipSync } from 'fflate';
import { app, repository } from '../src/index.js';
import { createIngestApp } from '../src/ingest.js';
import { setCache } from '../src/data/cache.js';
import type { SourceSnapshot } from '../src/data/types.js';
import { encryptPrivateValue } from '../src/youtube/crypto.js';
import type { YoutubeParsedArchive } from '../src/youtube/types.js';

const ingestApp = createIngestApp(repository);
const YOUTUBE_SECRET = 'test-private-data-key-with-at-least-32-characters';

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
  const status = await (await app.request('/status')).json() as { refresh: { intervalMinutes: number; nextScheduledAt: string } };
  assert.equal(status.refresh.intervalMinutes, 60);
  assert.match(status.refresh.nextScheduledAt, /^\d{4}-\d{2}-\d{2}T\d{2}:00:00\.000Z$/);
});

test('YouTube exposes projections while raw watch and search history stay private', async () => {
  const youtubeArchive: YoutubeParsedArchive = {
    archiveHash: 'app-privacy-fixture',
    source: 'takeout',
    watches: [
      {
        eventId: 'youtube-private-watch-1',
        videoId: 'public-projection-video',
        title: 'Projected Recent Video',
        url: 'https://www.youtube.com/watch?v=public-projection-video',
        channelId: 'projection-channel',
        channelTitle: 'Projection Channel',
        channelUrl: 'https://www.youtube.com/channel/projection-channel',
        watchedAt: new Date().toISOString(),
        actualWatchedSeconds: null,
        activityType: 'video',
      },
      {
        eventId: 'youtube-private-post-1',
        videoId: null,
        title: 'Private Community Post',
        url: 'https://www.youtube.com/post/private-post',
        channelId: null,
        channelTitle: null,
        channelUrl: null,
        watchedAt: new Date(Date.now() - 1_000).toISOString(),
        actualWatchedSeconds: null,
        activityType: 'post',
      },
    ],
    searches: [{
      eventId: 'youtube-private-search-1',
      searchedAt: new Date().toISOString(),
      queryCiphertext: encryptPrivateValue('never expose this search', YOUTUBE_SECRET),
      activityType: 'search',
    }],
  };
  repository.ingestYoutubeArchive(youtubeArchive);

  const timeline = await (await app.request('/api/activities.json?source=youtube')).json() as { total: number };
  assert.equal(timeline.total, 0);
  const jsonFeed = await (await app.request('/feed.json')).text();
  const rssFeed = await (await app.request('/feed.xml')).text();
  for (const body of [jsonFeed, rssFeed]) {
    assert.doesNotMatch(body, /Projected Recent Video/);
    assert.doesNotMatch(body, /Private Community Post/);
    assert.doesNotMatch(body, /never expose this search/);
  }

  const summary = await (await app.request('/api/youtube/summary.json?range=all')).json() as Record<string, unknown>;
  assert.equal('recent' in summary, false);
  assert.doesNotMatch(JSON.stringify(summary), /Projected Recent Video|never expose this search/);

  const recent = await (await app.request('/api/youtube/recent.json')).json() as {
    data: Array<Record<string, unknown>>;
  };
  assert.equal(recent.data.length, 1);
  assert.equal(recent.data[0].title, 'Projected Recent Video');
  assert.equal('eventId' in recent.data[0], false);
  assert.equal('rawTitle' in recent.data[0], false);
  assert.equal('watchedAt' in recent.data[0], false);
  assert.equal('actualWatchedSeconds' in recent.data[0], false);
  assert.doesNotMatch(JSON.stringify(recent), /Private Community Post|never expose this search/);
  const dashboardPage = await app.request('/platforms/youtube');
  const dashboardHtml = await dashboardPage.text();
  assert.match(dashboardHtml, /href="\?range=28d&sort=duration" aria-current="page"/);
  assert.match(dashboardHtml, /data-chase-range/);
  assert.match(dashboardHtml, /class="yt-keywords"/);
  assert.match(dashboardHtml, /class="yt-video-media"/);
  assert.doesNotMatch(dashboardHtml, /Unknown channel|never expose this search/);
  const health = await app.request('/healthz');
  assert.equal(health.status, 200);
  assert.match(await health.text(), /"source":"youtube","fresh":true/);

  const mcpResponse = await app.request('/mcp', {
    method: 'POST',
    headers: {
      host: 'localhost:3000',
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 91,
      method: 'tools/call',
      params: { name: 'get_recent_activities', arguments: { limit: 100, source: 'youtube' } },
    }),
  });
  assert.equal(mcpResponse.status, 200);
  const mcpBody = await mcpResponse.text();
  assert.doesNotMatch(mcpBody, /Projected Recent Video|Private Community Post|never expose this search/);
});

test('YouTube Takeout upload requires auth and accepts only ZIP payloads', async () => {
  const archive = zipSync({
    'Takeout/YouTube and YouTube Music/history/watch-history.json': strToU8(JSON.stringify([{
      header: 'YouTube',
      title: 'Watched Uploaded Video',
      titleUrl: 'https://www.youtube.com/watch?v=uploaded-video',
      time: '2026-07-27T00:00:00Z',
      activityControls: ['YouTube watch history'],
    }])),
  });
  const unauthorized = await ingestApp.request('/api/ingest/youtube/takeout', {
    method: 'POST',
    headers: { 'content-type': 'application/zip' },
    body: Buffer.from(archive),
  });
  assert.equal(unauthorized.status, 401);
  const wrongType = await ingestApp.request('/api/ingest/youtube/takeout', {
    method: 'POST',
    headers: {
      authorization: 'Bearer test-token-with-at-least-32-characters',
      'content-type': 'application/json',
    },
    body: '{}',
  });
  assert.equal(wrongType.status, 415);
  const accepted = await ingestApp.request('/api/ingest/youtube/takeout', {
    method: 'POST',
    headers: {
      authorization: 'Bearer test-token-with-at-least-32-characters',
      'content-type': 'application/zip',
    },
    body: Buffer.from(archive),
  });
  assert.equal(accepted.status, 201);
  const result = await accepted.json() as { watchesInserted: number; totals: { videoWatches: number } };
  assert.equal(result.watchesInserted, 1);
  assert.ok(result.totals.videoWatches >= 2);
});

test('YouTube Chrome capture uses a dedicated token and idempotently updates a session', async () => {
  const payload = {
    sessionId: '87654321-4321-4321-8321-cba987654321',
    videoId: 'M7lc1UVf-VE',
    title: 'YouTube API Demo',
    url: 'https://www.youtube.com/watch?v=M7lc1UVf-VE',
    channelTitle: 'Google for Developers',
    watchedAt: new Date().toISOString(),
    actualWatchedSeconds: 8,
    durationSeconds: 215,
  };
  const unauthorized = await ingestApp.request('/api/ingest/youtube/capture', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });
  assert.equal(unauthorized.status, 401);
  const broadToken = await ingestApp.request('/api/ingest/youtube/capture/status', {
    headers: { authorization: 'Bearer test-token-with-at-least-32-characters' },
  });
  assert.equal(broadToken.status, 401);
  const headers = {
    'content-type': 'application/json',
    authorization: 'Bearer test-youtube-capture-token-with-at-least-32-characters',
  };
  const status = await ingestApp.request('/api/ingest/youtube/capture/status', { headers });
  assert.equal(status.status, 200);

  const inserted = await ingestApp.request('/api/ingest/youtube/capture', {
    method: 'POST', headers, body: JSON.stringify(payload),
  });
  assert.equal(inserted.status, 201);
  assert.equal((await inserted.json() as { inserted: boolean }).inserted, true);
  const updated = await ingestApp.request('/api/ingest/youtube/capture', {
    method: 'POST', headers, body: JSON.stringify({ ...payload, actualWatchedSeconds: 38 }),
  });
  assert.equal(updated.status, 200);
  const result = await updated.json() as {
    ok: boolean;
    eventId: string;
    inserted: boolean;
    updated: boolean;
    actualWatchedSeconds: number;
  };
  assert.equal(result.ok, true);
  assert.match(result.eventId, /^[a-f0-9]{64}$/);
  assert.equal(result.inserted, false);
  assert.equal(result.updated, true);
  assert.equal(result.actualWatchedSeconds, 38);
  const timeline = await (await app.request('/api/activities.json?source=youtube')).json() as {
    total: number;
  };
  assert.equal(timeline.total, 0);
});

test('YouTube progress import is private, authenticated, bounded, and aggregate-only', async () => {
  const observedAt = new Date().toISOString();
  const payload = {
    scanId: 'api-progress-123456789',
    observedAt,
    complete: true,
    items: [{
      videoId: 'PROGRESS001',
      progressPercent: 37.5,
      resumeSeconds: 321,
      durationSeconds: 900,
    }],
  };
  const unauthorized = await ingestApp.request('/api/ingest/youtube/progress', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });
  assert.equal(unauthorized.status, 401);
  const broadToken = await ingestApp.request('/api/ingest/youtube/progress', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: 'Bearer test-token-with-at-least-32-characters',
    },
    body: JSON.stringify(payload),
  });
  assert.equal(broadToken.status, 401);
  const headers = {
    'content-type': 'application/json',
    authorization: 'Bearer test-youtube-capture-token-with-at-least-32-characters',
  };
  const oversized = await ingestApp.request('/api/ingest/youtube/progress', {
    method: 'POST',
    headers,
    body: 'x'.repeat(97 * 1024),
  });
  assert.equal(oversized.status, 413);
  const accepted = await ingestApp.request('/api/ingest/youtube/progress', {
    method: 'POST',
    headers,
    body: JSON.stringify(payload),
  });
  assert.equal(accepted.status, 200);
  const result = await accepted.json() as {
    completed: boolean;
    accepted: number;
    totalStored: number;
  };
  assert.equal(result.completed, true);
  assert.equal(result.accepted, 1);
  assert.equal(result.totalStored, 1);

  const publicBodies = [
    await (await app.request('/api/youtube/summary.json?range=all')).text(),
    await (await app.request('/api/youtube/recent.json')).text(),
    await (await app.request('/feed.json')).text(),
    await (await app.request('/feed.xml')).text(),
  ].join('\n');
  assert.doesNotMatch(publicBodies, /api-progress-123456789|resumeSeconds|PROGRESS001/);
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
