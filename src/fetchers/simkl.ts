import { config } from '../config.js';

export interface SimklStats {
  userId: string;
  moviesCompleted: number;
  showsWatching: number;
  showsCompleted: number;
  totalMinutes: number;
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

  return {
    userId,
    moviesCompleted: data.movies?.completed?.count ?? 0,
    showsWatching: data.tv?.watching?.count ?? 0,
    showsCompleted: data.tv?.completed?.count ?? 0,
    totalMinutes: data.total_mins ?? 0,
  };
}
