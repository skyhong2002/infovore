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
  const [stats, settings, movies, shows] = await Promise.all([
    getJson(`/users/${userId}/stats${params}`),
    getJson(`/users/settings`),
    getJson(`/sync/all-items/movies/completed`),
    getJson(`/sync/all-items/shows`),
  ]);

  const recentMovies: MediaEntry[] = (movies?.movies ?? [])
    .filter((m: any) => m.last_watched_at)
    .sort((a: any, b: any) => b.last_watched_at.localeCompare(a.last_watched_at))
    .slice(0, 10)
    .map((m: any) => ({
      source: 'simkl',
      kind: 'movie',
      title: m.movie?.title ?? 'Unknown',
      image: poster(m.movie?.poster),
      activityAt: m.last_watched_at,
      rating: m.user_rating != null ? { value: m.user_rating, scale: 10 } : null,
      extra: m.movie?.year ? { year: m.movie.year } : {},
    }));

  const recentShows: MediaEntry[] = (shows?.shows ?? [])
    .filter((s: any) => s.last_watched_at)
    .sort((a: any, b: any) => b.last_watched_at.localeCompare(a.last_watched_at))
    .slice(0, 10)
    .map((s: any) => {
      const extra: Record<string, string | number> = {};
      if (s.show?.year) extra.year = s.show.year;
      if (s.watched_episodes_count != null) extra.watchedEpisodes = s.watched_episodes_count;
      if (s.total_episodes_count != null) extra.totalEpisodes = s.total_episodes_count;
      return {
        source: 'simkl',
        kind: 'show',
        title: s.show?.title ?? 'Unknown',
        image: poster(s.show?.poster),
        activityAt: s.last_watched_at,
        rating: s.user_rating != null ? { value: s.user_rating, scale: 10 } : null,
        extra,
      };
    });

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
      showsWatching: stats?.tv?.watching?.count ?? 0,
      showsCompleted: stats?.tv?.completed?.count ?? 0,
      totalMinutes: stats?.total_mins ?? 0,
    },
    entries: [...recentMovies, ...recentShows],
    extra: {},
  };
}
