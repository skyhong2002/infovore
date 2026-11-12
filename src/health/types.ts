import { z } from 'zod';
import type { SourceSnapshot } from '../data/types.js';

export const healthDataTypes = [
  'exercise_session',
  'steps',
  'distance',
  'total_calories_burned',
  'heart_rate',
  'sleep_session',
  'weight',
  'body_fat',
] as const;

const isoTimestamp = z.string().datetime({ offset: true });

const healthRecordSchema = z.object({
  id: z.string().min(1).max(256),
  dataType: z.enum(healthDataTypes),
  dataOrigin: z.string().min(1).max(255),
  startTime: isoTimestamp,
  endTime: isoTimestamp,
  lastModifiedTime: isoTimestamp,
  payload: z.record(z.string(), z.unknown()),
}).superRefine((record, context) => {
  if (Date.parse(record.endTime) < Date.parse(record.startTime)) {
    context.addIssue({ code: 'custom', path: ['endTime'], message: 'endTime must not precede startTime' });
  }
});

// Upper bound on the record ids one reconcile window may list; the app splits
// larger windows. Keeps a single request from describing (and so deleting) an
// unbounded range.
export const MAX_RECONCILE_RECORD_IDS = 5000;

// Hard ceiling on what one user-confirmed reconcile window may delete (see
// confirmDelete below). Above it the server always refuses, confirmed or not.
export const MAX_CONFIRMED_RECONCILE_DELETES = 2000;

// A complete read of one data type over [start, end) on the sending device:
// recordIds lists every Health Connect record id the app saw starting in that
// window. The server deletes this device's rows of the type that start in the
// window, end before its end, and are not listed (see Repository.ingestHealthConnect);
// a row reaching the window end or beyond is never deleted by that window.
//
// confirmDelete (optional): the user saw a 409 refusal for this window and
// explicitly confirmed deleting exactly `expected` rows. The deletion limits
// are then lifted only if the window would delete exactly that many rows and no
// more than MAX_CONFIRMED_RECONCILE_DELETES; any other count is refused (409).
const healthReconcileSchema = z.object({
  dataType: z.enum(healthDataTypes),
  start: isoTimestamp,
  end: isoTimestamp,
  recordIds: z.array(z.string().min(1).max(256)).max(MAX_RECONCILE_RECORD_IDS),
  confirmDelete: z.object({
    expected: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  }).strict().optional(),
}).strict().superRefine((window, context) => {
  if (!(Date.parse(window.start) < Date.parse(window.end))) {
    context.addIssue({ code: 'custom', path: ['end'], message: 'reconcile end must be after start' });
  }
});

export const healthConnectBatchSchema = z.object({
  syncId: z.string().min(8).max(128),
  deviceId: z.string().min(8).max(128),
  observedAt: isoTimestamp,
  records: z.array(healthRecordSchema).max(250),
  deletedRecordIds: z.array(z.string().min(1).max(256)).max(500),
  reconcile: healthReconcileSchema.optional(),
}).refine((batch) => batch.records.length > 0 || batch.deletedRecordIds.length > 0 || batch.reconcile !== undefined, {
  message: 'The batch must contain records, deleted record ids, or a reconcile window',
});

export type HealthConnectRecordInput = z.infer<typeof healthRecordSchema>;
export type HealthConnectBatchInput = z.infer<typeof healthConnectBatchSchema>;

export type HealthReconcileInput = z.infer<typeof healthReconcileSchema>;

export interface HealthReconcileResult {
  dataType: string;
  start: string;
  end: string;
  // This device's stored rows of the type inside the window before reconciling.
  checked: number;
  deleted: number;
  // The same sync id was already committed, reconcile included.
  alreadyApplied?: true;
  // The deletion went beyond the automatic limits because the user confirmed it.
  confirmed?: true;
  // With `confirmed`: which source apps the deleted rows came from (see byOrigin).
  byOrigin?: HealthOriginCount[];
}

// How many of the rows a reconcile window deletes (or would delete) came from
// each source app (`data_origin`, a package name). Counts only: no record ids
// or health values. At most MAX_ORIGIN_COUNTS entries, largest first; the rest
// are merged into one `other` entry.
export interface HealthOriginCount {
  origin: string;
  count: number;
}

export const MAX_ORIGIN_COUNTS = 10;
export const OTHER_ORIGINS = 'other';

export function countByOrigin(origins: Iterable<string>, limit = MAX_ORIGIN_COUNTS): HealthOriginCount[] {
  const counts = new Map<string, number>();
  for (const origin of origins) counts.set(origin, (counts.get(origin) ?? 0) + 1);
  const sorted = [...counts].map(([origin, count]) => ({ origin, count }))
    .sort((a, b) => b.count - a.count || (a.origin < b.origin ? -1 : a.origin > b.origin ? 1 : 0));
  if (sorted.length <= limit) return sorted;
  const rest = sorted.slice(limit).reduce((sum, entry) => sum + entry.count, 0);
  return [...sorted.slice(0, limit), { origin: OTHER_ORIGINS, count: rest }];
}

export interface HealthConnectIngestResult {
  inserted: number;
  updated: number;
  deleted: number;
  totalStored: number;
  reconciled?: HealthReconcileResult;
}

// Thrown when a reconcile window would delete an implausible share of the
// stored rows; the whole batch is rolled back and nothing is deleted.
export class HealthReconcileRejected extends Error {
  constructor(readonly wouldDelete: number, readonly checked: number, readonly byOrigin: HealthOriginCount[] = []) {
    super(`Reconcile refused: it would delete ${wouldDelete} of ${checked} stored records in the window`);
    this.name = 'HealthReconcileRejected';
  }
}

export interface HealthConnectStatus {
  totalStored: number;
  lastSyncedAt: string | null;
  lastDeviceId: string | null;
  recordsByType: Record<string, number>;
}

export interface HealthDailySummary {
  day: string;
  steps: number;
  distanceMeters: number;
  kilocalories: number;
  exerciseSeconds: number;
  sleepSeconds: number;
  heartRateAverage: number | null;
  heartRateMinimum: number | null;
  heartRateMaximum: number | null;
}

export interface HealthLatestMeasurements {
  weightKilograms: number | null;
  weightAt: string | null;
  bodyFatPercentage: number | null;
  bodyFatAt: string | null;
}

export type SleepStage = 'awake' | 'asleep' | 'light' | 'deep' | 'rem' | 'unknown';

export interface SleepInterval {
  startTime: string;
  endTime: string;
  stage: SleepStage;
}

export interface SleepSession {
  startTime: string;
  endTime: string;
  sessionSeconds: number;
  segments: SleepInterval[];
  stageSeconds: Record<SleepStage, number>;
  asleepSeconds: number;
  // Only available when the entire session is classified, not a vendor sleep score.
  efficiency: number | null;
}

export interface SleepDay {
  day: string;
  sessionSeconds: number;
  sessions: number;
  intervals: SleepSession[];
}

export interface HealthConnectExtra {
  daily: HealthDailySummary[];
  // Latest positive step days, independent of the recent activity cutoff.
  steps?: { days: Array<{ day: string; steps: number }> };
  exercise?: { days: Array<{ day: string; seconds: number; sessions: number }> };
  sleep?: {
    // Most recent 30 recorded wake-up days, independent of other record types.
    days: SleepDay[];
    totalSessions: number;
  };
  latest: HealthLatestMeasurements;
  coverage: Record<string, number>;
}

export type HealthConnectSnapshot = SourceSnapshot<HealthConnectExtra>;
