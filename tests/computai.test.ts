import assert from 'node:assert/strict';
import test from 'node:test';
import { Repository } from '../src/data/database.js';
import { computaiReportSchema, computaiSegmentsSchema, type ComputaiReport, type ComputaiSegments } from '../src/computai/types.js';
import { buildAiAgentsCard, buildAiAgentsLightCard } from '../src/output/computai.js';

const report: ComputaiReport = {
  schemaVersion: 1, deviceId: 'secret-mac', observedAt: '2026-10-04T08:00:00Z', period: '30d',
  tokens: 6_996_205_815, agentHours: 205.1, peakParallel: 6, cacheHitPct: 96,
  fleet: [{ source: 'codex', pct: 68 }, { source: 'claude', pct: 32 }],
  models: [{ model: 'gpt-6-astra', sharePct: 49 }, { model: 'claude-opus-5-5', sharePct: 23 }, { model: 'gpt-5.6-sol', sharePct: 10 }],
  daily: Array.from({ length: 30 }, (_, i) => (i + 1) * 1e7),
};

test('ComputAI reports keep aggregates only and reject malformed input', () => {
  const parsed = computaiReportSchema.parse({ ...report, api_equivalent_usd: 6880, value_ratio: 11.5, cacheSavingsUsd: 44837 });
  assert.doesNotMatch(JSON.stringify(parsed), /usd|value_ratio|6880/i);
  for (const invalid of [{ ...report, period: '7d' }, { ...report, cacheHitPct: 140 }, { ...report, daily: [] },
    { ...report, observedAt: new Date(Date.now() + 3_600_000).toISOString() }, { ...report, deviceId: 'has space' }]) {
    assert.equal(computaiReportSchema.safeParse(invalid).success, false);
  }
});

test('ComputAI keeps the newest report and its public snapshot drops the device', async () => {
  const repo = new Repository(':memory:');
  try {
    assert.equal(repo.computai.ingest(report).updated, 1);
    assert.equal(repo.computai.ingest(report).updated, 0);
    assert.equal(repo.computai.ingest({ ...report, observedAt: '2026-10-03T08:00:00Z', tokens: 1 }).updated, 0);
    assert.equal(repo.computai.ingest({ ...report, observedAt: '2026-10-04T09:00:00Z', tokens: 7e9 }).updated, 1);
    const snapshot = repo.computai.snapshot('Sky');
    assert.equal(snapshot.extra.report?.tokens, 7e9);
    assert.equal(snapshot.stats.sessionsAtOnce, 6);
    // 09:00Z is 17:00 in Taipei: the last daily value is Oct 4, newest entry first.
    assert.deepEqual(snapshot.entries.slice(0, 2).map((e) => [e.sourceItemId, e.title, e.kind]),
      [['day:2026-10-04', 'AI agents · 300.0M tokens', 'ai'], ['day:2026-10-03', 'AI agents · 290.0M tokens', 'ai']]);
    assert.equal(repo.computai.snapshot('Sky').entries.length, 14);
    // 16:30Z is already the next day in Taipei.
    const late = new Repository(':memory:');
    late.computai.ingest({ ...report, observedAt: '2026-10-01T16:30:00Z' });
    assert.equal(late.computai.snapshot('Sky').entries[0].sourceItemId, 'day:2026-10-02');
    late.close();
    const dark = await buildAiAgentsCard(snapshot), light = await buildAiAgentsLightCard(snapshot);
    for (const value of [JSON.stringify(snapshot), dark, light]) assert.doesNotMatch(value, /secret-mac/);
    assert.match(dark, /<svg/);
    assert.notEqual(dark, light);
    assert.equal(repo.countPublicActivities(), 0);
  } finally { repo.close(); }
});

