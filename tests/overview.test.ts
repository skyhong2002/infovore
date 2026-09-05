import test from 'node:test';
import assert from 'node:assert/strict';
import { platformOverview } from '../src/output/overview.js';
import type { SourceSnapshot } from '../src/data/types.js';

const now = new Date('2026-09-06T12:00:00+08:00');
function snapshot(source: string, stats = {}, extra: unknown = {}): SourceSnapshot<unknown> {
  return { source, stats, extra, profile: { id: 'sky', name: 'Sky', avatar: '', url: '' }, entries: [] };
}

test('overviews use source aggregates and preferences instead of latest activity', () => {
  const music = snapshot('statsfm', { weeklyMinutes: 120, weeklyUniqueArtists: 8 }, { topArtists: [{ name: 'Top artist', image: 'artist.jpg' }] });
  music.entries = [{ source: 'statsfm', kind: 'music', title: 'Latest song', image: 'song.jpg', rating: null, activityAt: now.toISOString(), extra: {} }];
  const overview = platformOverview('statsfm', '', music, now);
  assert.equal(overview.title, 'Top artist: Top artist');
  assert.equal(overview.image, 'artist.jpg');
  assert.doesNotMatch(JSON.stringify(overview), /Latest song/);
  assert.match(overview.detail, /120 min · 8 artists/);
  assert.match(platformOverview('youtube', '', snapshot('youtube', { watchEvents: 40, uniqueChannels: 4 }, { topChannels: [{ name: 'Channel' }] })).title, /Top channel: Channel/);
  assert.match(platformOverview('backloggd', '', snapshot('backloggd', { playedThisYear: 6 })).title, /6 games played this year/);
  assert.match(platformOverview('simkl', '', snapshot('simkl', { showsWatching: 2 })).title, /2 shows in progress/);
});

test('reading overview prefers current books; missing snapshots have an explicit empty state', () => {
  const books = snapshot('goodreads', { readCount: 8, currentlyReadingCount: 1, toReadCount: 4 });
  books.entries = [{ source: 'goodreads', kind: 'book', title: 'Reading now', status: 'reading', image: '', rating: null, activityAt: '', extra: {} }];
  assert.equal(platformOverview('goodreads', '', books).title, 'Reading: Reading now');
  books.entries = [];
  assert.equal(platformOverview('goodreads', '', books).title, '8 books read');
  assert.equal(platformOverview('kitsu', '', null).title, 'Waiting for sync');
});

test('sleep overview averages only recorded days in the recent week and labels partial coverage', () => {
  const health = snapshot('health', {}, { sleep: { days: [
    { day: '2026-09-05', sessionSeconds: 8 * 3600 }, { day: '2026-09-04', sessionSeconds: 6 * 3600 },
    { day: '2026-08-20', sessionSeconds: 12 * 3600 }, { day: '2026-09-07', sessionSeconds: 12 * 3600 },
  ] } });
  assert.equal(platformOverview('health', '', health, now).title, '7h average sleep');
  assert.match(platformOverview('health', '', health, now).detail, /2 recorded days/);
});
