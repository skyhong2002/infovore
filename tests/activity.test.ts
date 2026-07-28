import assert from 'node:assert/strict';
import test from 'node:test';
import { activityFromEntry, selectHomepageActivities } from '../src/data/activity.js';
import type { Activity, MediaEntry } from '../src/data/types.js';

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

function homepageActivity(
  id: string,
  kind: MediaEntry['kind'],
  occurredAt: string,
  source = kind === 'music' ? 'statsfm' : 'simkl',
): Activity {
  return activityFromEntry({
    source, sourceItemId: id, kind,
    title: id, image: 'https://example.test/image.webp', status: 'completed',
    activityAt: occurredAt, rating: null, extra: {},
  });
}

test('homepage keeps music at ten percent and one listen per Taipei day', () => {
  const activities: Activity[] = [];
  for (let index = 0; index < 50; index++) {
    activities.push(homepageActivity(`track-${index}`, 'music', `2026-07-${String(28 - Math.floor(index / 5)).padStart(2, '0')}T${String(23 - index % 5).padStart(2, '0')}:00:00+08:00`));
  }
  for (let index = 0; index < 50; index++) {
    activities.push(homepageActivity(`movie-${index}`, 'movie', `2026-06-${String(28 - Math.floor(index / 2)).padStart(2, '0')}T12:00:00+08:00`));
  }
  const selected = selectHomepageActivities(activities);
  const music = selected.filter((activity) => activity.mediaKind === 'music');
  assert.equal(selected.length, 40);
  assert.equal(music.length, 4);
  assert.equal(new Set(music.map((activity) => activity.occurredAt?.slice(0, 10))).size, 4);
});

test('homepage still shows one representative when the archive only contains music', () => {
  const music = [
    homepageActivity('latest', 'music', '2026-07-28T12:00:00+08:00'),
    homepageActivity('older', 'music', '2026-07-27T12:00:00+08:00'),
  ];
  assert.deepEqual(selectHomepageActivities(music).map((activity) => activity.title), ['latest']);
});

test('homepage gives YouTube its own budget and keeps one video per Taipei day', () => {
  const activities: Activity[] = [];
  for (let index = 0; index < 50; index++) {
    activities.push(homepageActivity(
      `movie-${index}`,
      'movie',
      `2026-06-${String(28 - Math.floor(index / 2)).padStart(2, '0')}T12:00:00+08:00`,
    ));
  }
  for (let index = 0; index < 20; index++) {
    activities.push(homepageActivity(
      `track-${index}`,
      'music',
      `2026-07-${String(28 - Math.floor(index / 2)).padStart(2, '0')}T12:00:00+08:00`,
    ));
    activities.push(homepageActivity(
      `video-${index}`,
      'video',
      `2026-07-${String(28 - Math.floor(index / 2)).padStart(2, '0')}T11:00:00+08:00`,
      'youtube',
    ));
  }
  const selected = selectHomepageActivities(activities);
  const music = selected.filter((activity) => activity.mediaKind === 'music');
  const youtube = selected.filter((activity) => activity.source === 'youtube');
  assert.equal(selected.length, 40);
  assert.equal(music.length, 4);
  assert.equal(youtube.length, 4);
  assert.equal(new Set(youtube.map((activity) => activity.occurredAt?.slice(0, 10))).size, 4);
});