test('ComputAI ingestion enforces its token and refreshes the public cards', async () => {
  const { app, repository } = await import('../src/index.js');
  const { createIngestApp } = await import('../src/ingest.js');
  const ingest = createIngestApp(repository);
  const send = (value: unknown, token = 'test-computai-token-with-at-least-32-characters') => ingest.request('/api/ingest/computai/reports', {
    method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify(value),
  });
  assert.equal((await send(report, 'test-dayflow-token-with-at-least-32-characters')).status, 401);
  assert.equal((await ingest.request('/api/ingest/computai/status')).status, 401);
  assert.equal((await send({ ...report, tokens: -1 })).status, 400);
  assert.equal((await send({ padding: 'x'.repeat(128 * 1024) })).status, 413);
  const before = await (await app.request('/card/ai-agents.svg')).text();
  const live = { ...report, observedAt: new Date().toISOString() };
  assert.equal((await send(live)).status, 200);
  const after = await (await app.request('/card/ai-agents.svg')).text();
  assert.notEqual(before, after);
  assert.equal((await app.request('/card/ai-agents-light.webp')).status, 200);
  const gallery = await (await app.request('/cards')).text();
  assert.ok(gallery.includes('/card/ai-agents.webp') && gallery.includes('/card/ai-agents-light.webp'));
  const status = await (await app.request('/status')).json() as { sources: Array<{ source: string }>; cards: string[] };
  assert.ok(status.sources.some((s) => s.source === 'computai'));
  assert.ok(status.cards.includes('/card/ai-agents.svg'));
  for (const path of ['/platforms/computai', '/platforms', '/', '/now', '/feed.json']) {
    const response = await app.request(path);
    assert.equal(response.status, 200, path);
    const body = await response.text();
    assert.doesNotMatch(body, /secret-mac/, path);
    if (path === '/platforms/computai') assert.match(body, /gpt-6-astra · 49%/);
    if (path === '/') assert.match(body, /AI agents · [\d.]+[MB] tokens/);
  }
  const postSegments = (value: unknown, token = 'test-computai-token-with-at-least-32-characters') => ingest.request('/api/ingest/computai/segments', {
    method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify(value),
  });
  const start = new Date(Date.now() - 3 * 3_600_000);
  const liveSegments = { ...segments, observedAt: new Date().toISOString(), from: new Date(+start - 3_600_000).toISOString(), to: new Date().toISOString(),
    segments: [seg(start.toISOString(), 45), seg(new Date(+start + 30 * 60_000).toISOString(), 30, { source: 'claude', project: 'beta', session: 'bbbbbbbbbbbb' })] };
  assert.equal((await postSegments(liveSegments, 'test-dayflow-token-with-at-least-32-characters')).status, 401);
  assert.equal((await postSegments(liveSegments)).status, 200);
  const home = await (await app.request('/')).text();
  assert.match(home, /AI agents · 1h 0m/);
  assert.match(home, /2 sessions · Codex, Claude Code · alpha, beta/);
  assert.match(home, /AI agents · working/);
  assert.doesNotMatch(home, /secret-mac/);
  const nowCard = await (await app.request('/card/now.svg')).text();
  assert.doesNotMatch(nowCard, /AI agents ·/);
  const json = await (await app.request('/api/computai.json')).text();
  assert.match(json, /gpt-6-astra/);
  assert.doesNotMatch(json, /secret-mac/);
});

const seg = (start: string, minutes: number, extra: Partial<ComputaiSegments['segments'][number]> = {}) => ({
  source: 'codex', machine: 'mbp', project: 'alpha', session: 'aaaaaaaaaaaa', subagent: false,
  start, end: new Date(Date.parse(start) + minutes * 60_000).toISOString(), tokens: 1000, requests: 3, ...extra,
});
const segments: ComputaiSegments = {
  schemaVersion: 1, deviceId: 'secret-mac', observedAt: '2026-10-04T06:00:00Z', from: '2026-10-03T16:00:00Z', to: '2026-10-04T16:00:00Z',
  segments: [
    seg('2026-10-04T01:00:00Z', 30), seg('2026-10-04T01:10:00Z', 40, { source: 'claude', project: 'beta', session: 'bbbbbbbbbbbb' }),
    seg('2026-10-04T02:00:00Z', 20),                         // 10 minutes after the last one ends: same block
    seg('2026-10-04T05:00:00Z', 15, { machine: 'mini', session: '' }),  // a separate block
  ],
};

test('ComputAI segments replace their window and merge into work blocks', () => {
  const repo = new Repository(':memory:');
  try {
    assert.equal(computaiSegmentsSchema.safeParse({ ...segments, segments: [seg('2026-10-02T00:00:00Z', 5)] }).success, false);
    assert.deepEqual(repo.computai.ingestSegments(segments), { removed: 0, stored: 4 });
    assert.deepEqual(repo.computai.ingestSegments(segments), { removed: 4, stored: 4 });
    const blocks = repo.computai.workBlocks('2026-10-03T00:00:00Z');
    assert.deepEqual(blocks.map((b) => [b.start, b.end, b.activeSeconds, b.sessions]), [
      ['2026-10-04T05:00:00.000Z', '2026-10-04T05:15:00.000Z', 900, 1],
      ['2026-10-04T01:00:00.000Z', '2026-10-04T02:20:00.000Z', 70 * 60, 2],
    ]);
    assert.deepEqual([blocks[1].sources, blocks[1].projects], [['codex', 'claude'], ['alpha', 'beta']]);
    const now = new Date('2026-10-04T12:00:00Z');
    const coverage = repo.activityCoverage(now, { dayflow: false, health: false, computai: true }, 1);
    assert.equal(coverage[0].recordedSeconds, 85 * 60);
    assert.ok(coverage[0].lanes.some((lane) => lane.source === 'computai'));
    assert.equal(repo.computai.agentTime(now).day, 85 * 60);
    const snapshot = repo.computai.snapshot('Sky', now);
    assert.deepEqual(snapshot.entries.map((e) => e.title), ['AI agents · 15m', 'AI agents · 1h 10m']);
    assert.doesNotMatch(JSON.stringify(snapshot), /secret-mac/);
    repo.computai.ingestSegments({ ...segments, observedAt: '2026-10-04T07:00:00Z', segments: [] });
    assert.equal(repo.computai.workBlocks('2026-10-03T00:00:00Z').length, 0);
  } finally { repo.close(); }
});
