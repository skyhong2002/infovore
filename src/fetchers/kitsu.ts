import { config } from '../config.js';

export interface KitsuEntry {
  title: string;
  poster: string;
  progress: number;
  status: string;
  progressedAt: string; // ISO date
  rating: number | null; // out of 5 (ratingTwenty / 4)
}

export interface KitsuStats {
  slug: string;
  name: string;
  avatar: string;
  anime: {
    completed: number;
    episodes: number;
    hours: number;
    recent: KitsuEntry[];
  };
  manga: {
    completed: number;
    chapters: number;
    recent: KitsuEntry[];
  };
}

const API = 'https://kitsu.app/api/edge';
const headers = { Accept: 'application/vnd.api+json' };

async function getJson(url: string): Promise<any> {
  const res = await fetch(url, { headers, signal: AbortSignal.timeout(15000) });
  if (!res.ok) throw new Error(`kitsu: HTTP ${res.status} for ${url}`);
  return res.json();
}

function parseEntries(doc: any, kind: 'anime' | 'manga'): KitsuEntry[] {
  const mediaById = new Map<string, any>(
    (doc.included ?? []).map((m: any) => [m.id, m])
  );
  return (doc.data ?? []).map((entry: any) => {
    const media = mediaById.get(entry.relationships?.[kind]?.data?.id);
    const attrs = media?.attributes ?? {};
    return {
      title: attrs.canonicalTitle ?? 'Unknown',
      poster: attrs.posterImage?.small ?? '',
      progress: entry.attributes?.progress ?? 0,
      status: entry.attributes?.status ?? '',
      progressedAt: entry.attributes?.progressedAt ?? '',
      rating: entry.attributes?.ratingTwenty ? entry.attributes.ratingTwenty / 4 : null,
    };
  });
}

export async function fetchKitsu(): Promise<KitsuStats> {
  const { userId, slug } = config.kitsu;

  const [userDoc, statsDoc, animeDoc, mangaDoc] = await Promise.all([
    getJson(`${API}/users/${userId}`),
    getJson(`${API}/users/${userId}/stats`),
    getJson(
      `${API}/library-entries?filter[userId]=${userId}&filter[kind]=anime&page[limit]=10&sort=-progressedAt&include=anime`
    ),
    getJson(
      `${API}/library-entries?filter[userId]=${userId}&filter[kind]=manga&page[limit]=10&sort=-progressedAt&include=manga`
    ),
  ]);

  const user = userDoc.data?.attributes ?? {};
  const statsByKind: Record<string, any> = {};
  for (const s of statsDoc.data ?? []) {
    statsByKind[s.attributes?.kind] = s.attributes?.statsData ?? {};
  }
  const anime = statsByKind['anime-amount-consumed'] ?? {};
  const manga = statsByKind['manga-amount-consumed'] ?? {};

  return {
    slug,
    name: user.name ?? slug,
    avatar: user.avatar?.medium ?? user.avatar?.small ?? '',
    anime: {
      completed: anime.completed ?? 0,
      episodes: anime.units ?? 0,
      hours: Math.round((anime.time ?? 0) / 3600),
      recent: parseEntries(animeDoc, 'anime'),
    },
    manga: {
      completed: manga.completed ?? 0,
      chapters: manga.units ?? 0,
      recent: parseEntries(mangaDoc, 'manga'),
    },
  };
}
