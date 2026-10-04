import { z } from 'zod';
import type { SourceSnapshot } from '../data/types.js';
import { taipeiDay } from '../data/time.js';

const timestamp = z.string().datetime({ offset: true });
const share = z.number().finite().min(0).max(100);

// ComputAI's own card JSON also carries spend, plan value, rank and badges. The
// sync client sends none of them, and zod drops any unknown key, so only these
// aggregates are ever stored.
export const computaiReportSchema = z.object({
  schemaVersion: z.literal(1),
  deviceId: z.string().regex(/^[a-zA-Z0-9._-]{1,100}$/),
  observedAt: timestamp,
  period: z.literal('30d'),
  tokens: z.number().int().nonnegative(),
  agentHours: z.number().finite().nonnegative().max(100_000),
  peakParallel: z.number().int().nonnegative().max(1000),
  cacheHitPct: share,
  fleet: z.array(z.object({ source: z.string().regex(/^[a-z0-9-]{1,40}$/), pct: share })).max(10),
  models: z.array(z.object({ model: z.string().min(1).max(80), sharePct: share })).max(10),
  // Tokens per day, oldest first; the last value is the reporting day so far.
  daily: z.array(z.number().finite().nonnegative()).min(1).max(31),
}).superRefine((v, ctx) => {
  if (Date.parse(v.observedAt) > Date.now() + 300_000) ctx.addIssue({ code: 'custom', message: 'Observation is in the future' });
});

export type ComputaiReport = z.infer<typeof computaiReportSchema>;

export function compactNumber(n: number): string {
  for (const [size, unit] of [[1e9, 'B'], [1e6, 'M'], [1e3, 'k']] as const) if (n >= size) return `${(n / size).toFixed(1)}${unit}`;
  return String(Math.round(n));
}
// ComputAI counts days on the Mac's local (Taipei) calendar, ending with the
// reporting day; newest first.
export function dailyTokens(report: Pick<ComputaiReport, 'daily' | 'observedAt'>): Array<{ day: string; tokens: number }> {
  const last = Date.parse(`${taipeiDay(report.observedAt)}T00:00:00Z`);
  return report.daily.map((tokens, i) => ({ tokens, day: new Date(last - (report.daily.length - 1 - i) * 86_400_000).toISOString().slice(0, 10) })).reverse();
}

export type PublicComputaiReport = Omit<ComputaiReport, 'deviceId' | 'schemaVersion'>;
export interface ComputaiExtra { report: PublicComputaiReport | null; lastSyncedAt: string | null }
export type ComputaiSnapshot = SourceSnapshot<ComputaiExtra>;
