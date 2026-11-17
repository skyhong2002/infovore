import * as cheerio from 'cheerio';
import { getHtml, isoDate, parseLogSessions } from './backloggd.js';
import type { MediaEntry } from '../data/types.js';

// One-time (and re-runnable) full archive of a Backloggd account. The hourly
// source in backloggd.ts only sees the ten most recent journal games; this
// walks everything the profile exposes so later refreshes only need the
// newest changes. Parsers are pure (cheerio in, plain data out) so they can
// be tested against saved HTML; the crawler takes an injectable page loader.

export const LIST_NAMES = ['played', 'playing', 'backlog', 'wishlist'] as const;
export type GameListName = typeof LIST_NAMES[number];

export interface ArchiveGame {
  slug: string;
  gameId: string;
  title: string;
  cover: string;
  adult: boolean;
  rating: number | null; // out of 5, as shown on the list grid
  reviewed: boolean;
}

export interface ArchiveLog {
  status: string; // Completed | Playing | Backlog | Wishlist | ...
  rating: number | null;
  timePlayed: string; // "118h 45m"
  daysInJournal: number | null;
  firstPlayed: string; // 'YYYY-MM-DD' or ''
  lastPlayed: string;
  platforms: string[];
  sessions: Array<{ day: string; minutes: number }>;
  milestones: Array<{ day: string; label: string }>; // "Finished", "Abandoned", ...
}

export interface ArchiveReview {
  id: string;
  slug: string;
  title: string;
  rating: number | null;
  status: string;
  platform: string;
  date: string; // as displayed, e.g. "Oct 24, 2026"
  text: string;
  likes: number;
}

export interface ArchiveListSummary {
  slug: string;
  name: string;
  games: Array<{ slug: string; title: string }>;
}

export interface ArchiveJournalEntry {
  day: string; // 'YYYY-MM-DD'
  slug: string;
  title: string;
  platform: string;
  time: string; // "13h 0m", '' when none logged
}

export interface BackloggdArchive {
  version: 1;
  username: string;
  crawledAt: string;
  stats: Record<string, number>;
  games: Record<GameListName, ArchiveGame[]>;
  logs: Record<string, ArchiveLog | null>; // null = no log page (404)
  reviews: ArchiveReview[];
  lists: ArchiveListSummary[];
  journal: ArchiveJournalEntry[];
}

const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

const clean = (text: string) => text.replace(/\s+/g, ' ').trim();

function starRating($scope: cheerio.Cheerio<any>): number | null {
  const width = $scope.find('.stars-top').first().attr('style')?.match(/width:\s*([\d.]+)%/);
  if (!width) return null;
  const stars = Math.round((Number(width[1]) / 20) * 10) / 10;
  return stars > 0 ? stars : null;
}

function slugFromHref(href: string | undefined, prefix: string): string {
  return href?.match(new RegExp(`${prefix}/([^/?#]+)`))?.[1] ?? '';
}

export function nextPageHref($: cheerio.CheerioAPI): string | null {
  return $('nav.pagy a[aria-label="Next"]').attr('href') ?? null;
}

// ── Profile ────────────────────────────────────────────────────────────────

export function parseProfileStats($: cheerio.CheerioAPI): Record<string, number> {
  const stats: Record<string, number> = {};
  $('h4').each((_, el) => {
    const label = $(el).text().trim().toLowerCase();
    const num = $(el).closest('div').find('h1').first().text().trim();
    if (label && /^\d+$/.test(num)) stats[label] = Number(num);
  });
  return stats;
}

// ── Game grids (/games/played/, /games/backlog/, ...) ──────────────────────

export function parseGameGrid($: cheerio.CheerioAPI): ArchiveGame[] {
  const games: ArchiveGame[] = [];
  $('#user_games .col-cus-user-games').each((_, col) => {
    const $col = $(col);
    const card = $col.find('.game-cover[game_id]').first();
    if (!card.length) return;
    const slug = slugFromHref(card.find('a.cover-link').attr('href'), '/games');
    if (!slug) return;
    const img = card.find('img.card-img').first();
    const title = img.attr('alt') || clean(card.find('.game-text-centered').first().text());
    games.push({
      slug,
      gameId: card.attr('game_id') ?? '',
      title,
      cover: img.attr('data-src') || img.attr('src') || '',
      adult: card.hasClass('adult-cover'),
      rating: starRating($col.find('.game-card-meta')),
      reviewed: $col.find('a.game-reviewed').length > 0,
    });
  });
  return games;
}

