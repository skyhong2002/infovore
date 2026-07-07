import { config } from '../config.js';

export interface KitsuStats {
  slug: string;
  animeCompleted: number;
  animeMinutesWatched: number;
  episodesWatched: number;
  currentlyWatching: { title: string; poster: string; progress: number }[];
}

const API = 'https://kitsu.app/api/edge';
const headers = {
  Accept: 'application/vnd.api+json',
  'Content-Type': 'application/vnd.api+json',
};

async function getJson(url: string): Promise<any> {
  const res = await fetch(url, { headers });
  if (!res.ok) throw new Error(`kitsu: HTTP ${res.status} for ${url}`);
  return res.json();
}

export async function fetchKitsu(): Promise<KitsuStats> {
  const { userId, slug } = { userId: config.kitsu.userId, slug: config.kitsu.slug };

  const statsDoc = await getJson(
    `${API}/users/${userId}/stats?filter[kind]=anime-amount-consumed`
  );
  const consumed = statsDoc.data?.[0]?.attributes?.statsData ?? {};

  const libDoc = await getJson(
    `${API}/library-entries?filter[userId]=${userId}&filter[kind]=anime&filter[status]=current&include=anime&page[limit]=5&sort=-progressedAt`
  );
  const animeById = new Map<string, any>(
    (libDoc.included ?? []).map((a: any) => [a.id, a])
  );
  const currentlyWatching = (libDoc.data ?? []).map((entry: any) => {
    const anime = animeById.get(entry.relationships?.anime?.data?.id);
    const attrs = anime?.attributes ?? {};
    return {
      title: attrs.canonicalTitle ?? 'Unknown',
      poster: attrs.posterImage?.small ?? '',
      progress: entry.attributes?.progress ?? 0,
    };
  });

  return {
    slug,
    animeCompleted: consumed.completed ?? 0,
    animeMinutesWatched: Math.round((consumed.time ?? 0) / 60),
    episodesWatched: consumed.units ?? 0,
    currentlyWatching,
  };
}
