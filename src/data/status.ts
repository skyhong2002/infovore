import type { Activity } from './types.js';

// Raw platform statuses grouped by what they mean for the present view.
// Kitsu says `current`, Goodreads `reading`, Simkl `watching`; the queue is
// Kitsu `planned`, Simkl `plantowatch`, Goodreads `to-read`, and Backloggd's
// backlog/wishlist labels should they ever be synced.
export const IN_PROGRESS_STATUSES = new Set(['current', 'reading', 'watching', 'playing']);
export const QUEUED_STATUSES = new Set(['planned', 'plantowatch', 'to-read', 'backlog', 'wishlist']);
export const PAUSED_STATUSES = new Set(['on_hold', 'hold', 'paused']);

// An in-progress item with no progress for this long is paused, not current.
export const STALE_AFTER_DAYS = 60;
// Backloggd has no "playing" status; a game logged this recently counts.
export const PLAYING_WINDOW_DAYS = 14;

const DAY_MS = 86_400_000;

export function isInProgress(status: string | null | undefined): boolean {
  return IN_PROGRESS_STATUSES.has(status ?? '');
}

export function isQueued(status: string | null | undefined): boolean {
  return QUEUED_STATUSES.has(status ?? '');
}

function unique(items: Activity[]): Activity[] {
  const seen = new Set<string>();
  return items.filter((item) => {
    const key = `${item.source}:${item.sourceItemId ?? item.title.trim().toLocaleLowerCase('en-US')}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function occurredMs(activity: Activity): number {
  const parsed = Date.parse(activity.occurredAt ?? '');
  return Number.isFinite(parsed) ? parsed : Date.parse(activity.firstSeenAt);
}

function byMostRecent(a: Activity, b: Activity): number {
  return occurredMs(b) - occurredMs(a);
}

export interface PresentSelection {
  // Touched within STALE_AFTER_DAYS, newest progress first.
  current: Activity[];
  // Still marked in progress upstream, but untouched for longer than that.
  paused: Activity[];
}

// Items being played, watched or read right now. Backloggd games played in
// the last two weeks count as playing even though the site has no such flag.
export function selectCurrent(activities: Activity[], now = new Date(), limit = 12): PresentSelection {
  const staleBefore = now.getTime() - STALE_AFTER_DAYS * DAY_MS;
  const playingSince = now.getTime() - PLAYING_WINDOW_DAYS * DAY_MS;
  const candidates = unique([...activities].sort(byMostRecent).filter((activity) => {
    if (activity.visibility !== 'public') return false;
    if (isInProgress(activity.status) || PAUSED_STATUSES.has(activity.status ?? '')) return true;
    return activity.source === 'backloggd' && activity.mediaKind === 'game' && occurredMs(activity) >= playingSince;
  }));
  const current: Activity[] = [];
  const paused: Activity[] = [];
  for (const activity of candidates) {
    const fresh = occurredMs(activity) >= staleBefore && !PAUSED_STATUSES.has(activity.status ?? '');
    (fresh ? current : paused).push(activity);
  }
  return { current: current.slice(0, limit), paused: paused.slice(0, limit * 2) };
}

// What is lined up next, newest addition first, capped per platform so one
// long watchlist cannot crowd out the others.
export function selectQueued(activities: Activity[], limit = 12, perSource = 6): Activity[] {
  const counts = new Map<string, number>();
  return unique([...activities].sort(byMostRecent).filter((activity) => activity.visibility === 'public' && isQueued(activity.status)))
    .filter((activity) => {
      const count = counts.get(activity.source) ?? 0;
      if (count >= perSource) return false;
      counts.set(activity.source, count + 1);
      return true;
    })
    .slice(0, limit);
}
