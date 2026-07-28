import { createHash } from 'node:crypto';
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

function taipeiDay(activity: Activity): string {
  const raw = activity.occurredAt ?? activity.firstSeenAt;
  const parsed = new Date(raw);
  if (Number.isNaN(parsed.getTime())) return raw;
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Taipei', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(parsed);
}

/**
 * Keep the homepage representative without changing the underlying archive.
 * Music is the only per-play stream, so it gets a small display budget and at
 * most one (the newest) entry per Taipei calendar day.
 */
export function selectHomepageActivities(
  activities: Activity[],
  limit = 40,
  musicShare = 0.1,
): Activity[] {
  if (limit < 1) return [];
  const safeShare = Math.max(0, Math.min(0.5, musicShare));
  const nonMusicAvailable = activities.filter((activity) => activity.mediaKind !== 'music').length;
  const nonMusicBudget = Math.min(nonMusicAvailable, Math.ceil(limit * (1 - safeShare)));
  const proportionalMusicBudget = nonMusicBudget
    ? Math.floor(nonMusicBudget * safeShare / (1 - safeShare))
    : 1;
  const musicBudget = Math.min(limit - nonMusicBudget, Math.max(1, proportionalMusicBudget));
  const seenMusicDays = new Set<string>();
  const selected: Activity[] = [];
  let musicCount = 0;
  let nonMusicCount = 0;

  for (const activity of activities) {
    if (activity.mediaKind === 'music') {
      const day = taipeiDay(activity);
      if (musicCount >= musicBudget || seenMusicDays.has(day)) continue;
      seenMusicDays.add(day);
      musicCount++;
    } else {
      if (nonMusicCount >= nonMusicBudget) continue;
      nonMusicCount++;
    }
    selected.push(activity);
    if (selected.length >= limit) break;
  }
  return selected;
}
