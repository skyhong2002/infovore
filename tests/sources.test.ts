import assert from 'node:assert/strict';
import test from 'node:test';
import { parseBackloggdLogFixture, parseBackloggdRecentFixture } from '../src/sources/backloggd.js';
import { parseGoodreadsRss } from '../src/sources/goodreads.js';
import { parseKitsuEntries } from '../src/sources/kitsu.js';
import { parseSimklEntries } from '../src/sources/simkl.js';
import { normalizeStatsfm } from '../src/sources/statsfm.js';
import { normalizeYoutube } from '../src/sources/youtube.js';
import { enrichPublicEvent, normalizeEvent, parseEventMetadata } from '../src/sources/events.js';


// A trimmed urtube /u/<handle>/summary.json payload; unknown keys (hourly,
// progressCoverage) must be tolerated and dropped.
function urtubeSummary(range: '28d' | 'all') {
  const lifetime = range === 'all';
  return {
    range,
    generatedAt: '2026-09-03T00:00:00.000Z',
    stats: {
      watchEvents: lifetime ? 40652 : 403, uniqueVideos: 391, uniqueChannels: 275,
      estimatedWatchSeconds: lifetime ? 17244996 : 172621, contentCoveredSeconds: 203075,
      actualWatchedSeconds: null, metadataCoverage: 1, topicCoverage: 0.99, progressCoverage: 0.98,
    },
    daily: [{ day: '2026-08-06', watches: 6, estimatedWatchSeconds: 1140 }],
    hourly: [{ hour: 0, watches: 1, estimatedWatchSeconds: 1 }],
    topChannels: [{ channelId: 'UC1', name: 'Theo - t3.gg', thumbnailUrl: 'avatar.jpg', watches: 15, estimatedWatchSeconds: 18288 }],
    topVideos: [{ videoId: 'A0x', title: 'Mirrored Top Video', url: 'https://www.youtube.com/watch?v=A0x', channelTitle: 'Channel', thumbnailUrl: 'thumb.jpg', durationSeconds: 5760, watches: 1, estimatedWatchSeconds: 5760 }],
    topics: [{ slug: 'music-performance', name: 'Music Performance', watches: 79, estimatedWatchSeconds: 25200 }],
    keywords: [{ term: 'music', videos: 87, score: 0.21 }],
  };
}

test('urtube summary fixture mirrors 28-day aggregates and the lifetime daily series', () => {
  const options = { baseUrl: 'https://urtube.test', handle: 'sky', ownerName: 'Sky' };
  const snapshot = normalizeYoutube(urtubeSummary('28d'), urtubeSummary('all'), options);
  assert.equal(snapshot.profile.url, 'https://urtube.test/sky');
  assert.deepEqual(snapshot.stats, {
    watchEvents: 403, uniqueVideos: 391, uniqueChannels: 275, estimatedHours: 48,
    lifetimeWatches: 40652, lifetimeHours: 4790,
  });
  // Mirrored videos are aggregates without a watch time: summary-only, undated.
  assert.deepEqual(snapshot.entries[0], {
    sourceItemId: 'A0x', visibility: 'summary', source: 'youtube', kind: 'video', title: 'Mirrored Top Video',
    image: 'thumb.jpg', status: 'watched', activityAt: '', rating: null,
    extra: { channel: 'Channel', url: 'https://www.youtube.com/watch?v=A0x', plays: 1, playtime: '1.6h' },
  });
  assert.equal(snapshot.extra.recent.range, '28d');
  assert.equal(snapshot.extra.lifetime.watchEvents, 40652);
  assert.equal(snapshot.extra.topChannels[0].name, 'Theo - t3.gg');
  assert.deepEqual(snapshot.extra.daily, [{ day: '2026-08-06', watches: 6, estimatedWatchSeconds: 1140 }]);
  assert.equal('hourly' in snapshot.extra, false);
  assert.equal('progressCoverage' in snapshot.extra.recent, false);
  assert.throws(() => normalizeYoutube({ error: 'not found' }, urtubeSummary('all'), options));
});

test('Backloggd profile fixture normalizes a recent game', () => {
  const entries = parseBackloggdRecentFixture(`
    <div id="profile-journal"><div><a href="/games/chrono-trigger/"><img class="card-img" alt="Chrono Trigger" src="cover.jpg"></a><span class="played-date">July 7, 2026</span></div></div>
  `);
  assert.deepEqual(entries[0], {
    sourceItemId: 'chrono-trigger', source: 'backloggd', kind: 'game', title: 'Chrono Trigger', image: 'cover.jpg',
    activityAt: '2026-07-07', rating: null, extra: { displayDate: 'Jul 7' },
  });
});