// ── A game's log page (/u/<name>/logs/<slug>/) ─────────────────────────────

export function parseLogPage($: cheerio.CheerioAPI): ArchiveLog {
  const log: ArchiveLog = {
    status: '', rating: null, timePlayed: '', daysInJournal: null, firstPlayed: '', lastPlayed: '',
    platforms: [], sessions: [], milestones: [],
  };
  $('.section-title p').each((_, el) => {
    const label = clean($(el).text());
    const body = $(el).closest('.section-title').next();
    const text = clean(body.text());
    if (label === 'Log Status') log.status = clean(body.find('.current p').first().text());
    else if (label === 'Rating') log.rating = starRating(body);
    else if (label === 'Time Played') log.timePlayed = text;
    else if (label === 'Days in Journal') log.daysInJournal = Number(text.match(/\d+/)?.[0] ?? NaN) || null;
    else if (label === 'Last played') log.lastPlayed = isoDate(text);
    else if (label === 'First played') log.firstPlayed = isoDate(text);
    else if (label === 'Platforms Played') {
      log.platforms = body.find('.game-page-platform').toArray().map((a) => clean($(a).text())).filter(Boolean);
    }
  });
  log.sessions = parseLogSessions($);

  // Rows such as "22  2h 0m  Finished": the free text left after the day
  // number and the stopwatch time is a milestone label.
  let year = '';
  let month = '';
  $('.playthrough-dates').find('.playdate-month, .playdate-view').each((_, el) => {
    const $el = $(el);
    if ($el.hasClass('playdate-month')) {
      const match = clean($el.find('h3').first().text()).match(/([A-Z][a-z]+)\s+(\d{4})/);
      const index = match ? MONTH_NAMES.indexOf(match[1]) + 1 : 0;
      month = index > 0 ? String(index).padStart(2, '0') : '';
      year = match ? match[2] : '';
      return;
    }
    const day = $el.find('.number-date h4').toArray().map((h4) => clean($(h4).text())).filter((t) => /^\d{1,2}$/.test(t)).at(-1);
    if (!year || !month || !day) return;
    const label = clean($el.clone().find('.number-date, .time-played').remove().end().text());
    if (label) log.milestones.push({ day: `${year}-${month}-${day.padStart(2, '0')}`, label });
  });
  return log;
}

// ── Reviews (/u/<name>/reviews/) ───────────────────────────────────────────

export function parseReviews($: cheerio.CheerioAPI): ArchiveReview[] {
  const reviews: ArchiveReview[] = [];
  $('.review-details').each((_, el) => {
    const $col = $(el).parent();
    const $row = $col.parent();
    const id = $col.find('a[href*="/review/"]').toArray()
      .map((a) => $(a).attr('href')?.match(/\/review\/(\d+)/)?.[1]).find(Boolean) ?? '';
    const link = $row.find('a[href^="/games/"]').first();
    const slug = slugFromHref(link.attr('href'), '/games');
    if (!id || !slug) return;
    const $body = $col.find('.review-body').first();
    $body.find('br').replaceWith('\n');
    $body.find('p, div').each((_, block) => { $(block).append('\n'); });
    const text = $body.find('.card-text').first().text().replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
    reviews.push({
      id,
      slug,
      title: link.find('img').attr('alt') ?? '',
      rating: starRating($col.find('.review-details')),
      status: clean($col.find('.game-status').first().text()),
      platform: clean($col.find('.review-platform').first().text()),
      date: clean($col.find('.local-time-tooltip').first().text()),
      text,
      likes: Number($col.find('.review-bottom-bar').text().match(/(\d+)\s+Likes?/)?.[1] ?? 0),
    });
  });
  return reviews;
}

// ── Lists (/u/<name>/lists/ and each list page) ────────────────────────────

export function parseListsIndex($: cheerio.CheerioAPI, username: string): Array<{ slug: string; name: string }> {
  const seen = new Map<string, string>();
  $(`a[href^="/u/${username}/list/"]`).each((_, a) => {
    const slug = slugFromHref($(a).attr('href'), `/u/${username}/list`);
    const name = clean($(a).text());
    if (slug && !seen.get(slug)) seen.set(slug, name);
  });
  return [...seen].map(([slug, name]) => ({ slug, name }));
}

