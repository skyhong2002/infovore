import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { activityFromEntry } from './activity.js';
import type { Activity, SourceSnapshot } from './types.js';

export interface SyncRun {
  id: number;
  source: string;
  startedAt: string;
  completedAt: string | null;
  status: 'running' | 'success' | 'error';
  entriesSeen: number;
  inserted: number;
  updated: number;
  error: string | null;
}

export interface PersistResult { inserted: number; updated: number }

export class Repository {
  private readonly db: DatabaseSync;

  constructor(path: string) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
    this.migrate();
  }

  close(): void { this.db.close(); }

  private migrate(): void {
    const version = this.db.prepare('PRAGMA user_version').get() as { user_version: number };
    if (version.user_version >= 1) return;
    this.db.exec(`
      BEGIN;
      CREATE TABLE snapshots (
        source TEXT PRIMARY KEY,
        payload_json TEXT,
        fetched_at TEXT,
        error TEXT,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE activities (
        id TEXT PRIMARY KEY,
        dedupe_key TEXT NOT NULL UNIQUE,
        source TEXT NOT NULL,
        source_item_id TEXT,
        type TEXT NOT NULL,
        media_kind TEXT NOT NULL,
        title TEXT NOT NULL,
        image TEXT NOT NULL,
        status TEXT,
        occurred_at TEXT,
        occurred_precision TEXT NOT NULL,
        rating_value REAL,
        rating_scale REAL,
        visibility TEXT NOT NULL CHECK (visibility IN ('public', 'private')),
        extra_json TEXT NOT NULL,
        first_seen_at TEXT NOT NULL,
        last_seen_at TEXT NOT NULL
      );
      CREATE INDEX activities_timeline_idx ON activities(occurred_at DESC, first_seen_at DESC);
      CREATE INDEX activities_source_idx ON activities(source, last_seen_at DESC);
      CREATE TABLE sync_runs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        source TEXT NOT NULL,
        started_at TEXT NOT NULL,
        completed_at TEXT,
        status TEXT NOT NULL CHECK (status IN ('running', 'success', 'error')),
        entries_seen INTEGER NOT NULL DEFAULT 0,
        inserted_count INTEGER NOT NULL DEFAULT 0,
        updated_count INTEGER NOT NULL DEFAULT 0,
        error TEXT
      );
      CREATE INDEX sync_runs_source_idx ON sync_runs(source, started_at DESC);
      PRAGMA user_version = 1;
      COMMIT;
    `);
  }

  startSync(source: string, startedAt = new Date().toISOString()): number {
    const result = this.db.prepare(
      `INSERT INTO sync_runs(source, started_at, status) VALUES (?, ?, 'running')`
    ).run(source, startedAt);
    return Number(result.lastInsertRowid);
  }

  finishSync(id: number, snapshot: SourceSnapshot<unknown>, completedAt = new Date().toISOString()): PersistResult {
    let inserted = 0;
    let updated = 0;
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const exists = this.db.prepare('SELECT 1 FROM activities WHERE id = ?');
      const upsert = this.db.prepare(`
        INSERT INTO activities (
          id, dedupe_key, source, source_item_id, type, media_kind, title, image,
          status, occurred_at, occurred_precision, rating_value, rating_scale,
          visibility, extra_json, first_seen_at, last_seen_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          title=excluded.title, image=excluded.image, status=excluded.status,
          rating_value=excluded.rating_value, rating_scale=excluded.rating_scale,
          extra_json=excluded.extra_json, last_seen_at=excluded.last_seen_at
      `);
      for (const entry of snapshot.entries) {
        const activity = activityFromEntry(entry, completedAt);
        const wasPresent = Boolean(exists.get(activity.id));
        upsert.run(
          activity.id, activity.dedupeKey, activity.source, activity.sourceItemId,
          activity.type, activity.mediaKind, activity.title, activity.image,
          activity.status, activity.occurredAt, activity.occurredAtPrecision,
          activity.rating?.value ?? null, activity.rating?.scale ?? null,
          activity.visibility, JSON.stringify(activity.extra), activity.firstSeenAt, activity.lastSeenAt
        );
        wasPresent ? updated++ : inserted++;
      }
      this.db.prepare(`
        INSERT INTO snapshots(source, payload_json, fetched_at, error, updated_at)
        VALUES (?, ?, ?, NULL, ?)
        ON CONFLICT(source) DO UPDATE SET payload_json=excluded.payload_json,
          fetched_at=excluded.fetched_at, error=NULL, updated_at=excluded.updated_at
      `).run(snapshot.source, JSON.stringify(snapshot), completedAt, completedAt);
      this.db.prepare(`
        UPDATE sync_runs SET completed_at=?, status='success', entries_seen=?,
          inserted_count=?, updated_count=? WHERE id=?
      `).run(completedAt, snapshot.entries.length, inserted, updated, id);
      this.db.exec('COMMIT');
      return { inserted, updated };
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  failSync(id: number, source: string, error: string, completedAt = new Date().toISOString()): void {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.prepare(`UPDATE sync_runs SET completed_at=?, status='error', error=? WHERE id=?`)
        .run(completedAt, error, id);
      this.db.prepare(`
        INSERT INTO snapshots(source, payload_json, fetched_at, error, updated_at)
        VALUES (?, NULL, NULL, ?, ?)
        ON CONFLICT(source) DO UPDATE SET error=excluded.error, updated_at=excluded.updated_at
      `).run(source, error, completedAt);
      this.db.exec('COMMIT');
    } catch (dbError) {
      this.db.exec('ROLLBACK');
      throw dbError;
    }
  }

  loadSnapshots(): Array<{ snapshot: SourceSnapshot<unknown>; fetchedAt: string; error: string | null }> {
    const rows = this.db.prepare(
      'SELECT payload_json, fetched_at, error FROM snapshots WHERE payload_json IS NOT NULL'
    ).all() as Array<{ payload_json: string; fetched_at: string; error: string | null }>;
    return rows.map((row) => ({
      snapshot: JSON.parse(row.payload_json) as SourceSnapshot<unknown>,
      fetchedAt: row.fetched_at,
      error: row.error,
    }));
  }

  listActivities(limit = 100): Activity[] {
    const safeLimit = Math.max(1, Math.min(500, Math.floor(limit)));
    const rows = this.db.prepare(`
      SELECT * FROM activities WHERE visibility='public'
      ORDER BY CASE WHEN occurred_at IS NULL THEN 1 ELSE 0 END, occurred_at DESC, first_seen_at DESC
      LIMIT ?
    `).all(safeLimit) as Record<string, unknown>[];
    return rows.map((row) => ({
      id: String(row.id), dedupeKey: String(row.dedupe_key), source: String(row.source),
      sourceItemId: row.source_item_id === null ? null : String(row.source_item_id),
      type: String(row.type), mediaKind: row.media_kind as Activity['mediaKind'], title: String(row.title),
      image: String(row.image), status: row.status === null ? null : String(row.status),
      occurredAt: row.occurred_at === null ? null : String(row.occurred_at),
      occurredAtPrecision: row.occurred_precision as Activity['occurredAtPrecision'],
      rating: row.rating_value === null ? null : { value: Number(row.rating_value), scale: Number(row.rating_scale) },
      visibility: row.visibility as Activity['visibility'],
      extra: JSON.parse(String(row.extra_json)) as Record<string, string | number>,
      firstSeenAt: String(row.first_seen_at), lastSeenAt: String(row.last_seen_at),
    }));
  }

  countActivities(): number {
    const row = this.db.prepare('SELECT COUNT(*) count FROM activities').get() as { count: number };
    return Number(row.count);
  }

  latestRuns(): SyncRun[] {
    const rows = this.db.prepare(`
      SELECT r.* FROM sync_runs r
      JOIN (SELECT source, MAX(id) id FROM sync_runs GROUP BY source) latest ON latest.id=r.id
      ORDER BY r.source
    `).all() as Record<string, unknown>[];
    return rows.map((r) => ({
      id: Number(r.id), source: String(r.source), startedAt: String(r.started_at),
      completedAt: r.completed_at === null ? null : String(r.completed_at), status: r.status as SyncRun['status'],
      entriesSeen: Number(r.entries_seen), inserted: Number(r.inserted_count), updated: Number(r.updated_count),
      error: r.error === null ? null : String(r.error),
    }));
  }
}
