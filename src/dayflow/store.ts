import { summarizeDay } from './day-summary.js';
import { DayflowQualityStore } from './quality-store.js';
import type { QualityLabels } from './quality.js';
import { dayflowCloudTerms } from './pools.js';
import { activitySnapshot } from './snapshot.js';
import { measureRead } from '../data/read-timing.js';
import { dayflowKeywords } from './keywords.js';
import type { DatabaseSync } from 'node:sqlite';
import { dayflowBatchSchema, dayflowDay, type DayflowBatch, type DayflowDay, type DayflowSnapshot } from './types.js';

export function migrateDayflow(db: DatabaseSync): void {
  db.exec(`BEGIN;
    CREATE TABLE dayflow_days (
      device_id TEXT NOT NULL, day TEXT NOT NULL, observed_at TEXT NOT NULL,
      received_at TEXT NOT NULL, payload_json TEXT NOT NULL, revision INTEGER NOT NULL DEFAULT 1,
      PRIMARY KEY(device_id, day)
    );
    CREATE INDEX dayflow_days_date ON dayflow_days(day DESC);
    PRAGMA user_version = 10;
    COMMIT;`);
}

// Raw activity text stays exclusively in this private table, never snapshots or activities.
export class DayflowStore {
  readonly quality: DayflowQualityStore;
  constructor(private db: DatabaseSync, private useQuality = false) { this.quality = new DayflowQualityStore(db); }
  ingest(input: DayflowBatch, receivedAt = new Date().toISOString()) {
    const batch = dayflowBatchSchema.parse(input);
    const observed = new Date(batch.observedAt).toISOString();
    const result = this.db.prepare(`INSERT INTO dayflow_days (device_id, day, observed_at, received_at, payload_json) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(device_id, day) DO UPDATE SET observed_at=excluded.observed_at,
      received_at=excluded.received_at, payload_json=excluded.payload_json, revision=dayflow_days.revision+1
      WHERE excluded.observed_at > dayflow_days.observed_at`).run(
      batch.deviceId, batch.day, observed, receivedAt, JSON.stringify(batch));
    return { updated: Number(result.changes), day: batch.day, records: batch.cards.length };
  }
  status() {
    const row = this.db.prepare('SELECT MAX(received_at) lastSyncedAt, MIN(day) firstDay, MAX(day) lastDay, COUNT(DISTINCT day) days, COALESCE(SUM(revision), 0) revision FROM dayflow_days').get()!;
    return { lastSyncedAt: row.lastSyncedAt as string | null, firstDay: row.firstDay as string | null, lastDay: row.lastDay as string | null, days: Number(row.days), revision: Number(row.revision) + this.quality.revision() };
  }
  // Distinct recorded days in [fromDay, toDay), across devices.
  dayCount(fromDay = '0000-00-00', toDay = '9999-99-99'): number {
    const row = this.db.prepare('SELECT COUNT(DISTINCT day) days FROM dayflow_days WHERE day >= ? AND day < ?').get(fromDay, toDay) as { days: number };
    return Number(row.days);
  }

