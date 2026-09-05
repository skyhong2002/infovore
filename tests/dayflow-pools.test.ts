import assert from 'node:assert/strict';
import test from 'node:test';
import { keywordPools } from '../src/dayflow/pools.js';
import type { DayflowBatch } from '../src/dayflow/types.js';

const now = new Date('2026-09-06T00:00:00+08:00');
const make = (day: string, titles: string[], startId = 0): DayflowBatch => ({
  schemaVersion: 1, day, deviceId: 'mac', observedAt: now.toISOString(), timeZone: 'Asia/Taipei', dayBoundaryHour: 4, categories: [],
  cards: titles.map((title, i) => ({ record_id: startId + i, title, summary: '', category: 'Work', duration_minutes: 30,
    start: day + 'T12:00:00+08:00', end: day + 'T12:30:00+08:00' })),
});
const history = Array.from({ length: 30 }, (_, i) => make(new Date(Date.parse('2026-08-01') + i * 86400000).toISOString().slice(0, 10), ['Discord YouTube', 'Discord YouTube'], i * 10));

test('keeps habitual terms in all pool and surfaces novel narrative topics independently', () => {
  const recent = [make('2026-09-03', ['Discord YouTube ceramic glazing', 'Discord YouTube ceramic glazing'], 1000),
    make('2026-09-04', ['Discord YouTube ceramic glazing', 'Discord YouTube'], 1010)];
  const pools = keywordPools([...history, ...recent], now);
  assert.equal(pools.status, 'ready');
  assert.ok(pools.all.some((k) => k.name === 'Discord'));
  assert.ok(pools.all.some((k) => k.name === 'YouTube'));
  assert.ok(pools.distinctive.some((k) => k.name === 'ceramic glazing' && k.historicalMentions === 0));
  assert.ok(!pools.distinctive.some((k) => ['Discord', 'YouTube'].includes(k.name)));
  assert.deepEqual(keywordPools([...history, ...recent, ...recent], now), pools);
});

test('does not confuse missing history, one-off terms or routine rates with novelty', () => {
  assert.equal(keywordPools([make('2026-09-05', ['Discord ceramic glazing', 'ceramic glazing'])], now).status, 'insufficient_history');
  assert.deepEqual(keywordPools([], now).distinctive, []);
  const pools = keywordPools([...history, make('2026-09-05', ['Discord YouTube oneoffproject', 'Discord YouTube'], 1000)], now);
  assert.deepEqual(pools.distinctive, []);
  assert.ok(!pools.all.some((k) => k.name.includes('oneoffproject')));
});

test('uses rolling 7 Dayflow days, excludes future data and redacts private identifiers', () => {
  const pools = keywordPools([...history,
    make('2026-09-05', ['SECRET TITLE /Users/sky/HiddenProject https://private.example/HiddenProject person@company.com', 'SECRET TITLE /Users/sky/HiddenProject'], 1000),
    make('2026-09-06', ['futureproject', 'futureproject'], 2000)], now);
  assert.equal(pools.recentFrom, '2026-08-30');
  assert.equal(pools.baselineTo, '2026-08-29');
  assert.doesNotMatch(JSON.stringify(pools), /HiddenProject|SECRET|futureproject|person|company/);
});

test('normalizes activity counts so larger recent batches alone do not imply novelty', () => {
  const base = Array.from({ length: 20 }, (_, i) => make(new Date(Date.parse('2026-08-01') + i * 86400000).toISOString().slice(0, 10),
    i < 4 ? ['Obsidian', 'Discord', 'Discord', 'Discord'] : ['Discord', 'Discord', 'Discord', 'Discord'], i * 10));
  const recent = make('2026-09-05', Array.from({length: 40}, (_, i) => i < 2 ? 'Obsidian' : 'Discord'), 1000);
  assert.ok(!keywordPools([...base, recent], now).distinctive.some((k) => k.name === 'Obsidian'));
});
