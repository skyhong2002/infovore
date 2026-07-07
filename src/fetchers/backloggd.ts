import * as cheerio from 'cheerio';
import { config } from '../config.js';

export interface BackloggdStats {
  username: string;
  gamesPlayed: number;
  playedThisYear: number;
  backlog: number;
  recentlyPlayed: { title: string; cover: string; gameId: string }[];
}

export async function fetchBackloggd(): Promise<BackloggdStats> {
  const url = `https://backloggd.com/u/${config.backloggd.username}/`;
  const res = await fetch(url, { headers: { 'User-Agent': config.userAgent } });
  if (!res.ok) throw new Error(`backloggd: HTTP ${res.status}`);
  const $ = cheerio.load(await res.text());

  // Profile stats are laid out as <h1>NUMBER</h1> ... <h4>Label</h4> pairs.
  const stats: Record<string, number> = {};
  $('h4').each((_, el) => {
    const label = $(el).text().trim().toLowerCase();
    const num = $(el).closest('div').find('h1').first().text().trim();
    if (num && /^\d+$/.test(num)) stats[label] = Number(num);
  });
  const byLabel = (needle: string) => {
    const key = Object.keys(stats).find((k) => k.includes(needle));
    return key !== undefined ? stats[key] : 0;
  };

  const recentlyPlayed: BackloggdStats['recentlyPlayed'] = [];
  $('.game-cover').each((_, el) => {
    if (recentlyPlayed.length >= 5) return;
    const img = $(el).find('img.card-img');
    const title = img.attr('alt') ?? '';
    const cover = img.attr('src') ?? '';
    const gameId = $(el).attr('game_id') ?? '';
    if (title && cover) recentlyPlayed.push({ title, cover, gameId });
  });

  return {
    username: config.backloggd.username,
    gamesPlayed: byLabel('games played'),
    playedThisYear: byLabel('played in'),
    backlog: byLabel('backloggd'),
    recentlyPlayed,
  };
}
