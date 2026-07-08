import * as cheerio from 'cheerio';
import { config } from '../config.js';
import { cookieHeader, isAnubisChallenge, solveAnubis, absorbCookies } from './anubis.js';

export interface BackloggdRecentGame {
  title: string;
  cover: string;
  platform: string; // e.g. "Nintendo DS via Android" from the log page, '' if unavailable
  lastPlayed: string; // e.g. "Jul 7"
  playtime: string; // e.g. "1h 0m", '' if no sessions logged
  rating: number | null; // out of 5, e.g. 3.5
}

export interface BackloggdStats {
  username: string;
  avatar: string;
  gamesPlayed: number;
  playedThisYear: number;
  backlog: number;
  yearExtras: string; // e.g. "+14 extras: 10 Updates · 3 Expansions · 1 DLC"
  recent: BackloggdRecentGame[];
}

const ORIGIN = 'https://backloggd.com';

const MONTHS: Record<string, string> = {
  January: 'Jan', February: 'Feb', March: 'Mar', April: 'Apr', May: 'May',
  June: 'Jun', July: 'Jul', August: 'Aug', September: 'Sep', October: 'Oct',
  November: 'Nov', December: 'Dec',
};

// Fetch a Backloggd page, transparently solving the Anubis proof-of-work
// challenge (and caching its cookie) if the journal/log pages are gated.
async function getHtml(path: string): Promise<cheerio.CheerioAPI> {
  // On datacenter IPs the pass-challenge can still hand back a fresh
  // challenge (Bunny CDN edge propagation / stricter policy), so solve in a
  // loop rather than once.
  const maxAttempts = 4;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const res = await fetch(`${ORIGIN}${path}`, {
      headers: { 'User-Agent': config.userAgent, Cookie: cookieHeader(ORIGIN) },
      signal: AbortSignal.timeout(20000),
    });
    const html = await res.text();
    absorbCookies(ORIGIN, res); // keep bunny_shield etc. fresh
    if (isAnubisChallenge(html)) {
      if (attempt === maxAttempts) throw new Error(`backloggd: Anubis unsolved after ${maxAttempts} tries for ${path}`);
      const solved = await solveAnubis(res, html, ORIGIN, path);
      if (!solved) await new Promise((r) => setTimeout(r, 1500));
      continue; // re-fetch with whatever cookie we now hold
    }
    if (!res.ok) throw new Error(`backloggd: HTTP ${res.status} for ${path}`);
    return cheerio.load(html);
  }
  throw new Error(`backloggd: exhausted attempts for ${path}`);
}

function shortDate(full: string): string {
  // "July  7, 2026" -> "Jul 7"
  const m = full.match(/([A-Z][a-z]+)\s+(\d{1,2})/);
  return m ? `${MONTHS[m[1]] ?? m[1]} ${m[2]}` : full;
}

function sumSessions(times: string[]): string {
  let mins = 0;
  for (const t of times) {
    const h = t.match(/(\d+)h/);
    const m = t.match(/(\d+)m/);
    mins += (h ? Number(h[1]) * 60 : 0) + (m ? Number(m[1]) : 0);
  }
  if (mins === 0) return '';
  const h = Math.floor(mins / 60);
  return h > 0 ? `${h}h ${mins % 60}m` : `${mins}m`;
}

// Per-game log page: last played date, summed session time, platform,
// and the log's star rating (stars-top width % of 5 stars).
async function fetchLog(slug: string): Promise<Partial<BackloggdRecentGame>> {
  try {
    const $ = await getHtml(`/u/${config.backloggd.username}/logs/${slug}/`);
    const out: Partial<BackloggdRecentGame> = {};

    $('.section-title p').each((_, el) => {
      const label = $(el).text().trim();
      const section = $(el).closest('.section-title').next();
      if (label === 'Last played') {
        out.lastPlayed = shortDate(section.find('p').first().text().trim());
      } else if (label === 'Platforms Played') {
        out.platform = section.find('.game-page-platform').first().text().trim();
      } else if (label === 'Rating') {
        const width = section.find('.stars-top').attr('style') ?? '';
        const pct = width.match(/width:\s*(\d+)%/);
        if (pct) out.rating = Math.round((Number(pct[1]) / 20) * 10) / 10;
      }
    });

    const times: string[] = [];
    $('.time-played p').each((_, el) => { times.push($(el).text().trim()); });
    out.playtime = sumSessions(times);
    return out;
  } catch {
    return {};
  }
}

