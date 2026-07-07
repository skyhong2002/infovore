import * as cheerio from 'cheerio';
import { config } from '../config.js';

export interface BackloggdRecentGame {
  title: string;
  cover: string;
  platform: string; // e.g. "Nintendo DS via Android" from the log page
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

const MONTHS: Record<string, string> = {
  January: 'Jan', February: 'Feb', March: 'Mar', April: 'Apr', May: 'May',
  June: 'Jun', July: 'Jul', August: 'Aug', September: 'Sep', October: 'Oct',
  November: 'Nov', December: 'Dec',
};

async function getHtml(url: string): Promise<cheerio.CheerioAPI> {
  const res = await fetch(url, { headers: { 'User-Agent': config.userAgent }, signal: AbortSignal.timeout(15000) });
  if (!res.ok) throw new Error(`backloggd: HTTP ${res.status} for ${url}`);
  return cheerio.load(await res.text());
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
    const $ = await getHtml(`https://backloggd.com/u/${config.backloggd.username}/logs/${slug}/`);
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

export async function fetchBackloggd(): Promise<BackloggdStats> {
  const base = `https://backloggd.com/u/${config.backloggd.username}`;
  const [$profile, $journal] = await Promise.all([
    getHtml(`${base}/`),
    getHtml(`${base}/journal/`),
  ]);

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

  // Journal: entries in reverse-chronological order. Month headers
  // (.month-year-date) and day numbers (.date-day) apply to following
  // entries until the next header appears.
  const recent: (BackloggdRecentGame & { slug: string })[] = [];
  const seen = new Set<string>();
  let month = '';
  let day = '';
  $journal('.journal_entry').each((_, entry) => {
    if (recent.length >= 5) return;
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
    recent.push({
      title, cover, platform, slug,
      lastPlayed: day ? `${month} ${day}` : month,
      playtime: '',
      rating: null,
    });
  });

  // Enrich each recent game from its log page.
  const logs = await Promise.all(recent.map((g) => (g.slug ? fetchLog(g.slug) : {})));
  const enriched = recent.map((g, i) => {
    const { slug: _slug, ...rest } = { ...g, ...logs[i] };
    return rest;
  });

  return {
    username: config.backloggd.username,
    avatar,
    gamesPlayed: byLabel('games played'),
    playedThisYear: byLabel('played in'),
    backlog: byLabel('backloggd'),
    yearExtras,
    recent: enriched,
  };
}
