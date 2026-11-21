import type { DatabaseSync } from 'node:sqlite';
import { summarizeDay } from '../dayflow/day-summary.js';
import { activitySnapshot } from '../dayflow/snapshot.js';
import type { QualityLabels } from '../dayflow/quality.js';
import { dayflowDay, type DayflowBatch, type DayflowSnapshot } from '../dayflow/types.js';

// Phone activity mirrored from PocketLog (src/pocketlog/sync.ts). Only what the
// public page needs is kept: each activity's interval, its effective category
// and the fixed-vocabulary keywords found in its card (keywords.ts). Card
// titles, summaries, app names and screen content stay in PocketLog.

export function migratePocketlog(db: DatabaseSync): void {
  db.exec(`BEGIN;
    CREATE TABLE IF NOT EXISTS pocketlog_activities (
      id TEXT PRIMARY KEY, start_ms INTEGER NOT NULL, end_ms INTEGER NOT NULL,
      category TEXT NOT NULL, keywords_json TEXT NOT NULL
    ) WITHOUT ROWID;
    CREATE INDEX IF NOT EXISTS pocketlog_activities_start ON pocketlog_activities(start_ms);
    CREATE TABLE IF NOT EXISTS pocketlog_sync (
      id INTEGER PRIMARY KEY CHECK (id = 1), categories_json TEXT NOT NULL DEFAULT '[]', journal_epoch INTEGER,
      last_attempt_at TEXT, last_success_at TEXT, last_full_at TEXT, last_error TEXT, revision INTEGER NOT NULL DEFAULT 0
    );
    INSERT OR IGNORE INTO pocketlog_sync (id) VALUES (1);
    COMMIT;`);
}

export interface PocketlogCategory { id: string; name: string; color: string; idle: boolean }
export interface PocketlogActivity { id: string; start: number; end: number; category: string; keywords: string[] }
export interface PocketlogStatus {
  lastAttemptAt: string | null; lastSuccessAt: string | null; lastFullAt: string | null; lastError: string | null;
  journalEpoch: number | null; revision: number; activities: number;
}

const FALLBACK_COLOR = '#b1a797';

export class PocketlogStore {
  constructor(private db: DatabaseSync) {}

  status(): PocketlogStatus {
    const row = this.db.prepare('SELECT * FROM pocketlog_sync WHERE id = 1').get() as Record<string, unknown>;
    const count = this.db.prepare('SELECT COUNT(*) n FROM pocketlog_activities').get() as { n: number };
    return {
      lastAttemptAt: row.last_attempt_at as string | null, lastSuccessAt: row.last_success_at as string | null,
      lastFullAt: row.last_full_at as string | null, lastError: row.last_error as string | null,
      journalEpoch: row.journal_epoch === null ? null : Number(row.journal_epoch),
      revision: Number(row.revision), activities: Number(count.n),
    };
  }

  categories(): PocketlogCategory[] {
    const row = this.db.prepare('SELECT categories_json FROM pocketlog_sync WHERE id = 1').get() as { categories_json: string };
    return JSON.parse(row.categories_json) as PocketlogCategory[];
  }

  latestStart(): number | null {
    const row = this.db.prepare('SELECT MAX(start_ms) latest FROM pocketlog_activities').get() as { latest: number | null };
    return row.latest === null ? null : Number(row.latest);
  }