// Fallback: the profile page's own "Recently Played" grid — only 5 entries
// with title/cover/date, but it isn't behind the Anubis gate.
function profileRecent($profile: cheerio.CheerioAPI): BackloggdRecentGame[] {
  const recent: BackloggdRecentGame[] = [];
  $profile('#profile-journal')
    .children('div')
    .each((_, col) => {
      const $c = $profile(col);
      const img = $c.find('img.card-img').first();
      const title = img.attr('alt') ?? '';
      const cover = img.attr('data-src') || img.attr('src') || '';
      const lastPlayed = shortDate($c.find('.played-date').first().text().trim());
      if (!title) return;
      recent.push({ title, cover, platform: '', lastPlayed, playtime: '', rating: null });
    });
  return recent;
}

export async function fetchBackloggd(): Promise<BackloggdStats> {
  const base = `/u/${config.backloggd.username}`;
  const $profile = await getHtml(`${base}/`);

  // Profile stats: <h1>NUMBER</h1> ... <h4>Label</h4> pairs.
  const stats: Record<string, number> = {};
  $profile('h4').each((_, el) => {
    const label = $profile(el).text().trim().toLowerCase();
    const num = $profile(el).closest('div').find('h1').first().text().trim();
    if (num && /^\d+$/.test(num)) stats[label] = Number(num);
  });
  const byLabel = (needle: string) => {
    const key = Object.keys(stats).find((k) => k.includes(needle));
    return key !== undefined ? stats[key] : 0;
  };

  // "Played in <year>" extras tooltip: "in addition to 14 extras
  // <ul><li>10 Updates</li>..." rendered as one compact line.
  let yearExtras = '';
  const tip = $profile('[data-breakdown-type="year"]').attr('data-tippy-content') ?? '';
  const extrasMatch = tip.match(/in addition to (\d+) extras/);
  if (extrasMatch) {
    const $tip = cheerio.load(tip);
    const items: string[] = [];
    $tip('li').each((_, el) => { items.push($tip(el).text().trim()); });
    yearExtras = `+${extrasMatch[1]} extras: ${items.join(' · ')}`;
  }

  const avatar = $profile('#profile-header .avatar img').attr('src') ?? '';

  // Try the journal (10 recent games, richer per-game detail). If the Anubis
  // gate can't be cleared, fall back to the profile's 5-game grid.
  let recent: BackloggdRecentGame[];
  try {
    const $journal = await getHtml(`${base}/journal/`);
    const parsed: (BackloggdRecentGame & { slug: string })[] = [];
    const seen = new Set<string>();
    let month = '';
    let day = '';
    $journal('.journal_entry').each((_, entry) => {
      if (parsed.length >= 10) return;
      const $e = $journal(entry);
      const monthYear = $e.find('.month-year-date h4').first().text().trim();
      if (monthYear) month = MONTHS[monthYear.split(',')[0].trim()] ?? monthYear;
      const dayText = $e.find('.date-day').first().text().trim().replace(/^0/, '');
      if (dayText) day = dayText;
      const img = $e.find('img.card-img').first();
      const title = img.attr('alt') ?? '';
      const cover = img.attr('src') ?? '';
      const slug = ($e.find('.game-name a').attr('href') ?? '').match(/\/games\/([^/]+)/)?.[1] ?? '';
      const platform = $e.find('.journal-platform').first().text().trim();
      if (!title || seen.has(title)) return;
      seen.add(title);
      parsed.push({ title, cover, platform, slug, lastPlayed: day ? `${month} ${day}` : month, playtime: '', rating: null });
    });

    if (parsed.length === 0) throw new Error('backloggd: no journal entries parsed');

    // Enrich each game from its log page — sequentially, so we don't hammer
    // the Anubis gate with parallel bursts.
    const logs: Partial<BackloggdRecentGame>[] = [];
    for (const g of parsed) {
      logs.push(g.slug ? await fetchLog(g.slug) : {});
      await new Promise((r) => setTimeout(r, 500));
    }
    recent = parsed.map((g, i) => {
      const { slug: _slug, ...rest } = { ...g, ...logs[i] };
      return rest;
    });
  } catch (err) {
    console.error(`[backloggd] journal unavailable, using profile fallback: ${err instanceof Error ? err.message : err}`);
    recent = profileRecent($profile);
  }

  return {
    username: config.backloggd.username,
    avatar,
    gamesPlayed: byLabel('games played'),
    playedThisYear: byLabel('played in'),
    backlog: byLabel('backloggd'),
    yearExtras,
    recent,
  };
}
