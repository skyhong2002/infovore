import type { SleepDay, SleepInterval, SleepSession, SleepStage } from './types.js';

// Health Connect SleepSessionRecord stage constants. Unrecognised values and
// unclassified gaps must never be counted as sleep or assigned a quality score.
const stageNames: Record<number, SleepStage> = {
  0: 'unknown', 1: 'awake', 2: 'asleep', 3: 'awake',
  4: 'light', 5: 'deep', 6: 'rem', 7: 'awake',
};

export function sleepSession(startTime: string, endTime: string, rawStages: unknown): SleepSession {
  const start = Date.parse(startTime);
  const end = Date.parse(endTime);
  const stages = (Array.isArray(rawStages) ? rawStages : []).flatMap((raw: unknown) => {
    if (!raw || typeof raw !== 'object') return [];
    const value = raw as Record<string, unknown>;
    const from = Math.max(start, typeof value.startTime === 'string' ? Date.parse(value.startTime) : NaN);
    const to = Math.min(end, typeof value.endTime === 'string' ? Date.parse(value.endTime) : NaN);
    if (!Number.isFinite(from) || !Number.isFinite(to) || from >= to) return [];
    const stage: SleepStage = typeof value.stage === 'number' ? stageNames[value.stage] ?? 'unknown' : 'unknown';
    return [{ from, to, stage }];
  });
  const boundaries = [...new Set([start, end, ...stages.flatMap((stage) => [stage.from, stage.to])])].sort((a, b) => a - b);
  const segments: SleepInterval[] = [];
  const stageSeconds: Record<SleepStage, number> = { awake: 0, asleep: 0, light: 0, deep: 0, rem: 0, unknown: 0 };
  for (let i = 1; i < boundaries.length; i++) {
    const from = boundaries[i - 1]!;
    const to = boundaries[i]!;
    if (!(to > from)) continue;
    const active = new Set(stages.filter((stage) => stage.from < to && stage.to > from).map((stage) => stage.stage));
    // Duplicate same-stage spans count once; conflicting stages remain unknown.
    const stage = active.size === 1 ? [...active][0]! : 'unknown';
    stageSeconds[stage] += (to - from) / 1000;
    const previous = segments.at(-1);
    if (previous?.stage === stage) previous.endTime = new Date(to).toISOString();
    else segments.push({ startTime: new Date(from).toISOString(), endTime: new Date(to).toISOString(), stage });
  }
  const sessionSeconds = Math.max(0, (end - start) / 1000);
  const asleepSeconds = stageSeconds.asleep + stageSeconds.light + stageSeconds.deep + stageSeconds.rem;
  return {
    startTime, endTime, sessionSeconds, segments, stageSeconds, asleepSeconds,
    efficiency: sessionSeconds > 0 && stageSeconds.unknown === 0 ? Math.round(asleepSeconds / sessionSeconds * 100) : null,
  };
}

export function sleepDays(rows: Array<{ day: string; start_at: string; end_at: string; stages_json: string | null }>): SleepDay[] {
  const days = new Map<string, SleepDay>();
  for (const row of rows) {
    let stages: unknown = [];
    try { stages = JSON.parse(row.stages_json ?? '[]'); } catch { /* Invalid stages stay unclassified. */ }
    const session = sleepSession(row.start_at, row.end_at, stages);
    const day = days.get(row.day) ?? { day: row.day, sessionSeconds: 0, sessions: 0, intervals: [] };
    day.sessionSeconds += session.sessionSeconds;
    day.sessions++;
    day.intervals.push(session);
    days.set(row.day, day);
  }
  return [...days.values()].sort((a, b) => b.day.localeCompare(a.day)).map((day) => ({
    ...day, intervals: day.intervals.sort((a, b) => Date.parse(a.startTime) - Date.parse(b.startTime)),
  }));
}

// Hour 24 is midnight on the Taipei wake-up day. Do not wrap naps or late wakes.
export function sleepHour(day: string, timestamp: string): number {
  return 24 + (Date.parse(timestamp) - Date.parse(`${day}T00:00:00+08:00`)) / 3_600_000;
}

export function sleepAxis(days: SleepDay[]): { start: number; end: number; ticks: number[] } {
  const starts = days.flatMap((day) => day.intervals.map((session) => sleepHour(day.day, session.startTime)));
  const ends = days.flatMap((day) => day.intervals.map((session) => sleepHour(day.day, session.endTime)));
  const start = Math.floor(Math.min(20, ...starts) / 4) * 4;
  const end = Math.ceil(Math.max(36, ...ends) / 4) * 4;
  return { start, end, ticks: Array.from({ length: end - start + 1 }, (_, i) => start + i) };
}
