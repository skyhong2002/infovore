import { config } from '../config.js';
import type { MediaEntry, SourceSnapshot } from '../data/types.js';

const API = 'https://kitsu.app/api/edge';
const headers = { Accept: 'application/vnd.api+json' };

async function getJson(url: string): Promise<any> {
  const res = await fetch(url, { headers, signal: AbortSignal.timeout(15000) });
  if (!res.ok) throw new Error(`kitsu: HTTP ${res.status} for ${url}`);
  return res.json();
}

function parseEntries(doc: any, kind: 'anime' | 'manga'): MediaEntry[] {
  const mediaById = new Map<string, any>(
    (doc.included ?? []).map((m: any) => [m.id, m])
  );
  return (doc.data ?? []).map((entry: any) => {
    const media = mediaById.get(entry.relationships?.[kind]?.data?.id);
    const attrs = media?.attributes ?? {};
    const ratingTwenty = entry.attributes?.ratingTwenty;
    // Prefer the English title; fall back to the canonical (usually romaji)
    // when no English one exists.
    return {
      source: 'kitsu',
      kind,
      title: attrs.titles?.en || attrs.canonicalTitle || 'Unknown',
      image: attrs.posterImage?.small ?? '',
      status: entry.attributes?.status ?? '',
      activityAt: entry.attributes?.progressedAt ?? '',
      rating: ratingTwenty ? { value: ratingTwenty / 2, scale: 10 } : null,
      extra: { progress: entry.attributes?.progress ?? 0 },
    };
  });
}

export async function fetchKitsu(): Promise<SourceSnapshot> {
  const { userId, slug } = config.kitsu;

  const [userDoc, statsDoc, animeDoc, mangaDoc] = await Promise.all([
    getJson(`${API}/users/${userId}`),
    getJson(`${API}/users/${userId}/stats`),
    getJson(
      `${API}/library-entries?filter[userId]=${userId}&filter[kind]=anime&filter[status]=current,completed,on_hold,dropped&page[limit]=10&sort=-progressedAt&include=anime`
    ),
    getJson(
      `${API}/library-entries?filter[userId]=${userId}&filter[kind]=manga&filter[status]=current,completed,on_hold,dropped&page[limit]=10&sort=-progressedAt&include=manga`
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
    source: 'kitsu',
    profile: {
      id: slug,
      name: user.name ?? slug,
      avatar: user.avatar?.medium ?? user.avatar?.small ?? '',
      url: `https://kitsu.app/users/${slug}`,
    },
    stats: {
      animeCompleted: anime.completed ?? 0,
      animeEpisodes: anime.units ?? 0,
      animeHours: Math.round((anime.time ?? 0) / 3600),
      mangaCompleted: manga.completed ?? 0,
      mangaChapters: manga.units ?? 0,
    },
    entries: [...parseEntries(animeDoc, 'anime'), ...parseEntries(mangaDoc, 'manga')],
    extra: {},
  };
}
