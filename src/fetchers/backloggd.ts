import * as cheerio from 'cheerio';
import { config } from '../config.js';

export interface BackloggdRecentGame {
  title: string;
  cover: string;
  platform: string;
  lastPlayed: string; // e.g. "Jul 6"
}

export interface BackloggdStats {
  username: string;
  avatar: string;
  gamesPlayed: number;
  playedThisYear: number;
  backlog: number;
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

  const avatar = $profile('#profile-header .avatar img').attr('src') ?? '';

  // Journal: entries in reverse-chronological order. Month headers
  // (.month-year-date) and day numbers (.date-day) apply to following
  // entries until the next header appears.
  const recent: BackloggdRecentGame[] = [];
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
    const platform = $e.find('.journal-platform').first().text().trim();
    if (!title || seen.has(title)) return;
    seen.add(title);
    recent.push({ title, cover, platform, lastPlayed: day ? `${month} ${day}` : month });
  });

  return {
    username: config.backloggd.username,
    avatar,
    gamesPlayed: byLabel('games played'),
    playedThisYear: byLabel('played in'),
    backlog: byLabel('backloggd'),
    recent,
  };
}
