import { config } from '../config.js';

export interface StatsfmStats {
  username: string;
  displayName: string;
  weeklyStreams: number;
  weeklyMinutes: number;
  weeklyUniqueTracks: number;
  weeklyUniqueArtists: number;
  topArtists: { name: string; image: string }[];
  currentTrack: { name: string; artist: string } | null;
}

const API = 'https://api.stats.fm/api/v1';

async function getJson(url: string): Promise<any> {
  const res = await fetch(url, { headers: { 'User-Agent': config.userAgent } });
  if (!res.ok) throw new Error(`stats.fm: HTTP ${res.status} for ${url}`);
  return res.json();
}

export async function fetchStatsfm(): Promise<StatsfmStats> {
  const user = config.statsfm.username;

  const [profile, weekStats, topArtists, current] = await Promise.all([
    getJson(`${API}/users/${user}`),
    getJson(`${API}/users/${user}/streams/stats?range=weeks`),
    getJson(`${API}/users/${user}/top/artists?range=weeks&limit=3`),
    getJson(`${API}/users/${user}/streams/current`).catch(() => null),
  ]);

  const s = weekStats.items ?? {};
  const track = current?.item?.track;

  return {
    username: user,
    displayName: profile.item?.displayName ?? user,
    weeklyStreams: s.count ?? 0,
    weeklyMinutes: Math.round((s.durationMs ?? 0) / 60000),
    weeklyUniqueTracks: s.cardinality?.tracks ?? 0,
    weeklyUniqueArtists: s.cardinality?.artists ?? 0,
    topArtists: (topArtists.items ?? []).map((it: any) => ({
      name: it.artist?.name ?? '',
      image: it.artist?.image ?? '',
    })),
    currentTrack: track
      ? { name: track.name, artist: track.artists?.[0]?.name ?? '' }
      : null,
  };
}
