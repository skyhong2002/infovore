import assert from 'node:assert/strict';
import test from 'node:test';
import { Repository } from '../src/data/database.js';
import { dayflowBatchSchema, dayflowDay, type DayflowBatch } from '../src/dayflow/types.js';
import { summarizeDay } from '../src/dayflow/store.js';
import { buildDayflowCard } from '../src/output/dayflow.js';
import { platformPage } from '../src/output/platforms.js';

const now = new Date('2026-09-06T00:00:00+08:00');
const batch: DayflowBatch = {
  schemaVersion: 1, deviceId: 'test-mac', day: '2026-09-05', observedAt: now.toISOString(),
  timeZone: 'Asia/Taipei', dayBoundaryHour: 4,
  categories: [{ name: 'Work', color_hex: '#abcdef', is_idle: false, is_system: false }, { name: 'Idle', color_hex: '#888888', is_idle: true, is_system: true }],
  cards: [{ record_id: 1, start: '2026-09-05T10:00:00+08:00', end: '2026-09-05T11:00:00+08:00', category: 'Work', duration_minutes: 60, title: 'SECRET TITLE', summary: 'SECRET SUMMARY', apps: ['secret.example'] }],
};

test('Dayflow respects the 4am boundary and rejects invalid batches', () => {
  assert.equal(dayflowDay(new Date('2026-09-06T03:59:59+08:00')), '2026-09-05');
  assert.equal(dayflowDay(new Date('2026-09-06T04:00:00+08:00')), '2026-09-06');
  for (const invalid of [{ ...batch, day: '2026-02-30' }, { ...batch, cards: [...batch.cards, ...batch.cards] },
    { ...batch, day: '2026-09-04' }, { ...batch, timeZone: 'UTC' },
    { ...batch, cards: [{ ...batch.cards[0], end: '2026-09-05T09:59:00+08:00' }] }]) assert.equal(dayflowBatchSchema.safeParse(invalid).success, false);
});

test('Dayflow merges overlap, separates idle/errors and clips at day boundaries', () => {
  const cards = [batch.cards[0],
    { ...batch.cards[0], record_id: 2, start: '2026-09-05T10:30:00+08:00', end: '2026-09-05T11:30:00+08:00' },
    { ...batch.cards[0], record_id: 3, category: 'Idle', start: '2026-09-05T11:00:00+08:00', end: '2026-09-05T12:00:00+08:00' },
    { ...batch.cards[0], record_id: 4, category: 'System', subcategory: 'Error', start: '2026-09-05T12:00:00+08:00', end: '2026-09-05T12:15:00+08:00' },
    { ...batch.cards[0], record_id: 5, start: '2026-09-05T03:30:00+08:00', end: '2026-09-05T04:30:00+08:00' }];
  const summary = summarizeDay(batch.day, [{ ...batch, cards }, { ...batch, deviceId: 'other-mac' }], now);
  assert.equal(summary.trackedMinutes, 150);
  assert.equal(summary.activeMinutes, 120);
  assert.equal(summary.idleMinutes, 30);
  assert.equal(summary.errorMinutes, 15);
});

test('Dayflow replacement is idempotent, rejects stale writes, and clears deleted records', async () => {
  const repo = new Repository(':memory:');
  try {
    assert.equal(repo.dayflow.ingest(batch).updated, 1);
    assert.equal(repo.dayflow.ingest(batch).updated, 0);
    assert.equal(repo.dayflow.snapshot('Sky', now).extra.daily[0].trackedMinutes, 60);
    const updated = { ...batch, observedAt: '2026-09-05T16:01:00Z', cards: [] };
    assert.equal(repo.dayflow.ingest(updated).updated, 1);
    assert.equal(repo.dayflow.ingest(batch).updated, 0);
    assert.equal(repo.dayflow.snapshot('Sky', now).extra.daily[0].trackedMinutes, 0);
    assert.equal(repo.dayflow.status().days, 1);
  } finally { repo.close(); }
});

test('Dayflow public projections contain aggregates only and do not inflate media time', async () => {
  const repo = new Repository(':memory:');
  try {
    repo.dayflow.ingest(batch);
    const snapshot = repo.dayflow.snapshot('Sky', now);
    const json = JSON.stringify(snapshot);
    const page = platformPage('Sky', { source: 'dayflow', title: 'Dayflow', description: 'Computer activity', accent: '#abcdef' }, snapshot, batch.observedAt);
    const svg = await buildDayflowCard(snapshot);
    for (const value of [json, page, svg, JSON.stringify(repo.queryActivities({})), JSON.stringify(repo.wrapped(2026))]) {
      assert.doesNotMatch(value, /SECRET|secret\.example|test-mac|record_id/);
    }
    assert.equal(repo.countPublicActivities(), 0);
    assert.equal(repo.timeSpent(now).total.allTime, 0);
    assert.equal(snapshot.stats.weeklyHours, 1);
    assert.match(page, /Categories this week/);
    assert.match(svg, /<svg/);
  } finally { repo.close(); }
});

test('Dayflow HTTP ingestion enforces its dedicated token and refreshes public cards immediately', async () => {
  const { app, repository } = await import('../src/index.js');
  const { createIngestApp } = await import('../src/ingest.js');
  const ingest = createIngestApp(repository);
  const send = (value: unknown, token = 'test-dayflow-token-with-at-least-32-characters') => ingest.request('/api/ingest/dayflow/days', {
    method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify(value),
  });
  assert.equal((await send(batch, 'test-token-with-at-least-32-characters')).status, 401);
  assert.equal((await ingest.request('/api/ingest/dayflow/status')).status, 401);
  assert.equal((await send({ ...batch, day: 'bad' })).status, 400);
  const before = await (await app.request('/card/dayflow.svg')).text();
  assert.equal((await send({ padding: 'x'.repeat(2 * 1024 * 1024) })).status, 413);
  assert.equal((await send(batch)).status, 200);
  const after = await (await app.request('/card/dayflow.svg')).text();
  assert.notEqual(before, after);
  for (const path of ['/api/dayflow.json', '/platforms/dayflow', '/', '/now', '/feed.json', '/api/activities.json']) {
    const response = await app.request(path);
    assert.equal(response.status, 200, path);
    const body = await response.text();
    assert.doesNotMatch(body, /SECRET TITLE|SECRET SUMMARY|secret\.example|test-mac/);
    if (path === '/' || path === '/now') assert.match(body, /Computer activity/);
  }
  const mcp = await app.request('/mcp', { method: 'POST', headers: { host: 'localhost:3000', 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'get_dayflow_summary', arguments: { days: 1 } } }) });
  assert.equal(mcp.status, 200);
  const mcpText = await mcp.text();
  assert.match(mcpText, /trackedMinutes/);
  assert.doesNotMatch(mcpText, /SECRET|secret\.example|test-mac|record_id/);
  const status = await (await app.request('/status')).json() as { sources: Array<{ source: string }> };
  assert.ok(status.sources.some((s: {source: string}) => s.source === 'dayflow'));
  assert.equal((await app.request('/card/dayflow.webp')).status, 200);
  assert.equal((await send({ ...batch, cards: [], observedAt: '2026-09-05T16:01:00Z' })).status, 200);
  assert.notEqual(await (await app.request('/card/dayflow.svg')).text(), after);
});
