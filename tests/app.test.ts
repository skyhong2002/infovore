import assert from 'node:assert/strict';
import test from 'node:test';
import { app, repository } from '../src/index.js';
import { createIngestApp } from '../src/ingest.js';

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
    image: 'https://example.test/home.jpg', status: 'completed',
    activityAt: '2026-07-01T12:00:00Z', rating: { value: 9, scale: 10 }, extra: { progress: 12 },
  }], '2026-07-01T13:00:00Z');
  const home = await app.request('/');
  assert.equal(home.status, 200);
  const homeHtml = await home.text();
  assert.match(homeHtml, /Recent activity/);
  assert.match(homeHtml, /Homepage Anime/);
  assert.match(homeHtml, /Kitsu/);
  assert.match(homeHtml, /balanced view/);
  assert.match(homeHtml, /highlights from/);
  assert.doesNotMatch(homeHtml, /src="\/card\//);
  const cards = await app.request('/cards');
  assert.equal(cards.status, 200);
  assert.match(await cards.text(), /infovore cards/);
  const profile = await app.request('/profile');
  assert.equal(profile.status, 200);
  assert.match(await profile.text(), /Activity archive/);
  const now = await app.request('/now');
  assert.match(await now.text(), /Future Concert/);
  const wrappedJson = await (await app.request('/api/wrapped/2099.json')).json() as { totalActivities: number };
  assert.equal(wrappedJson.totalActivities, 1);
  const wrapped = await app.request('/wrapped/2099');
  assert.match(await wrapped.text(), /2099 Wrapped/);
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
