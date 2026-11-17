import assert from 'node:assert/strict';
import test from 'node:test';
import * as cheerio from 'cheerio';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Repository } from '../src/data/database.js';
import { importArchive, readArchive, syncBackloggdLibrary, writeArchive } from '../src/backloggd/sync.js';
import { backloggdLibrarySection } from '../src/output/backloggd-library.js';
import {
  archiveToImport, crawlBackloggd, nextPageHref, parseGameGrid, parseJournalPage, parseListGames,
  parseListsIndex, parseLogPage, parseProfileStats, parseReviews,
} from '../src/sources/backloggd-archive.js';

const card = (slug: string, id: string, title: string, width: number, extra = '') => `
  <div class="col col-cus-user-games px-1 mt-2">
    <div class="card mx-auto game-cover quick-access ${extra}" game_id="${id}">
      <a href="/games/${slug}/" class="cover-link"></a>
      <div class="overflow-wrapper"><img class="card-img height" src="https://img/${slug}.jpg" alt="${title}"></div>
    </div>
    <div class="row game-card-meta">
      <div class="stars-top" style="width:${width}%;"></div>
      ${width > 0 ? `<a class="game-reviewed" href="/u/sky/logs/${slug}/reviews/"></a>` : ''}
    </div>
  </div>`;

const grid = (cards: string, next?: string) => cheerio.load(`
  <div id="user_games">${cards}</div>
  <nav class="pagy nav">${next ? `<a href="${next}" aria-label="Next">Next</a>` : '<a aria-disabled="true" aria-label="Next">Next</a>'}</nav>`);

const logHtml = `
  <div class="section-title"><p>Log Status</p></div><div><div class="col-3 current"><p>Completed</p></div></div>
  <div class="section-title"><p>Rating</p></div><div><div class="stars-top" style="width:90%"></div></div>
  <div class="section-title"><p>Time Played</p></div><div><p>2h 30m</p></div>
  <div class="section-title"><p>Days in Journal</p></div><div><p>2 days</p></div>
  <div class="section-title"><p>Last played</p></div><div><p>October 22, 2026</p></div>
  <div class="section-title"><p>First played</p></div><div><p>February 25, 2026</p></div>
  <div class="section-title"><p>Platforms Played</p></div><div><a class="game-page-platform">Windows PC via Mac</a><a class="game-page-platform">Switch</a></div>
  <div class="playthrough-dates">
    <div class="playdate-month"><h3>October 2026</h3></div>
    <div class="playdate-view"><div class="number-date"><h4>22</h4></div><div class="time-played"><p>2h 0m</p></div><p class="subtitle-text">Finished</p></div>
    <div class="playdate-view"><div class="number-date"><h4>21</h4></div><div class="time-played"><p>0h 30m</p></div></div>
    <div class="playdate-month"><h3>February 2026</h3></div>
    <div class="playdate-view"><div class="number-date"><h4>25</h4></div></div>
  </div>`;

test('profile stats and game grids parse covers, ratings, adult flags and pagination', () => {
  assert.deepEqual(
    parseProfileStats(cheerio.load('<div><h1>549</h1><h4>Games Played</h4></div><div><h1>046</h1><h4>Games Backloggd</h4></div>')),
    { 'games played': 549, 'games backloggd': 46 },
  );
  const $ = grid(card('hades', '1', 'Hades', 100) + card('celeste', '2', 'Celeste', 70, 'adult-cover') + card('tetris', '3', 'Tetris', 0), '/u/sky/games?page=2');
  assert.deepEqual(parseGameGrid($).map((g) => [g.slug, g.gameId, g.rating, g.adult, g.reviewed]), [
    ['hades', '1', 5, false, true], ['celeste', '2', 3.5, true, true], ['tetris', '3', null, false, false],
  ]);
  assert.equal(nextPageHref($), '/u/sky/games?page=2');
  assert.equal(nextPageHref(grid('')), null);
});

