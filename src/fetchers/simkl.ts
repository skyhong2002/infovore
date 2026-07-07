import { config } from '../config.js';

export interface SimklStats {
  userId: string;
  moviesCompleted: number;
  showsWatching: number;
  showsCompleted: number;
  totalMinutes: number;
  lastWatched: { title: string; poster: string } | null;
}

// Requires SIMKL_CLIENT_ID (create an app at https://simkl.com/settings/developer/).
export async function fetchSimkl(): Promise<SimklStats> {
  const { userId, clientId } = config.simkl;
  if (!clientId) throw new Error('simkl: SIMKL_CLIENT_ID not set');

  const params = new URLSearchParams({
    client_id: clientId,
    'app-name': 'status.skyhong.tw',
    'app-version': '0.1',
  });
  const res = await fetch(`https://api.simkl.com/users/${userId}/stats?${params}`, {
    headers: { 'User-Agent': 'status.skyhong.tw/0.1' },
  });
  if (!res.ok) throw new Error(`simkl: HTTP ${res.status}`);
  const data: any = await res.json();

  // Public endpoint returning the most recently watched item with its poster.
  let lastWatched: SimklStats['lastWatched'] = null;
  try {
    const bg = await fetch(
      `https://api.simkl.com/users/recently-watched-background/${userId}?client_id=${clientId}`,
      { headers: { 'User-Agent': 'status.skyhong.tw/0.1' } }
    );
    if (bg.ok) {
      const item: any = await bg.json();
      if (item?.title && item?.poster) {
        lastWatched = {
          title: item.title,
          poster: `https://simkl.in/posters/${item.poster}_m.jpg`,
        };
      }
    }
  } catch {
    // Card degrades gracefully without the poster.
  }

  return {
    userId,
    moviesCompleted: data.movies?.completed?.count ?? 0,
    showsWatching: data.tv?.watching?.count ?? 0,
    showsCompleted: data.tv?.completed?.count ?? 0,
    totalMinutes: data.total_mins ?? 0,
    lastWatched,
  };
}
