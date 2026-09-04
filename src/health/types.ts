import { z } from 'zod';

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

export const healthConnectBatchSchema = z.object({
  syncId: z.string().min(8).max(128),
  deviceId: z.string().min(8).max(128),
  observedAt: isoTimestamp,
  records: z.array(healthRecordSchema).max(250),
  deletedRecordIds: z.array(z.string().min(1).max(256)).max(500),
}).refine((batch) => batch.records.length > 0 || batch.deletedRecordIds.length > 0, {
  message: 'The batch must contain records or deleted record ids',
});

export type HealthConnectRecordInput = z.infer<typeof healthRecordSchema>;
export type HealthConnectBatchInput = z.infer<typeof healthConnectBatchSchema>;

export interface HealthConnectIngestResult {
  inserted: number;
  updated: number;
  deleted: number;
  totalStored: number;
}

export interface HealthConnectStatus {
  totalStored: number;
  lastSyncedAt: string | null;
  lastDeviceId: string | null;
  recordsByType: Record<string, number>;
}
