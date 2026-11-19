import { config } from '../config.js';
import type { MediaEntry, Rating, SourceSnapshot } from '../data/types.js';

const API = 'https://kitsu.app/api/edge';
const headers = { Accept: 'application/vnd.api+json' };
const PAGE_SIZE = 100;
const RECENT_LIMIT = 10;

type KitsuKind = 'anime' | 'manga';

export interface KitsuLibraryEntry {
  id: string;
  title: string;
  image: string;
  thumbnail: string;
  url: string;
  status: string;
  rating: Rating | null;
  progress: number;
  total: number | null;
  progressedAt: string | null;
  addedAt: string | null;
}

export type KitsuLibrary = Record<KitsuKind, KitsuLibraryEntry[]>;

export interface KitsuExtra {
  library: KitsuLibrary;
}

interface KitsuLibraryPage {
  meta: { count: number };
  data: Array<{
    id: string;
    attributes: {
      status: string;
      progress: number;
      ratingTwenty: number | null;
      private: boolean;
      progressedAt: string | null;
      createdAt: string | null;
    };
    relationships?: Partial<Record<KitsuKind, { data?: { id: string } | null }>>;
  }>;
  included?: Array<{
    id: string;
    attributes: {
      titles?: { en?: string };
      canonicalTitle?: string;
      posterImage?: { tiny?: string; small?: string };
      slug?: string;
      episodeCount?: number | null;
      chapterCount?: number | null;
    };
  }>;
}

async function getJson<T>(url: string): Promise<T> {
  const res = await fetch(url, { headers, signal: AbortSignal.timeout(15000) });
  if (!res.ok) throw new Error(`kitsu: HTTP ${res.status} for ${url}`);
  return res.json() as Promise<T>;
}

function parseLibraryPage(doc: KitsuLibraryPage, kind: KitsuKind): KitsuLibraryEntry[] {
  const media = new Map(doc.included?.map((item) => [item.id, item.attributes]));
  return doc.data.filter((item) => item.attributes.private === false).map((item) => {
    const mediaId = item.relationships?.[kind]?.data?.id;
    const attrs = mediaId ? media.get(mediaId) : undefined;
    const { status, progress, ratingTwenty, progressedAt, createdAt } = item.attributes;
    return {
      id: item.id,
      title: attrs?.titles?.en || attrs?.canonicalTitle || 'Unknown',
      image: attrs?.posterImage?.small ?? '',
      thumbnail: attrs?.posterImage?.tiny ?? attrs?.posterImage?.small ?? '',
      url: attrs?.slug ? `https://kitsu.app/${kind}/${encodeURIComponent(attrs.slug)}` : '',
      status,
      rating: ratingTwenty ? { value: ratingTwenty / 2, scale: 10 } : null,
      progress,
      total: (kind === 'anime' ? attrs?.episodeCount : attrs?.chapterCount) ?? null,
      progressedAt,
      addedAt: createdAt,
    };
  });
}

async function fetchLibrary(userId: string, kind: KitsuKind): Promise<KitsuLibraryEntry[]> {
  const params = new URLSearchParams({
    'filter[userId]': userId,
    'filter[kind]': kind,
    include: kind,
    sort: 'id',
    'page[limit]': String(PAGE_SIZE),
    'fields[libraryEntries]': `status,progress,ratingTwenty,private,progressedAt,createdAt,${kind}`,
    [`fields[${kind}]`]: `titles,canonicalTitle,posterImage,slug,${kind === 'anime' ? 'episodeCount' : 'chapterCount'}`,
  });
  const entries: KitsuLibraryEntry[] = [];
  const seen = new Set<string>();
  let count = 0;
  let offset = 0;
  do {
    params.set('page[offset]', String(offset));
    const page = await getJson<KitsuLibraryPage>(`${API}/library-entries?${params}`);
    if (offset === 0) count = page.meta.count;
    if (page.meta.count !== count || page.data.length !== Math.min(PAGE_SIZE, count - offset)) {
      throw new Error(`kitsu: ${kind} library changed during pagination`);
    }
    for (const item of page.data) {
      if (seen.has(item.id)) throw new Error(`kitsu: duplicate ${kind} library entry`);
      seen.add(item.id);
    }
    entries.push(...parseLibraryPage(page, kind));
    offset += page.data.length;
  } while (offset < count);
  return entries;
}

function recentEntries(library: KitsuLibrary, planned: boolean): MediaEntry[] {
  const timestamp = (entry: KitsuLibraryEntry) => Date.parse((planned ? entry.addedAt : entry.progressedAt) ?? '') || 0;
  return (['anime', 'manga'] as const).flatMap((kind) => library[kind]
    .filter((entry) => (entry.status === 'planned') === planned)
    .sort((a, b) => timestamp(b) - timestamp(a))
    .slice(0, RECENT_LIMIT)
    .map((entry): MediaEntry => ({
      sourceItemId: entry.id,
      source: 'kitsu',
      kind,
      title: entry.title,
      image: entry.image,
      status: entry.status,
      activityAt: entry.progressedAt ?? entry.addedAt ?? '',
      rating: entry.rating,
      extra: { progress: entry.progress },
    })));
}

type KitsuUser = { data?: { attributes?: { name?: string; avatar?: { medium?: string; small?: string } } } };
type KitsuStats = { data?: Array<{ attributes: {
  kind: string;
  statsData?: { completed?: number; units?: number; time?: number };
} }> };

export async function fetchKitsu(): Promise<SourceSnapshot<KitsuExtra>> {
  const { userId, slug } = config.kitsu;
  const userUrl = `${API}/users/${encodeURIComponent(userId)}`;
  const [userDoc, statsDoc, animeLibrary, mangaLibrary] = await Promise.all([
    getJson<KitsuUser>(userUrl),
    getJson<KitsuStats>(`${userUrl}/stats`),
    fetchLibrary(userId, 'anime'),
    fetchLibrary(userId, 'manga'),
  ]);

  const user = userDoc.data?.attributes ?? {};
  const stats = new Map(statsDoc.data?.map(({ attributes }) => [attributes.kind, attributes.statsData]));
  const anime = stats.get('anime-amount-consumed') ?? {};
  const manga = stats.get('manga-amount-consumed') ?? {};
  const library = { anime: animeLibrary, manga: mangaLibrary };

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
      // Raw lifetime seconds for the time ledger.
      animeSeconds: anime.time ?? 0,
    },
    entries: [...recentEntries(library, false), ...recentEntries(library, true)],
    extra: { library },
  };
}