test('a log page yields status, dates, platforms, per-day minutes and milestones', () => {
  const log = parseLogPage(cheerio.load(logHtml));
  assert.equal(log.status, 'Completed');
  assert.equal(log.rating, 4.5);
  assert.equal(log.timePlayed, '2h 30m');
  assert.equal(log.daysInJournal, 2);
  assert.equal(log.firstPlayed, '2026-02-25');
  assert.equal(log.lastPlayed, '2026-10-22');
  assert.deepEqual(log.platforms, ['Windows PC via Mac', 'Switch']);
  assert.deepEqual(log.sessions, [{ day: '2026-10-22', minutes: 120 }, { day: '2026-10-21', minutes: 30 }]);
  assert.deepEqual(log.milestones, [{ day: '2026-10-22', label: 'Finished' }]);
});

test('reviews, lists and journal pages parse', () => {
  const reviews = parseReviews(cheerio.load(`
    <div class="row">
      <div class="col-2"><a href="/games/hades/"><div class="game-cover"><img class="card-img" alt="Hades"></div></a></div>
      <div class="col">
        <div class="row top-bar review-details">
          <div class="stars-top" style="width:80%"></div>
          <div class="game-status"><a>Completed</a></div><p class="review-platform">Switch</p>
          <p class="local-time-tooltip">Oct 24, 2026</p>
        </div>
        <div class="row review-body"><p class="card-text">Line one<br>Line two</p></div>
        <div class="row review-bottom-bar"><a href="/u/sky/review/77/likes/">3 Likes</a><a href="/u/sky/review/77/">Open</a></div>
      </div>
    </div>`));
  assert.deepEqual(reviews, [{
    id: '77', slug: 'hades', title: 'Hades', rating: 4, status: 'Completed', platform: 'Switch',
    date: 'Oct 24, 2026', text: 'Line one\nLine two', likes: 3,
  }]);

  assert.deepEqual(parseListsIndex(cheerio.load(`
    <a href="/u/sky/list/best/"><img></a><a href="/u/sky/list/best/">Best games</a><a href="/u/sky/list/other/">Other</a>`), 'sky'),
  [{ slug: 'best', name: 'Best games' }, { slug: 'other', name: 'Other' }]);
  assert.deepEqual(parseListGames(cheerio.load(card('hades', '1', 'Hades', 0) + card('hades', '1', 'Hades', 0))), [{ slug: 'hades', title: 'Hades' }]);

  const entry = (header: string, day: string, slug: string) => `
    <div class="journal_entry">
      ${header ? `<div class="month-year-date"><h4>${header}</h4></div>` : ''}
      <span class="date-day">${day}</span><img class="card-img" alt="${slug}">
      <div class="game-name"><a href="/games/${slug}/"></a></div>
      <p class="journal-platform">PC</p><p class="journal-time">1h 0m</p>
    </div>`;
  assert.deepEqual(parseJournalPage(cheerio.load(
    entry('November, 2026', '16', 'a') + entry('', '09', 'b') + entry('October, 2026', '31', 'c'),
  )).map((e) => [e.day, e.slug, e.time]), [['2026-11-16', 'a', '1h 0m'], ['2026-11-09', 'b', '1h 0m'], ['2026-10-31', 'c', '1h 0m']]);
});

function fakeSite(pages: Record<string, string>, failures: Record<string, number> = {}) {
  const requested: string[] = [];
  const load = async (path: string) => {
    requested.push(path);
    if (failures[path]) { failures[path]--; throw new Error(`backloggd: HTTP 503 for ${path}`); }
    const html = pages[path];
    if (html === undefined) throw new Error(`backloggd: HTTP 404 for ${path}`);
    return cheerio.load(html);
  };
  return { load, requested };
}

const gridHtml = (cards: string, next?: string) =>
  `<div id="user_games">${cards}</div><nav class="pagy nav">${next ? `<a href="${next}" aria-label="Next">Next</a>` : ''}</nav>`;

