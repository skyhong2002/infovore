import test from 'node:test';
import assert from 'node:assert/strict';
import { selectCurrent, selectQueued, STALE_AFTER_DAYS } from '../src/data/status.js';
import type { Activity } from '../src/data/types.js';

const NOW = new Date('2026-10-04T12:00:00Z');
const daysAgo = (days: number) => new Date(NOW.getTime() - days * 86_400_000).toISOString();

function activity(overrides: Partial<Activity> & { id: string }): Activity {
  return {
    dedupeKey: overrides.id, source: 'kitsu', sourceItemId: overrides.id, type: 'anime.current', mediaKind: 'anime',
    title: overrides.id, image: '', status: 'current', occurredAt: daysAgo(1), occurredAtPrecision: 'exact',
    rating: null, visibility: 'public', extra: {}, firstSeenAt: daysAgo(1), lastSeenAt: daysAgo(1),
    ...overrides,
  };
}

test('in-progress items go stale after the window and recent Backloggd games count as playing', () => {
  const { current, paused } = selectCurrent([
    activity({ id: 'fresh', occurredAt: daysAgo(3) }),
    activity({ id: 'stale', occurredAt: daysAgo(STALE_AFTER_DAYS + 1) }),
    activity({ id: 'held', status: 'on_hold', occurredAt: daysAgo(2) }),
    activity({ id: 'game-recent', source: 'backloggd', mediaKind: 'game', status: null, occurredAt: daysAgo(5) }),
    activity({ id: 'game-old', source: 'backloggd', mediaKind: 'game', status: null, occurredAt: daysAgo(40) }),
    activity({ id: 'watching', source: 'simkl', mediaKind: 'show', status: 'watching', occurredAt: daysAgo(10) }),
    activity({ id: 'queued', source: 'simkl', mediaKind: 'show', status: 'plantowatch', occurredAt: daysAgo(1) }),
    activity({ id: 'private', visibility: 'private', occurredAt: daysAgo(1) }),
  ], NOW);
  assert.deepEqual(current.map((item) => item.id), ['fresh', 'game-recent', 'watching']);
  assert.deepEqual(paused.map((item) => item.id), ['held', 'stale']);
});

test('the queue takes only queued statuses, newest first, capped per platform', () => {
  const queued = selectQueued([
    ...Array.from({ length: 8 }, (_, index) => activity({ id: `simkl-${index}`, source: 'simkl', status: 'plantowatch', occurredAt: daysAgo(index) })),
    activity({ id: 'book', source: 'goodreads', mediaKind: 'book', status: 'to-read', occurredAt: daysAgo(2) }),
    activity({ id: 'planned', status: 'planned', occurredAt: daysAgo(30) }),
    activity({ id: 'current', status: 'current' }),
  ], 12, 6);
  assert.equal(queued.filter((item) => item.source === 'simkl').length, 6);
  assert.ok(queued.some((item) => item.id === 'book'));
  assert.ok(queued.some((item) => item.id === 'planned'));
  assert.ok(!queued.some((item) => item.id === 'current'));
  assert.equal(queued[0].id, 'simkl-0');
});
