import { activityFromEntry } from '../data/activity.js';
import { taipeiDay, taipeiWindowStarts } from '../data/time.js';
import type { Activity } from '../data/types.js';
import type { TimeWindows } from '../data/database.js';
import type { HealthConnectSnapshot } from './types.js';

// Public dashboard summaries; never persist raw records into the media feed.
export function healthHomepageActivities(snapshot: HealthConnectSnapshot): Activity[] {
  const sleeps = (snapshot.extra.sleep?.days ?? []).flatMap((day) => day.intervals.map((session) => activityFromEntry({
    source: 'health', sourceItemId: `sleep:${session.startTime}:${session.endTime}`, kind: 'fitness',
    title: 'Sleep · 睡眠', image: '/logos/healthconnect.png', status: 'sleep', activityAt: session.endTime,
    rating: null, visibility: 'public', extra: {
      startTime: session.startTime, endTime: session.endTime, sessionSeconds: session.sessionSeconds,
      ...(session.stageSeconds.unknown === session.sessionSeconds ? {} : { asleepSeconds: session.asleepSeconds }),
      partialStages: session.stageSeconds.unknown > 0 ? 1 : 0,
      ...(session.efficiency === null ? {} : { efficiency: session.efficiency }),
      deepSeconds: session.stageSeconds.deep, remSeconds: session.stageSeconds.rem,
    },
  }, session.endTime)));
  const exercise = snapshot.entries.filter((entry) => entry.status === 'workout').map((entry) => activityFromEntry({
    ...entry, image: '/logos/healthconnect.png', visibility: 'public',
    extra: { durationMinutes: entry.extra.durationMinutes, exerciseType: entry.extra.exerciseType },
  }, entry.activityAt));
  const steps = snapshot.extra.daily.filter((day) => day.steps > 0).map((day) => activityFromEntry({
    source: 'health', sourceItemId: `steps:${day.day}`, kind: 'fitness',
    title: `${day.steps.toLocaleString('en')} steps`, image: '/logos/healthconnect.png', status: 'steps',
    activityAt: day.day, rating: null, visibility: 'public', extra: { steps: day.steps },
  }, `${day.day}T00:00:00+08:00`));
  return [...sleeps, ...exercise, ...steps].sort((a, b) => Date.parse(b.occurredAt!) - Date.parse(a.occurredAt!));
}

// Home and Now must use the same live projection. Day-only step totals have no
// clock time; compare their Taipei date, not an invented midnight timestamp.
export function dashboardActivities(media: Activity[], health: HealthConnectSnapshot | null, now: Date): Activity[] {
  const items = [...media.filter((activity) => activity.source !== 'health'), ...(health ? healthHomepageActivities(health) : [])];
  const seen = new Set<string>();
  return items.filter((activity) => {
    if (activity.visibility !== 'public' || seen.has(activity.id)) return false;
    seen.add(activity.id);
    if (!activity.occurredAt) return true;
    if (activity.occurredAtPrecision === 'day') return taipeiDay(activity.occurredAt) <= taipeiDay(now);
    return activity.occurredAtPrecision !== 'exact' || Date.parse(activity.occurredAt) <= +now;
  }).sort((a, b) => Date.parse(b.occurredAt ?? '') - Date.parse(a.occurredAt ?? ''));
}

// Recorded session time (including awake), not time asleep. Merge overlapping
// sessions and clip at calendar boundaries/now rather than counting them twice.
export function recordedSleepWindows(rows: Array<{ start_at: string; end_at: string }>, now: Date): TimeWindows {
  const windows: TimeWindows = { last24h: 0, day: 0, week: 0, month: 0, year: 0, allTime: 0 };
  const starts = taipeiWindowStarts(now);
  const cutoffs = { last24h: now.getTime() - 86_400_000, day: +starts.day, week: +starts.week,
    month: +starts.month, year: +starts.year, allTime: -Infinity };
  const intervals = rows.map((row) => [Date.parse(row.start_at), Math.min(Date.parse(row.end_at), +now)] as const)
    .filter(([start, end]) => Number.isFinite(start) && Number.isFinite(end) && end > start)
    .sort((a, b) => a[0] - b[0]);
  const merged: Array<[number, number]> = [];
  for (const [start, end] of intervals) {
    const last = merged.at(-1);
    if (last && start <= last[1]) last[1] = Math.max(last[1], end);
    else merged.push([start, end]);
  }
  for (const key of Object.keys(windows) as Array<keyof TimeWindows>) {
    windows[key] = Math.round(merged.reduce((sum, [start, end]) => sum + Math.max(0, end - Math.max(start, cutoffs[key])) / 1000, 0));
  }
  return windows;
}
