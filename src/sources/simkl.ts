import { config } from '../config.js';
import type { MediaEntry, SourceSnapshot } from '../data/types.js';

const API = 'https://api.simkl.com';

function apiHeaders(): Record<string, string> {
  const h: Record<string, string> = {
    'Content-Type': 'application/json',
    'User-Agent': 'infovore/0.1',
    'simkl-api-key': config.simkl.clientId,
  };
  if (config.simkl.accessToken) {
    h['Authorization'] = `Bearer ${config.simkl.accessToken}`;
  }
  return h;
}

async function getJson(path: string): Promise<any> {
  const res = await fetch(`${API}${path}`, { headers: apiHeaders(), signal: AbortSignal.timeout(15000) });
  if (!res.ok) throw new Error(`simkl: HTTP ${res.status} for ${path}`);
  const text = await res.text();
  return text ? JSON.parse(text) : null;
}

function poster(hash: string | undefined): string {
  // _c is the ~170x255 variant — ample for the 84px tile, ~3x smaller than _m.
  return hash ? `https://simkl.in/posters/${hash}_c.jpg` : '';
}

export async function fetchSimkl(): Promise<SourceSnapshot> {
  const { userId, clientId, accessToken } = config.simkl;
  if (!clientId) throw new Error('simkl: SIMKL_CLIENT_ID not set');
  if (!accessToken) throw new Error('simkl: SIMKL_ACCESS_TOKEN not set (run the PIN flow)');

  const params = `?client_id=${clientId}&app-name=infovore&app-version=0.1`;
  const [stats, settings, movies, shows, anime, plannedMovies] = await Promise.all([
    getJson(`/users/${userId}/stats${params}`),
    getJson(`/users/settings`),
    getJson(`/sync/all-items/movies/completed`),
    getJson(`/sync/all-items/shows`),
    getJson(`/sync/all-items/anime`),
    getJson(`/sync/all-items/movies/plantowatch`),
  ]);

  const entries = parseSimklEntries(movies, shows, anime, plannedMovies);

  return {
    source: 'simkl',
    profile: {
      id: userId,
      name: settings?.user?.name ?? `#${userId}`,
      avatar: settings?.user?.avatar ?? '',
      url: `https://simkl.com/${userId}/`,
    },
    stats: {
      moviesCompleted: stats?.movies?.completed?.count ?? 0,
      showsWatching: (stats?.tv?.watching?.count ?? 0) + (stats?.anime?.watching?.count ?? 0),
      showsCompleted: (stats?.tv?.completed?.count ?? 0) + (stats?.anime?.completed?.count ?? 0),
      totalMinutes: stats?.total_mins ?? 0,
    },
    entries,
    extra: {},
  };
}

// Completed items keep no status (their activity is the watch itself);
// `watching` and `plantowatch` are carried so the present view can tell
// what is in progress and what is queued. Queued items date from when they
// were added to the watchlist.
const KEPT_STATUSES = new Set(['watching', 'plantowatch']);

function keptStatus(item: any): string | undefined {
  return KEPT_STATUSES.has(item?.status) ? item.status : undefined;
}

function activityAt(item: any): string {
  return item?.last_watched_at ?? (item?.status === 'plantowatch' ? item?.added_to_watchlist_at ?? '' : '');
}

export function parseSimklEntries(movies: any, shows: any, anime?: any, plannedMovies?: any): MediaEntry[] {
  const movieEntries: MediaEntry[] = [...(movies?.movies ?? []), ...(plannedMovies?.movies ?? [])]
    .filter((m: any) => activityAt(m))
    .sort((a: any, b: any) => activityAt(b).localeCompare(activityAt(a)))
    .map((m: any) => ({
      sourceItemId: String(m.movie?.ids?.simkl ?? m.movie?.ids?.imdb ?? `${m.movie?.title ?? 'unknown'}-${m.movie?.year ?? ''}`),
      source: 'simkl',
      kind: 'movie',
      title: m.movie?.title ?? 'Unknown',
      image: poster(m.movie?.poster),
      status: keptStatus(m),
      activityAt: activityAt(m),
      rating: m.user_rating != null ? { value: m.user_rating, scale: 10 } : null,
      extra: (m.movie?.year ? { year: m.movie.year } : {}) as Record<string, string | number>,
    }));

  // Simkl exposes TV and anime through separate endpoints. Keep the existing
  // card/timeline shape by presenting both as episodic shows.
  const showEntries: MediaEntry[] = [...(shows?.shows ?? []), ...(anime?.anime ?? [])]
    .filter((s: any) => activityAt(s))
    .sort((a: any, b: any) => activityAt(b).localeCompare(activityAt(a)))
    .map((s: any) => {
      const show = s.show ?? s.anime;
      const extra: Record<string, string | number> = {};
      if (show?.year) extra.year = show.year;
      if (s.watched_episodes_count != null) extra.watchedEpisodes = s.watched_episodes_count;
      if (s.total_episodes_count != null) extra.totalEpisodes = s.total_episodes_count;
      if (s.next_to_watch && keptStatus(s)) extra.nextToWatch = s.next_to_watch;
      return {
        sourceItemId: String(show?.ids?.simkl ?? show?.ids?.imdb ?? `${show?.title ?? 'unknown'}-${show?.year ?? ''}`),
        source: 'simkl',
        kind: 'show',
        title: show?.title ?? 'Unknown',
        image: poster(show?.poster),
        status: keptStatus(s),
        activityAt: activityAt(s),
        rating: s.user_rating != null ? { value: s.user_rating, scale: 10 } : null,
        extra,
      };
    });

  return [...movieEntries, ...showEntries];
}
