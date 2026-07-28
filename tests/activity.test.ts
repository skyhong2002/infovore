import assert from 'node:assert/strict';
import test from 'node:test';
import { activityFromEntry } from '../src/data/activity.js';
import type { MediaEntry } from '../src/data/types.js';

const base: MediaEntry = {
  sourceItemId: 'library-42', source: 'kitsu', kind: 'anime', title: 'Frieren', image: '',
  status: 'current', activityAt: '2026-07-11T01:02:03Z', rating: { value: 9, scale: 10 }, extra: { progress: 4 },
};

test('activity ids are deterministic and distinguish upstream progress times', () => {
  const first = activityFromEntry(base, '2026-07-11T02:00:00Z');
  const same = activityFromEntry({ ...base, title: 'Localized title' }, '2026-07-12T02:00:00Z');
  const later = activityFromEntry({ ...base, activityAt: '2026-07-12T01:02:03Z' });
  assert.equal(first.id, same.id);
  assert.notEqual(first.id, later.id);
  assert.equal(first.occurredAt, '2026-07-11T01:02:03.000Z');
  assert.equal(first.occurredAtPrecision, 'exact');
});

test('human date labels remain queryable without inventing a year', () => {
  const activity = activityFromEntry({ ...base, sourceItemId: undefined, activityAt: 'Jul 7' });
  assert.equal(activity.occurredAt, 'Jul 7');
  assert.equal(activity.occurredAtPrecision, 'label');
});

test('manual events retain one stable id across status and date edits', () => {
  const event: MediaEntry = {
    source: 'events', sourceItemId: 'my-event', kind: 'event', title: 'My event',
    image: 'https://example.test/event.webp', status: 'upcoming', activityAt: '2026-07-29',
    rating: null, extra: { tags: ['實境遊戲'] },
  };
  const upcoming = activityFromEntry(event);
  const attended = activityFromEntry({ ...event, status: 'attended', activityAt: '2026-07-29T11:00:00Z' });
  assert.equal(upcoming.id, attended.id);
  assert.equal(upcoming.occurredAtPrecision, 'day');
});