export function parseListGames($: cheerio.CheerioAPI): Array<{ slug: string; title: string }> {
  const games: Array<{ slug: string; title: string }> = [];
  const seen = new Set<string>();
  $('.game-cover').each((_, el) => {
    const $el = $(el);
    const href = $el.find('a[href^="/games/"]').first().attr('href') ?? $el.closest('a[href^="/games/"]').attr('href');
    const slug = slugFromHref(href, '/games');
    if (!slug || seen.has(slug)) return;
    seen.add(slug);
    games.push({ slug, title: $el.find('img').first().attr('alt') ?? '' });
  });
  return games;
}

// ── Journal (/u/<name>/journal/) ───────────────────────────────────────────

export function parseJournalPage($: cheerio.CheerioAPI, carry = { monthNumber: '', year: '', day: '' }): ArchiveJournalEntry[] {
  const entries: ArchiveJournalEntry[] = [];
  $('.journal_entry').each((_, el) => {
    const $e = $(el);
    const header = clean($e.find('.month-year-date h4').first().text());
    if (header) {
      const index = MONTH_NAMES.indexOf(header.split(',')[0].trim()) + 1;
      carry.monthNumber = index > 0 ? String(index).padStart(2, '0') : carry.monthNumber;
      carry.year = header.match(/(\d{4})/)?.[1] ?? carry.year;
    }
    const day = clean($e.find('.date-day').first().text()).replace(/^0/, '');
    if (day) carry.day = day;
    const slug = slugFromHref($e.find('.game-name a').attr('href'), '/games');
    const title = $e.find('img.card-img').first().attr('alt') ?? '';
    if (!slug || !carry.year || !carry.monthNumber || !carry.day) return;
    entries.push({
      day: `${carry.year}-${carry.monthNumber}-${carry.day.padStart(2, '0')}`,
      slug,
      title,
      platform: clean($e.find('.journal-platform').first().text()),
      time: clean($e.find('.journal-time').first().text()),
    });
  });
  return entries;
}

// ── Crawler ────────────────────────────────────────────────────────────────

export type PageLoader = (path: string) => Promise<cheerio.CheerioAPI>;

