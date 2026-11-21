import { dayflowKeywords } from './keywords.js';
import { keywordPools } from './pools.js';
import type { QualityLabels } from './quality.js';
import { dayflowDay, type DayflowBatch, type DayflowCategory, type DayflowDay, type DayflowExtra, type DayflowSnapshot } from './types.js';

export function activitySnapshot(
  source: 'dayflow' | 'pocketlog', owner: string, daily: DayflowDay[], batches: DayflowBatch[],
  status: Pick<DayflowExtra, 'lastSyncedAt' | 'firstDay' | 'lastDay'>, now: Date, quality?: QualityLabels,
  keywordQuality?: DayflowExtra['keywordQuality'],
): DayflowSnapshot {
  const today = dayflowDay(now);
  const weekStart = new Date(`${today}T00:00:00Z`);
  weekStart.setUTCDate(weekStart.getUTCDate() - (weekStart.getUTCDay() + 6) % 7);
  const firstWeekDay = weekStart.toISOString().slice(0, 10);
  const week = daily.filter((d) => d.day >= firstWeekDay);
  const categories = new Map<string, DayflowCategory>();
  for (const day of week) for (const cat of day.categories) {
    const value = categories.get(cat.name) ?? { ...cat, minutes: 0 };
    value.minutes += cat.minutes;
    categories.set(cat.name, value);
  }
  const avatar = `/logos/${source}.png`;
  const device = source === 'pocketlog' ? 'Phone' : 'Computer';
  return {
    source, profile: { id: source, name: owner, avatar, url: '' },
    stats: {
      recordedDays: daily.filter((d) => d.trackedMinutes + d.errorMinutes > 0).length,
      todayMinutes: daily.find((d) => d.day === today)?.trackedMinutes ?? 0,
      weeklyHours: Math.round(week.reduce((sum, d) => sum + d.trackedMinutes, 0) / 6) / 10,
      weeklyActiveHours: Math.round(week.reduce((sum, d) => sum + d.activeMinutes, 0) / 6) / 10,
    },
    entries: daily.filter((d) => d.trackedMinutes > 0).slice(0, 14).map((d) => ({
      source, sourceItemId: `day:${d.day}`, kind: 'computer', visibility: 'public',
      title: `${device} activity · ${Math.floor(d.trackedMinutes / 60)}h ${Math.round(d.trackedMinutes % 60)}m`,
      image: avatar, status: 'daily_summary', activityAt: d.day, rating: null,
      extra: { durationMinutes: d.trackedMinutes, activeMinutes: d.activeMinutes, idleMinutes: d.idleMinutes },
    })),
    extra: {
      timeZone: 'Asia/Taipei', dayBoundaryHour: 4, daily,
      keywordPools: keywordPools(batches, now, quality),
      ...(keywordQuality ? { keywordQuality } : {}),
      keywords: dayflowKeywords(batches.filter((batch) => batch.day >= firstWeekDay), now, 36, quality),
      categories: [...categories.values()].sort((a, b) => b.minutes - a.minutes),
      ...status,
    },
  };
}
