import { config } from '../config.js';

export interface StatsfmAlbum {
  name: string;
  artist: string;
  image: string;
  streams: number;
}

export interface StatsfmStats {
  username: string;
  displayName: string;
  avatar: string;
  weeklyStreams: number;
  weeklyMinutes: number;
  weeklyUniqueTracks: number;
  weeklyUniqueArtists: number;
  topAlbums: StatsfmAlbum[];
  topArtists: { name: string; image: string; streams: number }[];
}

const API = 'https://api.stats.fm/api/v1';

async function getJson(url: string): Promise<any> {
  const res = await fetch(url, { headers: { 'User-Agent': config.userAgent }, signal: AbortSignal.timeout(15000) });
  if (!res.ok) throw new Error(`stats.fm: HTTP ${res.status} for ${url}`);
  return res.json();
}

export async function fetchStatsfm(): Promise<StatsfmStats> {
  const user = config.statsfm.username;

  const [profile, weekStats, topAlbums, topArtists] = await Promise.all([
    getJson(`${API}/users/${user}`),
    getJson(`${API}/users/${user}/streams/stats?range=weeks`),
    getJson(`${API}/users/${user}/top/albums?range=weeks&limit=10`),
    getJson(`${API}/users/${user}/top/artists?range=weeks&limit=10`),
  ]);

  const s = weekStats.items ?? {};

  return {
    username: user,
    displayName: profile.item?.displayName ?? user,
    avatar: profile.item?.image ?? '',
    weeklyStreams: s.count ?? 0,
    weeklyMinutes: Math.round((s.durationMs ?? 0) / 60000),
    weeklyUniqueTracks: s.cardinality?.tracks ?? 0,
    weeklyUniqueArtists: s.cardinality?.artists ?? 0,
    topAlbums: (topAlbums.items ?? []).map((it: any) => ({
      name: it.album?.name ?? '',
      artist: it.album?.artists?.[0]?.name ?? '',
      image: it.album?.image ?? '',
      streams: it.streams ?? 0,
    })),
    topArtists: (topArtists.items ?? []).map((it: any) => ({
      name: it.artist?.name ?? '',
      image: it.artist?.image ?? '',
      streams: it.streams ?? 0,
    })),
  };
}