export interface CrawlOptions {
  username: string;
  load?: PageLoader;
  delayMs?: number;
  existing?: BackloggdArchive | null;
  // Called after each phase and periodically during the log crawl so an
  // interrupted run can resume without redoing finished work.
  save?: (archive: BackloggdArchive) => void | Promise<void>;
  log?: (message: string) => void;
  maxPages?: number;
  // Re-fetch the logs of every game on the journal's newest page even when
  // cached, so an incremental run picks up new sessions, ratings and statuses
  // without redoing the whole account.
  refreshRecent?: boolean;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const isNotFound = (error: unknown) => error instanceof Error && /HTTP (404|410)\b/.test(error.message);

async function walkPages<T>(
  load: PageLoader, firstPath: string, parse: ($: cheerio.CheerioAPI) => T[], delayMs: number, maxPages: number,
): Promise<T[]> {
  const out: T[] = [];
  let path: string | null = firstPath;
  for (let page = 1; path && page <= maxPages; page++) {
    const $: cheerio.CheerioAPI = await load(path);
    out.push(...parse($));
    path = nextPageHref($);
    if (path) await sleep(delayMs);
  }
  return out;
}

export async function crawlBackloggd(options: CrawlOptions): Promise<BackloggdArchive> {
  const { username } = options;
  const load = options.load ?? getHtml;
  const delayMs = options.delayMs ?? 600;
  const maxPages = options.maxPages ?? 200;
  const say = options.log ?? (() => {});
  const base = `/u/${username}`;
  const archive: BackloggdArchive = {
    version: 1,
    username,
    crawledAt: new Date().toISOString(),
    stats: {},
    games: { played: [], playing: [], backlog: [], wishlist: [] },
    logs: { ...(options.existing?.logs ?? {}) },
    reviews: [],
    lists: [],
    journal: [],
  };
  const save = async () => { await options.save?.(archive); };

  archive.stats = parseProfileStats(await load(`${base}/`));
  say(`profile: ${JSON.stringify(archive.stats)}`);

  for (const name of LIST_NAMES) {
    archive.games[name] = await walkPages(load, `${base}/games/${name}/`, parseGameGrid, delayMs, maxPages);
    say(`games/${name}: ${archive.games[name].length}`);
  }
  await save();

  // Only games that were played (or are being played) can have a log page.
  const slugs = [...new Set([...archive.games.played, ...archive.games.playing].map((g) => g.slug))];
  const recent = new Set<string>();
  if (options.refreshRecent) {
    for (const entry of parseJournalPage(await load(`${base}/journal/`))) recent.add(entry.slug);
  }
  const todo = slugs.filter((slug) => !(slug in archive.logs) || recent.has(slug));
  say(`logs: ${slugs.length - todo.length} cached, ${todo.length} to fetch`);
  let consecutiveFailures = 0;
  for (const [index, slug] of todo.entries()) {
    try {
      archive.logs[slug] = parseLogPage(await load(`${base}/logs/${slug}/`));
      consecutiveFailures = 0;
    } catch (error) {
      if (isNotFound(error)) {
        archive.logs[slug] = null;
      } else {
        // Transient failures are not cached, so a re-run retries them.
        say(`logs/${slug}: ${error instanceof Error ? error.message : error}`);
        if (++consecutiveFailures >= 8) {
          await save();
          throw new Error('backloggd: 8 consecutive log failures — aborting; re-run to resume');
        }
      }
    }
    if ((index + 1) % 25 === 0) {
      say(`logs: ${index + 1}/${todo.length}`);
      await save();
    }
    await sleep(delayMs);
  }
  await save();

  archive.reviews = await walkPages(load, `${base}/reviews/`, parseReviews, delayMs, maxPages);
  say(`reviews: ${archive.reviews.length}`);

  const index = await load(`${base}/lists/`);
  for (const { slug, name } of parseListsIndex(index, username)) {
    const games = await walkPages(load, `${base}/list/${slug}/`, parseListGames, delayMs, maxPages);
    archive.lists.push({ slug, name, games });
    await sleep(delayMs);
  }
  say(`lists: ${archive.lists.length}`);

  const carry = { monthNumber: '', year: '', day: '' };
  archive.journal = await walkPages(load, `${base}/journal/`, ($) => parseJournalPage($, carry), delayMs, maxPages);
  say(`journal: ${archive.journal.length}`);

  archive.crawledAt = new Date().toISOString();
  await save();
  return archive;
}

// ── Archive → infovore data ────────────────────────────────────────────────

function fmtMinutes(minutes: number): string {
  const h = Math.floor(minutes / 60);
  return h > 0 ? `${h}h ${minutes % 60}m` : `${minutes}m`;
}

export interface ArchiveImport {
  entries: MediaEntry[];
  sessions: Array<{ game: string; day: string; minutes: number }>;
  undated: string[]; // played games with no last-played date (not importable as dated activities)
}

// One dated activity per played game (its last-played day), shaped exactly
// like the hourly source's journal entries (same sourceItemId, ISO activityAt,
// no status) so re-seeing a game updates the same activity instead of adding
// a twin. Backlog/wishlist/playing lists stay in the archive: they are state,
// not dated events.
export function archiveToImport(archive: BackloggdArchive): ArchiveImport {
  const entries: MediaEntry[] = [];
  const undated: string[] = [];
  const seen = new Set<string>();
  for (const game of [...archive.games.played, ...archive.games.playing]) {
    if (seen.has(game.slug)) continue;
    seen.add(game.slug);
    const log = archive.logs[game.slug];
    const lastPlayed = log?.lastPlayed ?? '';
    if (!lastPlayed) { undated.push(game.slug); continue; }
    const rating = log?.rating ?? game.rating;
    const [, month, day] = lastPlayed.split('-').map(Number);
    const extra: Record<string, string | number> = { displayDate: `${MONTH_NAMES[month - 1].slice(0, 3)} ${day}` };
    if (log?.platforms[0]) extra.platform = log.platforms[0];
    const minutes = log?.sessions.reduce((sum, s) => sum + s.minutes, 0) ?? 0;
    if (minutes > 0) extra.playtime = fmtMinutes(minutes);
    entries.push({
      sourceItemId: game.slug,
      source: 'backloggd',
      kind: 'game',
      title: game.title,
      image: game.cover,
      activityAt: lastPlayed,
      rating: rating !== null ? { value: rating, scale: 5 } : null,
      extra,
    });
  }
  const sessions = Object.entries(archive.logs).flatMap(([game, log]) =>
    (log?.sessions ?? []).map((session) => ({ game, ...session })));
  return { entries, sessions, undated };
}
