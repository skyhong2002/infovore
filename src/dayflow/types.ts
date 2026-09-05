import { z } from 'zod';
import type { SourceSnapshot } from '../data/types.js';

export const daySchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine((v) => {
  const d = new Date(v); return Number.isFinite(+d) && d.toISOString().slice(0, 10) === v;
}, 'Invalid calendar day');
const timestamp = z.string().datetime({ offset: true });
const cardSchema = z.object({
  record_id: z.number().int().nonnegative(), start: timestamp, end: timestamp,
  title: z.string().max(4096), summary: z.string().max(32000).optional(),
  category: z.string().min(1).max(200), subcategory: z.string().max(200).optional(),
  apps: z.array(z.string().max(500)).max(100).optional(),
  duration_minutes: z.number().finite().nonnegative().max(2880),
  distraction_count: z.number().int().nonnegative().optional(),
}).refine((v) => Date.parse(v.end) >= Date.parse(v.start) && Date.parse(v.end) - Date.parse(v.start) <= 172800000, 'Invalid activity interval');
export const dayflowBatchSchema = z.object({
  schemaVersion: z.literal(1), deviceId: z.string().regex(/^[a-zA-Z0-9._-]{1,100}$/),
  day: daySchema, observedAt: timestamp,
  timeZone: z.literal('Asia/Taipei'), dayBoundaryHour: z.literal(4),
  categories: z.array(z.object({ name: z.string().min(1).max(200), color_hex: z.string().regex(/^#[0-9a-fA-F]{6}$/), is_idle: z.boolean(), is_system: z.boolean() })).max(100),
  cards: z.array(cardSchema).max(2000),
}).superRefine((v, ctx) => {
  if (new Set(v.cards.map((c) => c.record_id)).size !== v.cards.length) ctx.addIssue({ code: 'custom', message: 'Duplicate activity IDs' });
  if (Date.parse(v.observedAt) > Date.now() + 300000) ctx.addIssue({ code: 'custom', message: 'Observation is in the future' });
  if (v.day > dayflowDay(new Date(v.observedAt))) ctx.addIssue({ code: 'custom', message: 'Cannot sync a future Dayflow day' });
  const start = Date.parse(`${v.day}T04:00:00+08:00`);
  if (v.cards.some((c) => Date.parse(c.end) <= start || Date.parse(c.start) >= start + 86400000)) ctx.addIssue({ code: 'custom', message: 'Activity does not intersect the requested day' });
});
export type DayflowBatch = z.infer<typeof dayflowBatchSchema>;
export interface DayflowCategory { name: string; color: string; minutes: number; idle: boolean }
export interface DayflowDay {
  day: string; trackedMinutes: number; activeMinutes: number; idleMinutes: number; errorMinutes: number;
  categories: DayflowCategory[];
}
export interface DayflowExtra {
  timeZone: 'Asia/Taipei'; dayBoundaryHour: 4; daily: DayflowDay[];
  categories: DayflowCategory[]; lastSyncedAt: string | null;
  firstDay: string | null; lastDay: string | null;
}
export type DayflowSnapshot = SourceSnapshot<DayflowExtra>;
export function dayflowDay(now = new Date()): string {
  return new Date(+now + 4 * 3600000).toISOString().slice(0, 10);
}
