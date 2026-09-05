import { createHash } from 'node:crypto';
import { taipeiDay } from './time.js';
import type { Activity, ActivityTimePrecision, MediaEntry } from './types.js';

function canonical(value: string): string {
  return value.trim().toLocaleLowerCase('en-US').replace(/\s+/g, ' ');
}

function parseOccurredAt(value: string): { value: string | null; precision: ActivityTimePrecision } {
  if (!value) return { value: null, precision: 'unknown' };
  const isoDate = /^\d{4}-\d{2}-\d{2}$/;
  const isoDateTime = /^\d{4}-\d{2}-\d{2}T/;
  if (isoDate.test(value) || isoDateTime.test(value)) {
    const parsed = new Date(value);
    if (!Number.isNaN(parsed.getTime())) {
      return { value: parsed.toISOString(), precision: isoDate.test(value) ? 'day' : 'exact' };
    }
  }
  return { value, precision: 'label' };
}

export function activityFromEntry(entry: MediaEntry, seenAt = new Date().toISOString()): Activity {
  const occurred = parseOccurredAt(entry.activityAt);
  // A manually recorded event is one durable item: editing its date or moving
  // it from upcoming to attended updates the same entry. Synced media sources
  // still retain distinct progress/completion moments.
  const identity = entry.source === 'events' && entry.sourceItemId
    ? [entry.source, entry.sourceItemId]
    : entry.sourceItemId
    ? [entry.source, entry.sourceItemId, entry.activityAt, entry.status ?? '']
    : [entry.source, entry.kind, canonical(entry.title), entry.activityAt, entry.status ?? ''];
  const dedupeKey = identity.join('\u001f');
  const id = createHash('sha256').update(dedupeKey).digest('hex');
  return {
    id,
    dedupeKey,
    source: entry.source,
    sourceItemId: entry.sourceItemId ?? null,
    type: `${entry.kind}.${entry.status || 'activity'}`,
    mediaKind: entry.kind,
    title: entry.title,
    image: entry.image,
    status: entry.status || null,
    occurredAt: occurred.value,
    occurredAtPrecision: occurred.precision,
    rating: entry.rating,
    visibility: entry.visibility ?? 'public',
    extra: entry.extra,
    firstSeenAt: seenAt,
    lastSeenAt: seenAt,
  };
}

function activityTaipeiDay(activity: Activity): string {
  return taipeiDay(activity.occurredAt ?? activity.firstSeenAt);
}

/**
 * Keep the homepage representative without changing the underlying archive.
 * Music and YouTube are high-frequency streams. Each gets a small display
 * budget and at most one newest entry per Taipei calendar day.
 */
export function selectHomepageActivities(
  activities: Activity[],
  limit = 40,
  musicShare = 0.1,
  youtubeShare = 0.1,
): Activity[] {
  if (limit < 1) return [];
  const safeMusicShare = Math.max(0, Math.min(0.4, musicShare));
  const safeYoutubeShare = Math.max(0, Math.min(0.4, youtubeShare));
  const isMusic = (activity: Activity) => activity.mediaKind === 'music';
  const isYoutube = (activity: Activity) => activity.source === 'youtube';
  const musicAvailable = activities.some(isMusic);
  const youtubeAvailable = activities.some(isYoutube);
  const regularAvailable = activities.filter((activity) => !isMusic(activity) && !isYoutube(activity)).length;
  const activeHighShare = (musicAvailable ? safeMusicShare : 0)
    + (youtubeAvailable ? safeYoutubeShare : 0);
  const regularShare = Math.max(0.2, 1 - activeHighShare);
  const regularBudget = Math.min(regularAvailable, Math.ceil(limit * regularShare));
  const highBudget = (share: number, available: boolean) => available
    ? Math.max(1, Math.floor(regularBudget * share / regularShare))
    : 0;
  const musicBudget = highBudget(safeMusicShare, musicAvailable);
  const youtubeBudget = highBudget(safeYoutubeShare, youtubeAvailable);
  const seenMusicDays = new Set<string>();
  const seenYoutubeDays = new Set<string>();
  const selected: Activity[] = [];
  let musicCount = 0;
  let youtubeCount = 0;
  let regularCount = 0;
  let healthCount = 0;
  const healthBudget = activities.some((activity) => activity.source !== 'health') ? Math.max(1, Math.floor(limit / 4)) : limit;

  for (const activity of activities) {
    if (activity.source === 'health' && healthCount >= healthBudget) continue;
    if (isMusic(activity)) {
      const day = activityTaipeiDay(activity);
      if (musicCount >= musicBudget || seenMusicDays.has(day)) continue;
      seenMusicDays.add(day);
      musicCount++;
    } else if (isYoutube(activity)) {
      const day = activityTaipeiDay(activity);
      if (youtubeCount >= youtubeBudget || seenYoutubeDays.has(day)) continue;
      seenYoutubeDays.add(day);
      youtubeCount++;
    } else {
      if (regularCount >= regularBudget) continue;
      regularCount++;
    }
    selected.push(activity);
    if (activity.source === 'health') healthCount++;
    if (selected.length >= limit) break;
  }
  return selected;
}
