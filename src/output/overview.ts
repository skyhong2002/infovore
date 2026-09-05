import type { SourceSnapshot } from '../data/types.js';
import type { HealthConnectSnapshot } from '../health/types.js';
import type { DayflowSnapshot } from '../dayflow/types.js';
import { taipeiDay } from '../data/time.js';
import { timeAmount } from './pages.js';

export interface PlatformOverview { source: string; image: string; title: string; detail: string }
export function platformOverview(source: string, image: string, snapshot: SourceSnapshot<unknown> | null | undefined, now = new Date()): PlatformOverview {
  const result = (title: string, detail: string, art = image) => ({ source, image: art, title, detail });
  if (!snapshot) return result('Waiting for sync', 'Platform summary will appear after syncing.');
  const stats = snapshot.stats;
  const count = (key: string) => typeof stats[key] === 'number' ? stats[key].toLocaleString('en') : '—';
  const extra = (snapshot.extra ?? {}) as Record<string, unknown>;
  const top = (key: string) => (extra[key] as Array<{ name: string; image?: string; thumbnailUrl?: string }> | undefined)?.[0];
  const current = snapshot.entries.filter(entry => entry.visibility !== 'private' && entry.visibility !== 'summary'
    && ['current', 'reading', 'watching', 'playing'].includes(entry.status ?? ''));
  if (source === 'dayflow') {
    const pools = (snapshot as DayflowSnapshot).extra.keywordPools;
    const topics = pools?.distinctive.slice(0, 3).map(k => k.name).join(' · ');
    return result(`${count('weeklyActiveHours')}h active this week`, topics ? `Distinctive lately: ${topics}` : `${count('recordedDays')} recorded days`);
  }
  if (source === 'statsfm') {
    const artist = top('topArtists');
    return result(artist ? `Top artist: ${artist.name}` : `${count('weeklyStreams')} weekly listens`,
      `${count('weeklyMinutes')} min · ${count('weeklyUniqueArtists')} artists · weekly summary`, artist?.image || image);
  }
  if (source === 'health') {
    const today = taipeiDay(now), from = taipeiDay(new Date(+now - 6 * 86400000));
    const days = (snapshot as HealthConnectSnapshot).extra.sleep?.days.filter(day => day.day >= from && day.day <= today && day.sessionSeconds > 0) ?? [];
    return days.length ? result(`${timeAmount(days.reduce((sum, day) => sum + day.sessionSeconds, 0) / days.length)} average sleep`,
      `Recent 7 days · ${days.length} recorded days · session duration`) : result('No sleep records in recent 7 days', 'Sleep averages appear as records arrive.');
  }
  if (source === 'youtube') {
    const channel = top('topChannels');
    return result(channel ? `Top channel: ${channel.name}` : `${count('uniqueVideos')} videos in 28 days`,
      `${count('watchEvents')} watches · ${count('uniqueChannels')} channels · recent 28 days`, channel?.thumbnailUrl || image);
  }
  if (source === 'goodreads') return result(current[0] ? `Reading: ${current[0].title}` : `${count('readCount')} books read`,
    `${count('currentlyReadingCount')} reading · ${count('toReadCount')} to read`, current[0]?.image || image);
  if (source === 'kitsu') return result(current.length ? `${current.length} in progress in synced library` : `${count('animeCompleted')} anime completed`,
    `${count('animeEpisodes')} episodes · ${count('mangaChapters')} manga chapters · lifetime`);
  if (source === 'simkl') return result(`${count('showsWatching')} shows in progress`,
    `${count('moviesCompleted')} movies · ${count('showsCompleted')} shows completed`);
  if (source === 'backloggd') return result(`${count('playedThisYear')} games played this year`,
    `${count('gamesPlayed')} played · ${count('backlog')} in backlog`);
  if (source === 'events') {
    const upcoming = snapshot.entries.filter(entry => ['upcoming', 'ticketed'].includes(entry.status ?? '')
      && Date.parse(entry.activityAt) >= +now).sort((a, b) => Date.parse(a.activityAt) - Date.parse(b.activityAt));
    return upcoming[0] ? result(`Next: ${upcoming[0].title}`, `${taipeiDay(upcoming[0].activityAt)} · ${upcoming.length} upcoming`, upcoming[0].image || image)
      : result(`${count('attended')} events attended`, 'No upcoming events scheduled');
  }
  return result('Platform summary', 'Explore your library and statistics.');
}
