import * as cheerio from 'cheerio';
import { config } from '../config.js';

export interface BackloggdRecentGame {
  title: string;
  cover: string;
  lastPlayed: string; // e.g. "Jul 07"
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

async function getHtml(url: string, attempt = 0): Promise<cheerio.CheerioAPI> {
  try {
    const res = await fetch(url, { headers: { 'User-Agent': config.userAgent }, signal: AbortSignal.timeout(20000) });
    if (!res.ok) throw new Error(`backloggd: HTTP ${res.status} for ${url}`);
    return cheerio.load(await res.text());
  } catch (err) {
    if (attempt < 1) {
      await new Promise((r) => setTimeout(r, 3000));
      return getHtml(url, attempt + 1);
    }
    throw err;
  }
}

// The journal and per-game log pages are now gated behind an Anubis
// proof-of-work challenge that a plain fetch can't solve, so recent
// activity comes from the profile page's own "Recently Played" grid
// instead — fewer entries (5, no platform/playtime/rating) but reliable.
export async function fetchBackloggd(): Promise<BackloggdStats> {
  const $profile = await getHtml(`https://backloggd.com/u/${config.backloggd.username}/`);

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

  const recent: BackloggdRecentGame[] = [];
  $profile('#profile-journal')
    .children('div')
    .each((_, col) => {
      const $c = $profile(col);
      const img = $c.find('img.card-img').first();
      const title = img.attr('alt') ?? '';
      const cover = img.attr('data-src') || img.attr('src') || '';
      const lastPlayed = $c.find('.played-date').first().text().trim();
      if (!title) return;
      recent.push({ title, cover, lastPlayed });
    });

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