test('Backloggd log fixture pairs per-day playtimes with their month headers', () => {
  const sessions = parseBackloggdLogFixture(`
    <div class="col-12 my-auto"><p class="time-played"><i class="fa-solid fa-tv"></i> Borrowed</p></div>
    <div class="col playthrough-dates">
      <div class="row playdate-month"><div class="col"><h3>August 2026</h3></div></div>
      <div class="row playdate-view">
        <div class="col-auto my-auto number-date"><h4></h4><h4 class="date-through-line">|</h4><h4>01</h4></div>
        <div class="col time-played"><p><i class="fa-solid fa-stopwatch"></i> 0h 5m</p></div>
      </div>
      <div class="row playdate-month"><div class="col"><h3>July 2026</h3></div></div>
      <div class="row playdate-view">
        <div class="col-auto my-auto number-date"><h4>17</h4><h4 class="date-through-line">|</h4><h4>22</h4></div>
        <div class="col time-played"><p><i></i> 1h 30m</p></div>
      </div>
      <div class="row playdate-view">
        <div class="col-auto my-auto number-date"><h4></h4><h4>10</h4></div>
        <div class="col-12 note-view"></div>
      </div>
    </div>
  `);
  // The sidebar "Borrowed" label is not a session; a date range attributes
  // to its end day; a status-only row without a stopwatch time is skipped.
  assert.deepEqual(sessions, [
    { day: '2026-08-01', minutes: 5 },
    { day: '2026-07-22', minutes: 90 },
  ]);
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

test('Simkl fixture normalizes movie, TV, and anime ids', () => {
  const entries = parseSimklEntries(
    { movies: [{ last_watched_at: '2026-07-10T00:00:00Z', user_rating: 7, movie: { title: 'Movie', year: 2026, poster: 'hash', ids: { simkl: 77 } } }] },
    { shows: [{ last_watched_at: '2026-07-09T00:00:00Z', watched_episodes_count: 2, total_episodes_count: 8, show: { title: 'Show', ids: { simkl: 88 } } }] },
    { anime: [{ last_watched_at: '2026-07-11T00:00:00Z', watched_episodes_count: 1, total_episodes_count: 1, show: { title: 'Milky Subway', ids: { simkl: 99 } } }] },
  );
  assert.deepEqual(entries.map((entry) => entry.sourceItemId), ['77', '99', '88']);
  assert.equal(entries[1].kind, 'show');
  assert.equal(entries[1].title, 'Milky Subway');
  assert.equal(entries[2].extra.totalEpisodes, 8);
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
  const event = normalizeEvent({
    title: 'Concert', startAt: '2099-01-01', image: 'https://example.test/concert.webp',
    tags: ['音樂會', '音樂會'], venue: 'Hall', organizer: 'Orchestra', platform: 'KKTIX',
  });
  assert.equal(event.kind, 'event');
  assert.equal(event.status, 'upcoming');
  assert.equal(event.activityAt, '2099-01-01');
  assert.equal(event.image, 'https://example.test/concert.webp');
  assert.deepEqual(event.extra, { venue: 'Hall', organizer: 'Orchestra', platform: 'KKTIX', tags: ['音樂會'] });
  assert.throws(() => normalizeEvent({ title: 'No poster', startAt: '2099-01-01' }), /image is required/);
  await assert.rejects(() => enrichPublicEvent('https://127.0.0.1/private'), /supported public/);
});

test('event scheduled times become a duration estimate only when plausible', () => {
  const base = { title: 'Concert', image: 'https://example.test/concert.webp' };
  const timed = normalizeEvent({ ...base, startAt: '2026-08-02T19:30:00+08:00', endAt: '2026-08-02T21:45:00+08:00' });
  assert.equal(timed.extra.durationMinutes, 135);
  // Date-only starts have no meaningful span; multi-day listings are dropped.
  assert.equal(normalizeEvent({ ...base, startAt: '2026-08-02', endAt: '2026-08-03T21:00:00+08:00' }).extra.durationMinutes, undefined);
  assert.equal(normalizeEvent({ ...base, startAt: '2026-08-02T19:30:00+08:00', endAt: '2026-08-05T19:30:00+08:00' }).extra.durationMinutes, undefined);
  assert.equal(normalizeEvent({ ...base, startAt: '2026-08-02T19:30:00+08:00', endAt: '2026-08-02T19:00:00+08:00' }).extra.durationMinutes, undefined);
  assert.throws(() => normalizeEvent({ ...base, startAt: '2026-08-02T19:30:00+08:00', endAt: 'not-a-date' }), /endAt/);
});

test('public event-page fixture enriches safe schema.org metadata', () => {
  const metadata = parseEventMetadata(`<html><head><meta property="og:title" content="Festival"><meta property="og:image" content="cover.jpg"><script type="application/ld+json">{"@type":"Event","startDate":"2099-03-02T19:30:00+08:00","location":{"name":"Arts Center"},"organizer":{"name":"Orchestra"}}</script></head></html>`, 'https://kktix.com/events/festival');
  assert.equal(metadata.title, 'Festival');
  assert.equal(metadata.startAt, '2099-03-02T19:30:00+08:00');
  assert.equal(metadata.venue, 'Arts Center');
  assert.equal(metadata.platform, 'kktix.com');
});
