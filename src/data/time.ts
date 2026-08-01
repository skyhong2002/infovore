// Taipei (UTC+8, no DST) calendar arithmetic shared by homepage day
// bucketing, the time ledger, and calendar-window time stats.
export const TAIPEI_OFFSET_MS = 8 * 60 * 60 * 1000;

export function taipeiDay(value: string | Date): string {
  const parsed = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(parsed.getTime())) return String(value);
  return new Date(parsed.getTime() + TAIPEI_OFFSET_MS).toISOString().slice(0, 10);
}

export interface TaipeiWindowStarts {
  day: Date;
  week: Date;
  month: Date;
  year: Date;
}

// Start instants of the current Taipei calendar day, week (Monday), month,
// and year.
export function taipeiWindowStarts(now: Date): TaipeiWindowStarts {
  const wall = new Date(now.getTime() + TAIPEI_OFFSET_MS);
  const year = wall.getUTCFullYear();
  const month = wall.getUTCMonth();
  const day = wall.getUTCDate();
  const monday = day - ((wall.getUTCDay() + 6) % 7);
  return {
    day: new Date(Date.UTC(year, month, day) - TAIPEI_OFFSET_MS),
    week: new Date(Date.UTC(year, month, monday) - TAIPEI_OFFSET_MS),
    month: new Date(Date.UTC(year, month, 1) - TAIPEI_OFFSET_MS),
    year: new Date(Date.UTC(year, 0, 1) - TAIPEI_OFFSET_MS),
  };
}