function sitePages(): Record<string, string> {
  return {
    '/u/sky/': '<div><h1>2</h1><h4>Games Played</h4></div><div><h1>01</h1><h4>Games Backloggd</h4></div>',
    '/u/sky/games/played/': gridHtml(card('hades', '1', 'Hades', 100), '/u/sky/games?page=2'),
    '/u/sky/games?page=2': gridHtml(card('tetris', '3', 'Tetris', 0)),
    '/u/sky/games/playing/': gridHtml(''),
    '/u/sky/games/backlog/': gridHtml(card('celeste', '2', 'Celeste', 0)),
    '/u/sky/games/wishlist/': gridHtml(''),
    '/u/sky/logs/hades/': logHtml,
    // tetris has no log page → 404
    '/u/sky/reviews/': '',
    '/u/sky/lists/': '<a href="/u/sky/list/best/">Best</a>',
    '/u/sky/list/best/': gridHtml(card('hades', '1', 'Hades', 0)),
    '/u/sky/journal/': '<div class="journal_entry"><div class="month-year-date"><h4>October, 2026</h4></div><span class="date-day">22</span><img class="card-img" alt="Hades"><div class="game-name"><a href="/games/hades/"></a></div></div>',
  };
}

test('the crawler walks every list and page, tolerates missing logs, and resumes from cached logs', async () => {
  const site = fakeSite(sitePages(), { '/u/sky/logs/hades/': 1 });
  const archive = await crawlBackloggd({ username: 'sky', load: site.load, delayMs: 0 });
  assert.deepEqual(archive.games.played.map((g) => g.slug), ['hades', 'tetris']);
  assert.deepEqual(archive.games.backlog.map((g) => g.slug), ['celeste']);
  assert.equal(archive.logs.tetris, null);
  // A transient 503 is not cached as "no log", so a re-run retries it.
  assert.equal('hades' in archive.logs, false);
  assert.deepEqual(archive.lists, [{ slug: 'best', name: 'Best', games: [{ slug: 'hades', title: 'Hades' }] }]);
  assert.equal(archive.journal.length, 1);

  // Resuming fetches only the log that is still missing.
  const retry = fakeSite(sitePages());
  const resumed = await crawlBackloggd({ username: 'sky', load: retry.load, delayMs: 0, existing: archive });
  assert.equal(resumed.logs.hades?.status, 'Completed');
  assert.deepEqual(retry.requested.filter((p) => p.includes('/logs/')), ['/u/sky/logs/hades/']);
});

test('importing an archive is idempotent and matches the hourly source identity', () => {
  const archive = {
    version: 1 as const, username: 'sky', crawledAt: '2026-11-18T00:00:00Z', stats: {},
    games: {
      played: [
        { slug: 'hades', gameId: '1', title: 'Hades', cover: 'c', adult: false, rating: 5, reviewed: true },
        { slug: 'tetris', gameId: '3', title: 'Tetris', cover: 'c', adult: false, rating: null, reviewed: false },
      ],
      playing: [], backlog: [], wishlist: [],
    },
    logs: { hades: parseLogPage(cheerio.load(logHtml)), tetris: null },
    reviews: [], lists: [], journal: [],
  };
  const { entries, sessions, undated } = archiveToImport(archive);
  assert.deepEqual(undated, ['tetris']);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].sourceItemId, 'hades');
  assert.equal(entries[0].activityAt, '2026-10-22');
  assert.deepEqual(entries[0].rating, { value: 4.5, scale: 5 });
  assert.deepEqual(entries[0].extra, { displayDate: 'Oct 22', platform: 'Windows PC via Mac', playtime: '2h 30m' });
  assert.deepEqual(sessions, [
    { game: 'hades', day: '2026-10-22', minutes: 120 }, { game: 'hades', day: '2026-10-21', minutes: 30 },
  ]);

  const repository = new Repository(':memory:');
  const snapshot = { source: 'backloggd', profile: { id: 'sky', name: 'sky', avatar: '', url: '' }, stats: {}, entries: [], extra: { sessions } };
  const hours = () => repository.timeSpent(new Date('2026-11-18T00:00:00Z')).sources.find((s) => s.source === 'backloggd')?.windows.allTime;
  assert.deepEqual(repository.ingestEntries(entries), { inserted: 1, updated: 0 });
  repository.recordTimeLedger(snapshot);
  assert.equal(hours(), 150 * 60);
  // Running the import again, or the hourly refresh seeing the same game and days, adds nothing.
  assert.deepEqual(repository.ingestEntries(entries), { inserted: 0, updated: 1 });
  repository.recordTimeLedger(snapshot);
  assert.equal(hours(), 150 * 60);
  assert.equal(repository.countActivities(), 1);
  repository.close();
});

