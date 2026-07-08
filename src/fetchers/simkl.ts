import { config } from '../config.js';

export interface SimklItem {
  title: string;
  poster: string;
  year: number | null;
  watchedAt: string; // ISO date
  rating: number | null; // user rating out of 10
  // Shows only: watched/total episode progress.
  watchedEpisodes?: number;
  totalEpisodes?: number;
}

export interface SimklStats {
  userId: string;
  name: string;
  avatar: string;
  moviesCompleted: number;
  showsWatching: number;
  showsCompleted: number;
  totalMinutes: number;
  recentMovies: SimklItem[];
  recentShows: SimklItem[];
}

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

export async function fetchSimkl(): Promise<SimklStats> {
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

  const recentMovies: SimklItem[] = (movies?.movies ?? [])
    .filter((m: any) => m.last_watched_at)
    .sort((a: any, b: any) => b.last_watched_at.localeCompare(a.last_watched_at))
    .slice(0, 10)
    .map((m: any) => ({
      title: m.movie?.title ?? 'Unknown',
      poster: poster(m.movie?.poster),
      year: m.movie?.year ?? null,
      watchedAt: m.last_watched_at,
      rating: m.user_rating ?? null,
    }));

  const recentShows: SimklItem[] = (shows?.shows ?? [])
    .filter((s: any) => s.last_watched_at)
    .sort((a: any, b: any) => b.last_watched_at.localeCompare(a.last_watched_at))
    .slice(0, 10)
    .map((s: any) => ({
      title: s.show?.title ?? 'Unknown',
      poster: poster(s.show?.poster),
      year: s.show?.year ?? null,
      watchedAt: s.last_watched_at,
      rating: s.user_rating ?? null,
      watchedEpisodes: s.watched_episodes_count ?? undefined,
      totalEpisodes: s.total_episodes_count ?? undefined,
    }));

  return {
    userId,
    name: settings?.user?.name ?? `#${userId}`,
    avatar: settings?.user?.avatar ?? '',
    moviesCompleted: stats?.movies?.completed?.count ?? 0,
    showsWatching: stats?.tv?.watching?.count ?? 0,
    showsCompleted: stats?.tv?.completed?.count ?? 0,
    totalMinutes: stats?.total_mins ?? 0,
    recentMovies,
    recentShows,
  };
}