  batchesSince(day: string): DayflowBatch[] {
    const rows = this.db.prepare('SELECT payload_json FROM dayflow_days WHERE day >= ? ORDER BY day').all(day) as Array<{ payload_json: string }>;
    return rows.map((row) => JSON.parse(row.payload_json) as DayflowBatch);
  }
  cloudTerms(since: string, now: Date) {
    const batches = this.batchesSince(since);
    const classification = this.useQuality ? this.quality.labelsFor(batches, now) : null;
    return dayflowCloudTerms(batches, now, 2, classification?.hasResults ? classification.get : undefined);
  }
  // Idle time is recorded by Dayflow but is not activity, so the rhythm
  // timeline leaves it unrecorded along with system/error cards.
  recordedIntervals(since: string, now = new Date()) {
    const rows = this.db.prepare('SELECT payload_json FROM dayflow_days WHERE day >= ?').all(since) as Array<{ payload_json: string }>;
    return rows.flatMap(row => {
      const batch = JSON.parse(row.payload_json) as DayflowBatch;
      const boundary = Date.parse(`${batch.day}T04:00:00+08:00`);
      const idle = (card: DayflowBatch['cards'][number]) => card.category.toLowerCase() === 'idle'
        || Boolean(batch.categories.find((c) => c.name === card.category)?.is_idle);
      return batch.cards.filter(card => card.category.toLowerCase() !== 'system'
        && card.subcategory?.toLowerCase() !== 'error' && !idle(card)).map(card => ({ source: 'dayflow',
          start: Math.max(boundary, Date.parse(card.start)),
          end: Math.min(boundary + 86400000, Date.parse(card.end), +now),
        }));
    });
  }
  // The snapshot is rebuilt every minute so today's in-progress totals tick,
  // but only today depends on the clock: past days are a pure function of
  // their stored batches. Parsed batches keep their identity across rebuilds
  // (keyed on the row revision) so past-day summaries and the keyword
  // tokenisation in pools.ts can be reused instead of recomputed each minute.
  private parsed = new Map<string, { revision: number; batch: DayflowBatch }>();
  private summaries = new Map<string, { batches: DayflowBatch[]; summary: DayflowDay }>();

  private loadBatches(): DayflowBatch[] {
    const rows = this.db.prepare('SELECT device_id, day, revision FROM dayflow_days ORDER BY day DESC, device_id')
      .all() as Array<{ device_id: string; day: string; revision: number }>;
    const payload = this.db.prepare('SELECT payload_json FROM dayflow_days WHERE device_id = ? AND day = ?');
    const live = new Set<string>();
    const batches = rows.map((row) => {
      const key = `${row.device_id}\u001f${row.day}`;
      live.add(key);
      const cached = this.parsed.get(key);
      if (cached && cached.revision === Number(row.revision)) return cached.batch;
      const batch = JSON.parse((payload.get(row.device_id, row.day) as { payload_json: string }).payload_json) as DayflowBatch;
      this.parsed.set(key, { revision: Number(row.revision), batch });
      return batch;
    });
    for (const key of this.parsed.keys()) if (!live.has(key)) this.parsed.delete(key);
    return batches;
  }

  private summarize(day: string, batches: DayflowBatch[], now: Date, quality?: QualityLabels): DayflowDay {
    if (quality) return { ...this.summarize(day, batches, now), keywords: dayflowKeywords(batches, now, 10, quality) };
    const cached = this.summaries.get(day);
    if (cached && cached.batches.length === batches.length && cached.batches.every((batch, i) => batch === batches[i])) return cached.summary;
    const summary = summarizeDay(day, batches, now);
    if (day < dayflowDay(now)) this.summaries.set(day, { batches, summary });
    return summary;
  }

  snapshot(owner: string, now = new Date()): DayflowSnapshot {
    return measureRead('dayflow_snapshot', () => this.buildSnapshot(owner, now));
  }

  private buildSnapshot(owner: string, now: Date): DayflowSnapshot {
    const byDay = new Map<string, DayflowBatch[]>();
    for (const batch of this.loadBatches()) {
      if (batch.day > dayflowDay(now)) continue;
      const group = byDay.get(batch.day) ?? []; group.push(batch); byDay.set(batch.day, group);
    }
    const batches = [...byDay.values()].flat();
    const classification = this.useQuality ? this.quality.labelsFor(batches, now) : null;
    const quality = classification?.hasResults ? classification.get : undefined;
    const daily = [...byDay].map(([day, batches]) => this.summarize(day, batches, now, quality));
    return activitySnapshot('dayflow', owner, daily, batches, this.status(), now, quality,
      classification ? { mode: quality ? 'ai' : 'local', classifiedActivities: classification.classified,
        eligibleActivities: classification.eligible, model: classification.model } : undefined);
  }
}

export { summarizeDay } from './day-summary.js';
