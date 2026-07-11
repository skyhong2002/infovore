import assert from 'node:assert/strict';
import test from 'node:test';
import { parseBackloggdRecentFixture } from '../src/sources/backloggd.js';
import { parseGoodreadsRss } from '../src/sources/goodreads.js';
import { parseKitsuEntries } from '../src/sources/kitsu.js';
import { parseSimklEntries } from '../src/sources/simkl.js';
import { normalizeStatsfm } from '../src/sources/statsfm.js';
import { enrichPublicEvent, normalizeEvent, parseEventMetadata } from '../src/sources/events.js';

test('Backloggd profile fixture normalizes a recent game', () => {
  const entries = parseBackloggdRecentFixture(`
    <div id="profile-journal"><div><a href="/games/chrono-trigger/"><img class="card-img" alt="Chrono Trigger" src="cover.jpg"></a><span class="played-date">July 7, 2026</span></div></div>
  `);
  assert.deepEqual(entries[0], {
    sourceItemId: 'chrono-trigger', source: 'backloggd', kind: 'game', title: 'Chrono Trigger', image: 'cover.jpg',
    activityAt: '2026-07-07', rating: null, extra: { displayDate: 'Jul 7' },
  });
});

test('Goodreads RSS fixture preserves ids, author, rating and timestamp', () => {
  const entries = parseGoodreadsRss(`<rss><channel><item>
    <book_id>123</book_id><title><![CDATA[A Book]]></title><author_name>Author</author_name>
    <book_large_image_url>cover.jpg</book_large_image_url><user_rating>4</user_rating>
    <user_read_at>Fri, 10 Jul 2026 12:00:00 +0000</user_read_at>
  </item></channel></rss>`, 5, 'read');
  assert.equal(entries[0].sourceItemId, '123');
  assert.equal(entries[0].title, 'A Book');
  assert.equal(entries[0].extra.author, 'Author');
  assert.equal(entries[0].activityAt, '2026-07-10T12:00:00.000Z');
});

test('Kitsu JSON fixture resolves included media and stable library id', () => {
  const entries = parseKitsuEntries({
    data: [{ id: 'le-1', attributes: { status: 'current', progressedAt: '2026-07-11T00:00:00Z', ratingTwenty: 18, progress: 4 }, relationships: { anime: { data: { id: 'a-1' } } } }],
    included: [{ id: 'a-1', attributes: { titles: { en: 'English title' }, canonicalTitle: 'Canonical', posterImage: { small: 'cover.jpg' } } }],
  }, 'anime');
  assert.equal(entries[0].sourceItemId, 'le-1');
  assert.equal(entries[0].title, 'English title');
  assert.deepEqual(entries[0].rating, { value: 9, scale: 10 });
});

test('Simkl fixture normalizes movie and show ids', () => {
  const entries = parseSimklEntries(
    { movies: [{ last_watched_at: '2026-07-10T00:00:00Z', user_rating: 7, movie: { title: 'Movie', year: 2026, poster: 'hash', ids: { simkl: 77 } } }] },
    { shows: [{ last_watched_at: '2026-07-09T00:00:00Z', watched_episodes_count: 2, total_episodes_count: 8, show: { title: 'Show', ids: { simkl: 88 } } }] },
  );
  assert.deepEqual(entries.map((entry) => entry.sourceItemId), ['77', '88']);
  assert.equal(entries[1].extra.totalEpisodes, 8);
});

test('stats.fm fixture keeps leaderboard data outside dated activities', () => {
  const snapshot = normalizeStatsfm(
    'sky', { item: { displayName: 'Sky', image: 'avatar.jpg' } },
    { items: { count: 12, durationMs: 120000, cardinality: { tracks: 5, artists: 3 } } },
    { items: [{ album: { name: 'Album', artists: [{ name: 'Artist' }], image: 'album.jpg' }, streams: 4 }] },
    { items: [{ artist: { name: 'Artist', image: 'artist.jpg' }, streams: 6 }] },
    { items: [{ platform: 'SPOTIFY', endTime: '2026-07-11T12:00:00Z', durationMs: 180000, track: { id: 42, name: 'Song', albums: [{ name: 'Album', image: 'album.jpg' }], artists: [{ name: 'Artist' }] } }] },
  );
  assert.equal(snapshot.entries.length, 1);
  assert.equal(snapshot.entries[0].sourceItemId, '42');
  assert.equal(snapshot.entries[0].kind, 'music');
  assert.equal(snapshot.stats.weeklyMinutes, 2);
  assert.equal(snapshot.extra.topAlbums[0].name, 'Album');
});

test('event normalization keeps only public-safe metadata and rejects arbitrary enrichment hosts', async () => {
  const event = normalizeEvent({ title: 'Concert', startAt: '2099-01-01T12:00:00Z', venue: 'Hall', organizer: 'Orchestra', platform: 'KKTIX' });
  assert.equal(event.kind, 'event');
  assert.equal(event.status, 'upcoming');
  assert.deepEqual(event.extra, { venue: 'Hall', organizer: 'Orchestra', platform: 'KKTIX' });
  await assert.rejects(() => enrichPublicEvent('https://127.0.0.1/private'), /supported public/);
});

test('public event-page fixture enriches safe schema.org metadata', () => {
  const metadata = parseEventMetadata(`<html><head><meta property="og:title" content="Festival"><meta property="og:image" content="cover.jpg"><script type="application/ld+json">{"@type":"Event","startDate":"2099-03-02T19:30:00+08:00","location":{"name":"Arts Center"},"organizer":{"name":"Orchestra"}}</script></head></html>`, 'https://kktix.com/events/festival');
  assert.equal(metadata.title, 'Festival');
  assert.equal(metadata.startAt, '2099-03-02T19:30:00+08:00');
  assert.equal(metadata.venue, 'Arts Center');
  assert.equal(metadata.platform, 'kktix.com');
});
