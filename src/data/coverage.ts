import { taipeiDay, taipeiWindowStarts } from './time.js';

export interface RecordedInterval { source: string; start: number; end: number }
export interface CoverageDay {
  day: string;
  recordedSeconds: number;
  lanes: Array<{ source: string; spans: Array<{ startHour: number; endHour: number }> }>;
}

function merge(intervals: Array<[number, number]>): Array<[number, number]> {
  const result: Array<[number, number]> = [];
  for (const [start, end] of intervals.sort((a, b) => a[0] - b[0])) {
    const last = result.at(-1);
    if (last && start <= last[1]) last[1] = Math.max(last[1], end);
    else result.push([start, end]);
  }
  return result;
}

// Calendar days, always 00:00–24:00 Taipei; overlap counts only once in coverage.
export function recordedCoverage(intervals: RecordedInterval[], now = new Date(), days = 7): CoverageDay[] {
  const today = +taipeiWindowStarts(now).day;
  return Array.from({ length: days }, (_, index) => {
    const start = today - index * 86400000;
    const end = Math.min(start + 86400000, +now);
    const bySource = new Map<string, Array<[number, number]>>();
    for (const interval of intervals) {
      const a = Math.max(start, interval.start), b = Math.min(end, interval.end);
      if (!Number.isFinite(a) || !Number.isFinite(b) || b <= a) continue;
      const spans = bySource.get(interval.source) ?? [];
      spans.push([a, b]); bySource.set(interval.source, spans);
    }
    const merged = merge([...bySource.values()].flat());
    return { day: taipeiDay(new Date(start)),
      recordedSeconds: merged.reduce((sum, [a, b]) => sum + (b - a) / 1000, 0),
      lanes: [...bySource].sort(([a], [b]) => a.localeCompare(b)).map(([source, spans]) => ({ source,
        spans: merge(spans).map(([a, b]) => ({ startHour: (a - start) / 3600000, endHour: (b - start) / 3600000 })),
      })),
    };
  });
}

// Share of the elapsed time in these days that has any recording, with the
// current day counted only up to now. Null until there is a day to measure.
export function recordedShare(days: CoverageDay[], now = new Date()): number | null {
  if (!days.length) return null;
  const today = +taipeiWindowStarts(now).day;
  const elapsed = days.reduce((sum, day) => {
    const start = Date.parse(`${day.day}T00:00:00+08:00`);
    return sum + Math.max(0, Math.min(86400000, +now - start, start >= today ? +now - start : 86400000)) / 1000;
  }, 0);
  if (elapsed <= 0) return null;
  return Math.min(1, days.reduce((sum, day) => sum + day.recordedSeconds, 0) / elapsed);
}
