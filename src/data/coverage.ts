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
export function recordedCoverage(intervals: RecordedInterval[], now = new Date()): CoverageDay[] {
  const today = +taipeiWindowStarts(now).day;
  return Array.from({ length: 7 }, (_, index) => {
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