const reviewHtml = `
  <div class="row">
    <div class="col-2"><a href="/games/hades/"><div class="game-cover"><img class="card-img" alt="Hades <3"></div></a></div>
    <div class="col">
      <div class="row top-bar review-details"><div class="stars-top" style="width:100%"></div><div class="game-status"><a>Completed</a></div></div>
      <div class="row review-body"><p class="card-text">${'x'.repeat(400)}<script>alert(1)</script></p></div>
      <div class="row review-bottom-bar"><a href="/u/sky/review/9/">Open</a></div>
    </div>
  </div>`;

test('importing writes the browsable library, and the page escapes it', async () => {
  const site = fakeSite({ ...sitePages(), '/u/sky/reviews/': reviewHtml });
  const archive = await crawlBackloggd({ username: 'sky', load: site.load, delayMs: 0 });
  const repository = new Repository(':memory:');
  assert.equal(repository.backloggdLibrary.read(), null);

  const result = importArchive(repository, archive);
  assert.equal(result.datedGames, 1);
  importArchive(repository, archive); // replace, never duplicate
  const library = repository.backloggdLibrary.read()!;
  assert.deepEqual(Object.fromEntries(Object.entries(library.games).map(([k, v]) => [k, v.length])),
    { played: 2, playing: 0, backlog: 1, wishlist: 0 });
  const hades = library.games.played.find((g) => g.slug === 'hades')!;
  assert.deepEqual([hades.status, hades.rating, hades.timeMinutes, hades.lastPlayed, hades.platforms],
    ['Completed', 4.5, 150, '2026-10-22', ['Windows PC via Mac', 'Switch']]);
  assert.equal(library.reviews.length, 1);
  assert.deepEqual(library.lists.map((l) => [l.name, l.games.length]), [['Best', 1]]);
  assert.equal(library.journal.length, 1);

  const page = backloggdLibrarySection(library);
  assert.match(page, /Played library/);
  assert.match(page, /Hades &lt;3/);
  assert.doesNotMatch(page, /<script>alert/);
  assert.equal(backloggdLibrarySection(null), '');
  repository.close();
});

test('the daily library sync refetches recent logs, is throttled, and does nothing without an archive', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'bl-sync-'));
  try {
    const archivePath = join(dir, 'archive.json');
    const repository = new Repository(':memory:');
    const options = { archivePath, username: 'sky', delayMs: 0 };
    assert.equal(await syncBackloggdLibrary(repository, { ...options, load: fakeSite(sitePages()).load }), null);

    writeArchive(archivePath, await crawlBackloggd({ username: 'sky', load: fakeSite(sitePages()).load, delayMs: 0 }));
    assert.equal(readArchive(archivePath).logs.hades?.status, 'Completed');

    // The recent game's log changed upstream; the cached log for others is not refetched.
    const changed = sitePages();
    changed['/u/sky/logs/hades/'] = logHtml.replace('<p>Completed</p>', '<p>Playing</p>');
    const site = fakeSite(changed);
    const now = new Date('2026-11-18T00:00:00Z');
    const result = await syncBackloggdLibrary(repository, { ...options, load: site.load, now });
    assert.equal(result?.datedGames, 1);
    assert.deepEqual(site.requested.filter((p) => p.includes('/logs/')), ['/u/sky/logs/hades/']);
    assert.equal(repository.backloggdLibrary.read()!.games.played.find((g) => g.slug === 'hades')!.status, 'Playing');
    assert.equal(readArchive(archivePath).logs.hades?.status, 'Playing');

    // A second run within the interval is skipped; a day later it runs again.
    const again = fakeSite(changed);
    assert.equal(await syncBackloggdLibrary(repository, { ...options, load: again.load, now: new Date('2026-11-18T05:00:00Z') }), null);
    assert.equal(again.requested.length, 0);
    assert.notEqual(await syncBackloggdLibrary(repository, { ...options, load: again.load, now: new Date('2026-11-19T01:00:00Z') }), null);
    repository.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
