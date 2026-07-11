import { config } from '../config.js';
import type { MediaEntry, SourceSnapshot } from '../data/types.js';

export interface StatsfmAlbum {
  name: string;
  artist: string;
  image: string;
  streams: number;
}

export interface StatsfmArtist {
  name: string;
  image: string;
  streams: number;
}

// stats.fm's API only exposes a weekly top-albums/top-artists leaderboard,
// not individually dated listen events — so this has no natural fit as
// `entries` (which need an activityAt) and lives in the snapshot's `extra`.
export interface StatsfmExtra {
  topAlbums: StatsfmAlbum[];
  topArtists: StatsfmArtist[];
}

const API = 'https://api.stats.fm/api/v1';

async function getJson(url: string): Promise<any> {
  const res = await fetch(url, { headers: { 'User-Agent': config.userAgent }, signal: AbortSignal.timeout(15000) });
  if (!res.ok) throw new Error(`stats.fm: HTTP ${res.status} for ${url}`);
  return res.json();
}

export async function fetchStatsfm(): Promise<SourceSnapshot<StatsfmExtra>> {
  const user = config.statsfm.username;

  const [profile, weekStats, topAlbums, topArtists, recentStreams] = await Promise.all([
    getJson(`${API}/users/${user}`),
    getJson(`${API}/users/${user}/streams/stats?range=weeks`),
    getJson(`${API}/users/${user}/top/albums?range=weeks&limit=10`),
    getJson(`${API}/users/${user}/top/artists?range=weeks&limit=10`),
    getJson(`${API}/users/${user}/streams/recent?limit=50`),
  ]);

  return normalizeStatsfm(user, profile, weekStats, topAlbums, topArtists, recentStreams);
}

export function normalizeStatsfm(
  user: string, profile: any, weekStats: any, topAlbums: any, topArtists: any, recentStreams: any = { items: [] }
): SourceSnapshot<StatsfmExtra> {
  const s = weekStats.items ?? {};
  const entries: MediaEntry[] = (recentStreams.items ?? []).map((stream: any) => ({
    sourceItemId: String(stream.track?.id ?? stream.track?.externalIds?.spotify?.[0] ?? stream.track?.name ?? ''),
    source: 'statsfm', kind: 'music', title: stream.track?.name ?? 'Unknown track',
    image: stream.track?.albums?.[0]?.image ?? '', status: 'listened', activityAt: stream.endTime ?? '', rating: null,
    extra: {
      artist: stream.track?.artists?.map((artist: any) => artist.name).filter(Boolean).join(', ') ?? '',
      album: stream.track?.albums?.[0]?.name ?? '', platform: stream.platform ?? '',
      durationMs: stream.durationMs ?? stream.track?.durationMs ?? 0,
    },
  }));
  return {
    source: 'statsfm',
    profile: {
      id: user,
      name: profile.item?.displayName ?? user,
      avatar: profile.item?.image ?? '',
      url: `https://stats.fm/${user}`,
    },
    stats: {
      weeklyStreams: s.count ?? 0,
      weeklyMinutes: Math.round((s.durationMs ?? 0) / 60000),
      weeklyUniqueTracks: s.cardinality?.tracks ?? 0,
      weeklyUniqueArtists: s.cardinality?.artists ?? 0,
    },
    entries,
    extra: {
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
    },
  };
}