  /**
   * Replace the activities overlapping a complete read. Keep the known part
   * of an interval outside the read only when the API clipped it at an edge.
   */
  save(read: { epoch: number; categories: PocketlogCategory[]; activities: PocketlogActivity[]; full: boolean;
    window?: { from: number; to: number; expectedAttempt: string | null } }, at = new Date()): number {
    const stamp = at.toISOString();
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const current = this.status();
      const window = read.window;
      if (window && current.lastAttemptAt !== window.expectedAttempt) throw new Error('PocketLog sync changed during the read');
      if (current.journalEpoch !== null && current.journalEpoch !== read.epoch) this.db.exec('DELETE FROM pocketlog_activities');
      const activities = new Map<string, PocketlogActivity>();
      for (const a of read.activities) {
        const prior = activities.get(a.id);
        activities.set(a.id, prior ? { ...a, start: Math.min(prior.start, a.start), end: Math.max(prior.end, a.end) } : a);
      }
      let changes = 0;
      if (window) {
        const existing = this.db.prepare('SELECT id FROM pocketlog_activities WHERE end_ms > ? AND start_ms < ?').all(window.from, window.to) as Array<{ id: string }>;
        const remove = this.db.prepare('DELETE FROM pocketlog_activities WHERE id = ?');
        for (const { id } of existing) if (!activities.has(id)) changes += Number(remove.run(id).changes);
      }
      const upsert = this.db.prepare(`INSERT INTO pocketlog_activities (id, start_ms, end_ms, category, keywords_json) VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET start_ms = CASE WHEN ? THEN MIN(start_ms, excluded.start_ms) ELSE excluded.start_ms END,
        end_ms = CASE WHEN ? THEN MAX(end_ms, excluded.end_ms) ELSE excluded.end_ms END,
        category = excluded.category, keywords_json = excluded.keywords_json
        WHERE (CASE WHEN ? THEN start_ms > excluded.start_ms ELSE start_ms != excluded.start_ms END)
          OR (CASE WHEN ? THEN end_ms < excluded.end_ms ELSE end_ms != excluded.end_ms END)
          OR category IS NOT excluded.category OR keywords_json IS NOT excluded.keywords_json`);
      for (const a of activities.values()) {
        const clippedStart = Number(!window || a.start === window.from);
        const clippedEnd = Number(!window || a.end === window.to);
        changes += Number(upsert.run(a.id, a.start, a.end, a.category, JSON.stringify(a.keywords),
          clippedStart, clippedEnd, clippedStart, clippedEnd).changes);
      }
      const categories = JSON.stringify(read.categories);
      const changed = changes > 0 || current.journalEpoch !== read.epoch
        || (this.db.prepare('SELECT categories_json FROM pocketlog_sync WHERE id = 1').get() as { categories_json: string }).categories_json !== categories;
      this.db.prepare(`UPDATE pocketlog_sync SET categories_json = ?, journal_epoch = ?, last_attempt_at = ?, last_success_at = ?,
        last_full_at = CASE WHEN ? THEN ? ELSE last_full_at END, last_error = NULL, revision = revision + ? WHERE id = 1`)
        .run(categories, read.epoch, stamp, stamp, read.full ? 1 : 0, stamp, changed ? 1 : 0);
      this.db.exec('COMMIT');
      return changes;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  failed(message: string, at = new Date()): void {
    this.db.prepare('UPDATE pocketlog_sync SET last_attempt_at = ?, last_error = ? WHERE id = 1').run(at.toISOString(), message.slice(0, 200));
  }

  activities(): PocketlogActivity[] {
    return (this.db.prepare('SELECT id, start_ms, end_ms, category, keywords_json FROM pocketlog_activities ORDER BY start_ms').all() as Array<Record<string, unknown>>)
      .map((r) => ({ id: String(r.id), start: Number(r.start_ms), end: Number(r.end_ms), category: String(r.category), keywords: JSON.parse(String(r.keywords_json)) as string[] }));
  }

  /** Non-idle phone activity overlapping [since, now), for the rhythm timeline. */
  recordedIntervals(since: string, now = new Date()): Array<{ source: string; start: number; end: number }> {
    const from = Date.parse(since);
    return (this.db.prepare(`SELECT start_ms, end_ms FROM pocketlog_activities WHERE category != 'idle' AND end_ms > ? AND start_ms < ?`)
      .all(from, +now) as Array<{ start_ms: number; end_ms: number }>)
      .map((r) => ({ source: 'pocketlog', start: Math.max(from, Number(r.start_ms)), end: Math.min(+now, Number(r.end_ms)) }));
  }

  private memo: { key: string; snapshot: DayflowSnapshot } | null = null;

  /** The public projection, in Dayflow's shape so the platform page can share its rendering. */
  snapshot(owner: string, now = new Date()): DayflowSnapshot {
    const status = this.status();
    const key = `${status.revision}:${owner}:${Math.floor(+now / 300_000)}`;
    if (this.memo?.key === key) return this.memo.snapshot;
    const snapshot = buildSnapshot(this.activities(), this.categories(), status, owner, now);
    this.memo = { key, snapshot };
    return snapshot;
  }
}

const DAY_MS = 86_400_000;
const dayStart = (day: string) => Date.parse(`${day}T04:00:00+08:00`);

export function buildSnapshot(activities: PocketlogActivity[], categories: PocketlogCategory[], status: Pick<PocketlogStatus, 'lastSuccessAt'>,
  owner: string, now = new Date()): DayflowSnapshot {
  const known = new Map(categories.map((c) => [c.id, c]));
  const category = (id: string) => known.get(id) ?? { id, name: id, color: FALLBACK_COLOR, idle: id === 'idle' };
  const batchCategories = [...categories, ...[...new Set(activities.map((a) => a.category))].filter((id) => !known.has(id)).map(category)]
    .map((c) => ({ name: c.name, color_hex: c.color, is_idle: c.idle, is_system: false }));
  // Each card's title is a private handle into its keywords; the summary is never filled.
  const labels = new Map<string, string[]>();
  const quality: QualityLabels = (title) => (labels.get(title) ?? []).map((name) => ({ name, kind: 'topic', confidence: 1 }));
  const today = dayflowDay(now);
  const byDay = new Map<string, DayflowBatch>();
  activities.forEach((a, index) => {
    if (a.end <= a.start || a.start > +now) return;
    const title = `pocketlog:${index}`;
    labels.set(title, a.keywords);
    for (let day = dayflowDay(new Date(a.start)); dayStart(day) < a.end && day <= today; day = dayflowDay(new Date(dayStart(day) + DAY_MS))) {
      let batch = byDay.get(day);
      if (!batch) {
        batch = { schemaVersion: 1, deviceId: 'pocketlog', day, observedAt: status.lastSuccessAt ?? now.toISOString(),
          timeZone: 'Asia/Taipei', dayBoundaryHour: 4, categories: batchCategories, cards: [] };
        byDay.set(day, batch);
      }
      batch.cards.push({ record_id: index, start: new Date(a.start).toISOString(), end: new Date(a.end).toISOString(), title,
        category: category(a.category).name, duration_minutes: Math.min(2880, (a.end - a.start) / 60_000) });
    }
  });
  const batches = [...byDay.values()].sort((a, b) => b.day.localeCompare(a.day));
  const daily = batches.map((batch) => summarizeDay(batch.day, [batch], now, quality));
  return activitySnapshot('pocketlog', owner, daily, batches, {
    lastSyncedAt: status.lastSuccessAt, firstDay: batches.at(-1)?.day ?? null, lastDay: batches[0]?.day ?? null,
  }, now, quality);
}
