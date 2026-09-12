import { keywordPools } from './pools.js';
import { dayflowKeywords } from './keywords.js';
import type { DatabaseSync } from 'node:sqlite';
import { dayflowBatchSchema, dayflowDay, type DayflowBatch, type DayflowCategory, type DayflowDay, type DayflowSnapshot } from './types.js';

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
  constructor(private db: DatabaseSync) {}
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
    return { lastSyncedAt: row.lastSyncedAt as string | null, firstDay: row.firstDay as string | null, lastDay: row.lastDay as string | null, days: Number(row.days), revision: Number(row.revision) };
  }
  batchesSince(day: string): DayflowBatch[] {
    const rows = this.db.prepare('SELECT payload_json FROM dayflow_days WHERE day >= ? ORDER BY day').all(day) as Array<{ payload_json: string }>;
    return rows.map((row) => JSON.parse(row.payload_json) as DayflowBatch);
  }
  recordedIntervals(since: string, now = new Date()) {
    const rows = this.db.prepare('SELECT payload_json FROM dayflow_days WHERE day >= ?').all(since) as Array<{ payload_json: string }>;
    return rows.flatMap(row => {
      const batch = JSON.parse(row.payload_json) as DayflowBatch;
      const boundary = Date.parse(`${batch.day}T04:00:00+08:00`);
      return batch.cards.filter(card => card.category.toLowerCase() !== 'system'
        && card.subcategory?.toLowerCase() !== 'error').map(card => ({ source: 'dayflow',
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

  private summarize(day: string, batches: DayflowBatch[], now: Date): DayflowDay {
    const cached = this.summaries.get(day);
    if (cached && cached.batches.length === batches.length && cached.batches.every((batch, i) => batch === batches[i])) return cached.summary;
    const summary = summarizeDay(day, batches, now);
    if (day < dayflowDay(now)) this.summaries.set(day, { batches, summary });
    return summary;
  }

  snapshot(owner: string, now = new Date()): DayflowSnapshot {
    const byDay = new Map<string, DayflowBatch[]>();
    for (const batch of this.loadBatches()) {
      if (batch.day > dayflowDay(now)) continue;
      const group = byDay.get(batch.day) ?? []; group.push(batch); byDay.set(batch.day, group);
    }
    const daily = [...byDay].map(([day, batches]) => this.summarize(day, batches, now));
    const today = dayflowDay(now);
    const weekStart = new Date(`${today}T00:00:00Z`);
    weekStart.setUTCDate(weekStart.getUTCDate() - (weekStart.getUTCDay() + 6) % 7);
    const week = daily.filter((d) => d.day >= weekStart.toISOString().slice(0, 10));
    const categories = new Map<string, DayflowCategory>();
    for (const day of week) for (const cat of day.categories) {
      const value = categories.get(cat.name) ?? { ...cat, minutes: 0 };
      value.minutes += cat.minutes; categories.set(cat.name, value);
    }
    const status = this.status();
    return {
      source: 'dayflow', profile: { id: 'dayflow', name: owner, avatar: '/logos/dayflow.png', url: '' },
      stats: { recordedDays: daily.filter((d) => d.trackedMinutes + d.errorMinutes > 0).length,
        todayMinutes: daily.find((d) => d.day === today)?.trackedMinutes ?? 0,
        weeklyHours: Math.round(week.reduce((sum, d) => sum + d.trackedMinutes, 0) / 6) / 10,
        weeklyActiveHours: Math.round(week.reduce((sum, d) => sum + d.activeMinutes, 0) / 6) / 10 },
      entries: daily.filter((d) => d.trackedMinutes > 0).slice(0, 14).map((d) => ({
        source: 'dayflow', sourceItemId: `day:${d.day}`, kind: 'computer', visibility: 'public',
        title: `Computer activity · ${Math.floor(d.trackedMinutes / 60)}h ${Math.round(d.trackedMinutes % 60)}m`,
        image: '/logos/dayflow.png', status: 'daily_summary', activityAt: d.day, rating: null,
        extra: { durationMinutes: d.trackedMinutes, activeMinutes: d.activeMinutes, idleMinutes: d.idleMinutes },
      })),
      extra: { timeZone: 'Asia/Taipei', dayBoundaryHour: 4, daily,
        keywordPools: keywordPools([...byDay.values()].flat(), now),
        keywords: dayflowKeywords([...byDay].filter(([day]) => day >= weekStart.toISOString().slice(0, 10)).flatMap(([, batches]) => batches), now),
        categories: [...categories.values()].sort((a, b) => b.minutes - a.minutes),
        lastSyncedAt: status.lastSyncedAt, firstDay: status.firstDay, lastDay: status.lastDay },
    };
  }
}

export function summarizeDay(day: string, batches: DayflowBatch[], now = new Date()): DayflowDay {
  const start = Date.parse(`${day}T04:00:00+08:00`), end = Math.min(start + 86400000, +now);
  const intervals = batches.flatMap((batch) => batch.cards.map((card) => {
    const category = batch.categories.find((c) => c.name === card.category);
    return { start: Math.max(start, Date.parse(card.start)), end: Math.min(end, Date.parse(card.end)),
      name: card.category, color: category?.color_hex ?? '#94a3b8',
      idle: category?.is_idle ?? card.category.toLowerCase() === 'idle',
      error: card.category.toLowerCase() === 'system' || card.subcategory?.toLowerCase() === 'error' };
  })).filter((i) => i.end > i.start);
  // Partition overlapping intervals once, preferring analyzed activity over errors/idle.
  const points = [...new Set(intervals.flatMap((i) => [i.start, i.end]))].sort((a, b) => a - b);
  const categories = new Map<string, DayflowCategory>();
  let errorMinutes = 0;
  for (let n = 1; n < points.length; n++) {
    const matching = intervals.filter((i) => i.start <= points[n - 1] && i.end >= points[n]);
    matching.sort((a, b) => Number(a.error) - Number(b.error) || Number(a.idle) - Number(b.idle) || b.start - a.start || a.name.localeCompare(b.name));
    const current = matching[0]; if (!current) continue;
    const minutes = (points[n] - points[n - 1]) / 60000;
    if (current.error) { errorMinutes += minutes; continue; }
    const category = categories.get(current.name) ?? { name: current.name, color: current.color, idle: current.idle, minutes: 0 };
    category.minutes += minutes; categories.set(current.name, category);
  }
  const values = [...categories.values()].sort((a, b) => b.minutes - a.minutes);
  const trackedMinutes = values.reduce((sum, c) => sum + c.minutes, 0);
  const idleMinutes = values.filter((c) => c.idle).reduce((sum, c) => sum + c.minutes, 0);
  return { day, trackedMinutes, activeMinutes: trackedMinutes - idleMinutes, idleMinutes, errorMinutes, categories: values, keywords: dayflowKeywords(batches, now, 10) };
}
