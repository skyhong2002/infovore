import assert from 'node:assert/strict';
import test from 'node:test';
import { narrativeKeywords, dayflowKeywords } from '../src/dayflow/keywords.js';
import { Repository } from '../src/data/database.js';
import type { DayflowBatch } from '../src/dayflow/types.js';
import { dayflowDetails, buildDayflowKeywordsCard } from '../src/output/dayflow.js';

const now = new Date('2026-09-06T00:00:00+08:00');
const batch: DayflowBatch = { schemaVersion: 1, deviceId: 'mac', day: '2026-09-05', observedAt: now.toISOString(),
  timeZone: 'Asia/Taipei', dayBoundaryHour: 4, categories: [], cards: [
    { record_id: 1, start: '2026-09-05T12:00:00+08:00', end: '2026-09-05T13:00:00+08:00', duration_minutes: 60,
      category: 'Work', title: '在Claude中除錯 infovore', summary: 'Debugging infovore with Claude. Reviewed a GitHub pull request.' },
    { record_id: 2, start: '2026-09-05T13:00:00+08:00', end: '2026-09-05T14:00:00+08:00', duration_minutes: 60,
      category: 'Work', title: 'Deploy infovore', summary: '部署 Docker' },
  ] };

test('recognizes multilingual narrative labels, merges aliases and excludes incidental private tokens', () => {
  const words = narrativeKeywords('在Claude中除錯 Next.js', 'claude CLAUDE debugging; TypeScript and typescript');
  assert.deepEqual(words.filter((w) => ['Claude', 'Debugging', 'Next.js', 'TypeScript'].includes(w)).sort(), ['Claude', 'Debugging', 'Next.js', 'TypeScript'].sort());
  assert.deepEqual(narrativeKeywords('APIary reaction cursorily', 'private-customer@example.com https://github.com/infovore /Users/sky/Claude ```Docker```'), []);
  assert.deepEqual(narrativeKeywords('UnlistedProjectX private customer meeting notes', 'secret details'), ['Meetings']);
});

test('counts each record once per keyword and excludes idle, errors, zero duration and future records', () => {
  const ignored = [
    { ...batch.cards[0], record_id: 3, category: 'Idle' },
    { ...batch.cards[0], record_id: 4, category: 'System' },
    { ...batch.cards[0], record_id: 5, end: batch.cards[0].start },
    { ...batch.cards[0], record_id: 6, start: '2026-09-06T03:00:00+08:00', end: '2026-09-06T03:30:00+08:00' },
  ];
  const result = dayflowKeywords([{ ...batch, cards: [...batch.cards, ...ignored] }, batch], now);
  assert.equal(result[0].name, 'infovore');
  assert.equal(result[0].mentions, 2);
  assert.equal(result.find((k) => k.name === 'Claude')?.mentions, 1);
});

test('snapshot, page and card expose current-week keywords and recompute after replacement', async () => {
  const repo = new Repository(':memory:');
  try {
    repo.dayflow.ingest(batch);
    repo.dayflow.ingest({ ...batch, day: '2026-08-29', cards: [{ ...batch.cards[0], record_id: 20,
      start: '2026-08-29T12:00:00+08:00', end: '2026-08-29T13:00:00+08:00', title: 'Spotify', summary: '' }] });
    const snapshot = repo.dayflow.snapshot('Sky', now);
    assert.equal(snapshot.extra.keywords?.find((k) => k.name === 'infovore')?.mentions, 2);
    assert.equal(snapshot.extra.keywords?.some((k) => k.name === 'Spotify'), false);
    assert.equal(snapshot.extra.daily[1].keywords?.[0].name, 'Spotify');
    const page = dayflowDetails(snapshot.extra);
    assert.match(page, /Keywords this week/);
    assert.match(page, /infovore · 2 activities/);
    assert.doesNotMatch(page, /Reviewed a|UnlistedProjectX|record_id/);
    const svg = await buildDayflowKeywordsCard(snapshot);
    assert.match(svg, /#FFF0E6/);
    repo.dayflow.ingest({ ...batch, observedAt: '2026-09-05T16:01:00Z', cards: [] });
    assert.deepEqual(repo.dayflow.snapshot('Sky', now).extra.keywords, []);
  } finally { repo.close(); }
});
