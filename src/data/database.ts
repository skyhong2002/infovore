import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { activityFromEntry } from './activity.js';
import { taipeiDay, taipeiWindowStarts } from './time.js';
import type { Activity, SourceSnapshot } from './types.js';
import type {
  YoutubeChannelMetadata,
  YoutubeChannelSummary,
  YoutubeChannelTrendFrame,
  YoutubeDashboardData,
  YoutubeHistoryStatus,
  YoutubeCapturedWatch,
  YoutubeCaptureResult,
  YoutubeImportResult,
  YoutubeOAuthCredential,
  YoutubeParsedArchive,
  YoutubeProgressBatchInput,
  YoutubeProgressImportResult,
  YoutubeRange,
  YoutubeTopic,
  YoutubeVideoMetadata,
} from '../youtube/types.js';
import { extractYoutubeKeywords } from '../youtube/keywords.js';
import { progressSeconds } from '../youtube/progress.js';

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

export interface ActivityQuery {
  limit?: number;
  offset?: number;
  source?: string;
  kind?: string;
  status?: string;
  query?: string;
  since?: string;
  until?: string;
}

export interface ActivityPage {
  data: Activity[];
  total: number;
  limit: number;
  offset: number;
}

export interface WrappedSummary {
  year: number;
  totalActivities: number;
  bySource: Record<string, number>;
  byKind: Record<string, number>;
  topTitles: Array<{ title: string; kind: string; count: number }>;
  averageRating: number | null;
  firstActivityAt: string | null;
  lastActivityAt: string | null;
}

export type TimeMethod = 'measured' | 'estimated' | 'unavailable';

// Seconds per window. `last24h` rolls; the rest are Taipei calendar windows.
export interface TimeWindows {
  last24h: number;
  day: number;
  week: number;
  month: number;
  year: number;
  allTime: number;
}

export interface SourceTimeSpent {
  source: string;
  method: TimeMethod;
  windows: TimeWindows;
}

export interface TimeSpentSummary {
  generatedAt: string;
  sources: SourceTimeSpent[];
  total: TimeWindows;
  measuredTotal: TimeWindows;
}

function youtubeCutoff(range: YoutubeRange, now: Date): string | null {
  if (range === 'all') return null;
  const days = Number.parseInt(range, 10);
  return new Date(now.getTime() - days * 86_400_000).toISOString();
}

// Shared by youtubeDashboard() and timeSpent(). Per-event watch seconds: the
// measured value when the extension captured one, zero when a measured event
// for the same video sits within five minutes (a duplicate sighting of the
// same session), otherwise the gap to the next watch/search event capped at
// the video length.
const YOUTUBE_ESTIMATED_EVENTS_CTE = `
      WITH timeline AS (
        SELECT 'watch' kind, event_id, watched_at occurred_at
        FROM youtube_watch_events WHERE activity_type='video'
        UNION ALL
        SELECT 'search' kind, event_id, searched_at occurred_at
        FROM youtube_search_events
      ), ordered AS (
        SELECT kind, event_id, occurred_at,
          LEAD(occurred_at) OVER (ORDER BY occurred_at, kind, event_id) next_activity_at
        FROM timeline
      ), estimated_events AS (
        SELECT w.*,
          CASE
            WHEN w.actual_watched_seconds IS NOT NULL THEN w.actual_watched_seconds
            WHEN EXISTS (
              SELECT 1 FROM youtube_watch_events measured
              WHERE measured.video_id=w.video_id
                AND measured.actual_watched_seconds IS NOT NULL
                AND ABS((julianday(measured.watched_at)-julianday(w.watched_at))*86400)<=300
            ) THEN 0
            WHEN v.duration_seconds IS NULL OR o.next_activity_at IS NULL THEN 0
            ELSE MIN(
              v.duration_seconds,
              MAX(0, CAST((julianday(o.next_activity_at)-julianday(w.watched_at))*86400 AS INTEGER))
            )
          END estimated_watch_seconds
        FROM youtube_watch_events w
        JOIN ordered o ON o.kind='watch' AND o.event_id=w.event_id
        LEFT JOIN youtube_videos v ON v.video_id=w.video_id
        WHERE w.activity_type='video'
      )
    `;

// Estimation rates for sources with schedules or page counts instead of
// measured durations.
const EVENT_DEFAULT_SECONDS = 2 * 3600; // attended event with no scheduled end time
const SECONDS_PER_PAGE = 120;           // ~30 pages/hour reading pace

// Backloggd playtime labels ("2h 30m", "45m") → minutes.
function playtimeMinutes(label: unknown): number | null {
  if (typeof label !== 'string' || !label) return null;
  const hoursMatch = label.match(/(\d+)\s*h/);
  const minutesMatch = label.match(/(\d+)\s*m/);
  if (!hoursMatch && !minutesMatch) return null;
  return (hoursMatch ? Number(hoursMatch[1]) * 60 : 0) + (minutesMatch ? Number(minutesMatch[1]) : 0);
}

// Lifetime totals the delta-based time ledger can watch. Only sources whose
// platform reports a cumulative time figure but no per-session durations.
function ledgerLifetimeSeconds(snapshot: SourceSnapshot<unknown>): number | null {
  const stats = snapshot.stats ?? {};
  const value = snapshot.source === 'simkl'
    ? Number(stats.totalMinutes) * 60
    : snapshot.source === 'kitsu'
      ? Number(stats.animeSeconds)
      : NaN;
  return Number.isFinite(value) ? Math.max(0, Math.round(value)) : null;
}

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
    if (version.user_version < 1) {
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
        visibility TEXT NOT NULL CHECK (visibility IN ('public', 'summary', 'private')),
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
    const current = this.db.prepare('PRAGMA user_version').get() as { user_version: number };
    if (current.user_version < 2) this.migrateYoutube();
    const afterYoutube = this.db.prepare('PRAGMA user_version').get() as { user_version: number };
    if (afterYoutube.user_version < 3) this.migrateYoutubeActivityTypes();
    const afterActivityTypes = this.db.prepare('PRAGMA user_version').get() as { user_version: number };
    if (afterActivityTypes.user_version < 4) this.migrateYoutubeChannels();
    const afterYoutubeChannels = this.db.prepare('PRAGMA user_version').get() as { user_version: number };
    if (afterYoutubeChannels.user_version < 5) this.migrateYoutubeProgress();
    const afterYoutubeProgress = this.db.prepare('PRAGMA user_version').get() as { user_version: number };
    if (afterYoutubeProgress.user_version < 6) this.migrateYoutubeExtensionImports();
    const afterExtensionImports = this.db.prepare('PRAGMA user_version').get() as { user_version: number };
    if (afterExtensionImports.user_version < 7) this.migrateTimeLedger();
  }

  private migrateYoutube(): void {
    const activitiesSql = (this.db.prepare(
      "SELECT sql FROM sqlite_master WHERE type='table' AND name='activities'"
    ).get() as { sql: string }).sql;
    this.db.exec('BEGIN');
    try {
      if (!activitiesSql.includes("'summary'")) {
        this.db.exec(`
          DROP INDEX activities_timeline_idx;
          DROP INDEX activities_source_idx;
          ALTER TABLE activities RENAME TO activities_v1;
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
            visibility TEXT NOT NULL CHECK (visibility IN ('public', 'summary', 'private')),
            extra_json TEXT NOT NULL,
            first_seen_at TEXT NOT NULL,
            last_seen_at TEXT NOT NULL
          );
          INSERT INTO activities SELECT * FROM activities_v1;
          DROP TABLE activities_v1;
          CREATE INDEX activities_timeline_idx ON activities(occurred_at DESC, first_seen_at DESC);
          CREATE INDEX activities_source_idx ON activities(source, last_seen_at DESC);
        `);
      }
      this.db.exec(`
        CREATE TABLE youtube_imports (
          archive_hash TEXT PRIMARY KEY,
          source TEXT NOT NULL CHECK (source IN ('takeout', 'dataportability')),
          imported_at TEXT NOT NULL,
          watches_seen INTEGER NOT NULL,
          watches_inserted INTEGER NOT NULL,
          searches_seen INTEGER NOT NULL,
          searches_inserted INTEGER NOT NULL
        );
        CREATE TABLE youtube_videos (
          video_id TEXT PRIMARY KEY,
          title TEXT NOT NULL,
          channel_id TEXT,
          channel_title TEXT,
          description TEXT NOT NULL DEFAULT '',
          tags_json TEXT NOT NULL DEFAULT '[]',
          thumbnail_url TEXT NOT NULL DEFAULT '',
          duration_seconds INTEGER,
          published_at TEXT,
          category_id TEXT,
          availability TEXT NOT NULL DEFAULT 'unknown'
            CHECK (availability IN ('unknown', 'available', 'unavailable')),
          metadata_hash TEXT NOT NULL DEFAULT '',
          metadata_fetched_at TEXT
        );
        CREATE TABLE youtube_watch_events (
          event_id TEXT PRIMARY KEY,
          activity_id TEXT NOT NULL UNIQUE REFERENCES activities(id) ON DELETE CASCADE,
          video_id TEXT REFERENCES youtube_videos(video_id),
          watched_at TEXT NOT NULL,
          raw_title TEXT NOT NULL,
          raw_url TEXT NOT NULL,
          channel_id TEXT,
          channel_title TEXT,
          channel_url TEXT,
          actual_watched_seconds INTEGER,
          imported_at TEXT NOT NULL
        );
        CREATE INDEX youtube_watch_time_idx ON youtube_watch_events(watched_at DESC);
        CREATE INDEX youtube_watch_video_idx ON youtube_watch_events(video_id, watched_at DESC);
        CREATE TABLE youtube_search_events (
          event_id TEXT PRIMARY KEY,
          searched_at TEXT NOT NULL,
          query_ciphertext TEXT NOT NULL,
          imported_at TEXT NOT NULL
        );
        CREATE INDEX youtube_search_time_idx ON youtube_search_events(searched_at DESC);
        CREATE TABLE youtube_topics (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          taxonomy_version INTEGER NOT NULL,
          slug TEXT NOT NULL,
          name TEXT NOT NULL,
          description TEXT NOT NULL,
          created_at TEXT NOT NULL,
          UNIQUE(taxonomy_version, slug)
        );
        CREATE TABLE youtube_video_topics (
          video_id TEXT NOT NULL REFERENCES youtube_videos(video_id) ON DELETE CASCADE,
          topic_id INTEGER NOT NULL REFERENCES youtube_topics(id) ON DELETE CASCADE,
          rank INTEGER NOT NULL CHECK (rank BETWEEN 1 AND 3),
          confidence REAL NOT NULL,
          model TEXT NOT NULL,
          prompt_version TEXT NOT NULL,
          metadata_hash TEXT NOT NULL,
          classified_at TEXT NOT NULL,
          PRIMARY KEY(video_id, topic_id)
        );
        CREATE INDEX youtube_video_topics_rank_idx ON youtube_video_topics(topic_id, rank);
        CREATE TABLE youtube_oauth (
          id INTEGER PRIMARY KEY CHECK (id=1),
          encrypted_refresh_token TEXT NOT NULL,
          expires_at TEXT,
          scope TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
        CREATE TABLE youtube_oauth_states (
          state TEXT PRIMARY KEY,
          expires_at TEXT NOT NULL,
          used_at TEXT
        );
        CREATE TABLE youtube_sync_state (
          key TEXT PRIMARY KEY,
          value TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
        PRAGMA user_version = 2;
        COMMIT;
      `);
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  private migrateYoutubeActivityTypes(): void {
    this.db.exec(`
      BEGIN;
      ALTER TABLE youtube_watch_events ADD COLUMN activity_type TEXT NOT NULL DEFAULT 'video'
        CHECK (activity_type IN ('video', 'post', 'other'));
      ALTER TABLE youtube_search_events ADD COLUMN activity_type TEXT NOT NULL DEFAULT 'search'
        CHECK (activity_type IN ('search', 'visit', 'other'));
      PRAGMA user_version = 3;
      COMMIT;
    `);
  }

  private migrateYoutubeChannels(): void {
    this.db.exec(`
      BEGIN;
      CREATE TABLE IF NOT EXISTS youtube_channels (
        channel_id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        thumbnail_url TEXT NOT NULL,
        metadata_fetched_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS youtube_channels_fetched_idx ON youtube_channels(metadata_fetched_at);
      PRAGMA user_version = 4;
      COMMIT;
    `);
  }

  private migrateYoutubeProgress(): void {
    this.db.exec(`
      BEGIN;
      CREATE TABLE youtube_progress_imports (
        scan_id TEXT PRIMARY KEY,
        observed_at TEXT NOT NULL,
        started_at TEXT NOT NULL,
        completed_at TEXT
      );
      CREATE TABLE youtube_video_progress (
        video_id TEXT PRIMARY KEY REFERENCES youtube_videos(video_id) ON DELETE CASCADE,
        progress_percent REAL,
        resume_seconds INTEGER,
        duration_seconds INTEGER,
        progress_seconds INTEGER,
        confidence TEXT NOT NULL CHECK (confidence IN ('resume', 'progress')),
        observed_at TEXT NOT NULL,
        scan_id TEXT NOT NULL REFERENCES youtube_progress_imports(scan_id)
      );
      CREATE INDEX youtube_video_progress_scan_idx
        ON youtube_video_progress(scan_id, observed_at DESC);
      PRAGMA user_version = 5;
      COMMIT;
    `);
  }

  private migrateYoutubeExtensionImports(): void {
    this.db.exec(`
      BEGIN;
      ALTER TABLE youtube_imports RENAME TO youtube_imports_v5;
      CREATE TABLE youtube_imports (
        archive_hash TEXT PRIMARY KEY,
        source TEXT NOT NULL CHECK (source IN ('takeout', 'dataportability', 'extension')),
        imported_at TEXT NOT NULL,
        watches_seen INTEGER NOT NULL,
        watches_inserted INTEGER NOT NULL,
        searches_seen INTEGER NOT NULL,
        searches_inserted INTEGER NOT NULL
      );
      INSERT INTO youtube_imports SELECT * FROM youtube_imports_v5;
      DROP TABLE youtube_imports_v5;
      PRAGMA user_version = 6;
      COMMIT;
    `);
  }

  private migrateTimeLedger(): void {
    this.db.exec(`
      BEGIN;
      CREATE TABLE time_ledger (
        day TEXT NOT NULL,
        source TEXT NOT NULL,
        seconds INTEGER NOT NULL CHECK (seconds >= 0),
        method TEXT NOT NULL CHECK (method IN ('measured', 'estimated')),
        detail_json TEXT NOT NULL DEFAULT '{}',
        updated_at TEXT NOT NULL,
        PRIMARY KEY (day, source)
      );
      CREATE INDEX time_ledger_source_idx ON time_ledger(source, day DESC);
      CREATE TABLE time_ledger_state (
        source TEXT NOT NULL,
        key TEXT NOT NULL,
        value INTEGER NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (source, key)
      );
      PRAGMA user_version = 7;
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
          dedupe_key=excluded.dedupe_key, type=excluded.type, title=excluded.title,
          image=excluded.image, status=excluded.status,
          occurred_at=excluded.occurred_at, occurred_precision=excluded.occurred_precision,
          rating_value=excluded.rating_value, rating_scale=excluded.rating_scale,
          visibility=excluded.visibility, extra_json=excluded.extra_json,
          last_seen_at=excluded.last_seen_at
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
    return this.queryActivities({ limit }).data;
  }

  queryActivities(query: ActivityQuery = {}): ActivityPage {
    const limit = Math.max(1, Math.min(500, Math.floor(query.limit ?? 100)));
    const offset = Math.max(0, Math.floor(query.offset ?? 0));
    const where = ["visibility='public'"];
    const params: Array<string | number> = [];
    const add = (sql: string, value: string) => { where.push(sql); params.push(value); };
    if (query.source) add('source=?', query.source);
    if (query.kind) add('media_kind=?', query.kind);
    if (query.status) add('status=?', query.status);
    if (query.since) add('occurred_at>=?', query.since);
    if (query.until) add('occurred_at<=?', query.until);
    if (query.query) {
      where.push('(title LIKE ? OR extra_json LIKE ?)');
      params.push(`%${query.query}%`, `%${query.query}%`);
    }
    const clause = where.join(' AND ');
    const totalRow = this.db.prepare(`SELECT COUNT(*) count FROM activities WHERE ${clause}`)
      .get(...params) as { count: number };
    const rows = this.db.prepare(`
      SELECT * FROM activities WHERE ${clause}
      ORDER BY CASE WHEN occurred_precision IN ('exact', 'day') THEN 0 ELSE 1 END,
               occurred_at DESC, first_seen_at DESC
      LIMIT ? OFFSET ?
    `).all(...params, limit, offset) as Record<string, unknown>[];
    return { data: rows.map((row) => this.rowToActivity(row)), total: Number(totalRow.count), limit, offset };
  }

  private rowToActivity(row: Record<string, unknown>): Activity {
    return {
      id: String(row.id), dedupeKey: String(row.dedupe_key), source: String(row.source),
      sourceItemId: row.source_item_id === null ? null : String(row.source_item_id),
      type: String(row.type), mediaKind: row.media_kind as Activity['mediaKind'], title: String(row.title),
      image: String(row.image), status: row.status === null ? null : String(row.status),
      occurredAt: row.occurred_at === null ? null : String(row.occurred_at),
      occurredAtPrecision: row.occurred_precision as Activity['occurredAtPrecision'],
      rating: row.rating_value === null ? null : { value: Number(row.rating_value), scale: Number(row.rating_scale) },
      visibility: row.visibility as Activity['visibility'],
      extra: JSON.parse(String(row.extra_json)) as Activity['extra'],
      firstSeenAt: String(row.first_seen_at), lastSeenAt: String(row.last_seen_at),
    };
  }

  ingestEntries(entries: SourceSnapshot['entries'], seenAt = new Date().toISOString()): PersistResult {
    let inserted = 0;
    let updated = 0;
    const exists = this.db.prepare('SELECT 1 FROM activities WHERE id = ?');
    const upsert = this.db.prepare(`
      INSERT INTO activities (
        id, dedupe_key, source, source_item_id, type, media_kind, title, image,
        status, occurred_at, occurred_precision, rating_value, rating_scale,
        visibility, extra_json, first_seen_at, last_seen_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        dedupe_key=excluded.dedupe_key, type=excluded.type, title=excluded.title,
        image=excluded.image, status=excluded.status,
        occurred_at=excluded.occurred_at, occurred_precision=excluded.occurred_precision,
        rating_value=excluded.rating_value, rating_scale=excluded.rating_scale,
        visibility=excluded.visibility, extra_json=excluded.extra_json,
        last_seen_at=excluded.last_seen_at
    `);
    this.db.exec('BEGIN IMMEDIATE');
    try {
      for (const entry of entries) {
        const activity = activityFromEntry(entry, seenAt);
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
      this.db.exec('COMMIT');
      return { inserted, updated };
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  ingestYoutubeArchive(archive: YoutubeParsedArchive, importedAt = new Date().toISOString()): YoutubeImportResult {
    let watchesInserted = 0;
    let searchesInserted = 0;
    const activityExists = this.db.prepare('SELECT 1 FROM activities WHERE id=?');
    const insertActivity = this.db.prepare(`
      INSERT INTO activities (
        id, dedupe_key, source, source_item_id, type, media_kind, title, image,
        status, occurred_at, occurred_precision, rating_value, rating_scale,
        visibility, extra_json, first_seen_at, last_seen_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        title=excluded.title, image=excluded.image, extra_json=excluded.extra_json,
        last_seen_at=excluded.last_seen_at
    `);
    const insertVideo = this.db.prepare(`
      INSERT INTO youtube_videos (
        video_id, title, channel_id, channel_title, thumbnail_url, duration_seconds
      ) VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(video_id) DO UPDATE SET
        title=CASE WHEN youtube_videos.metadata_fetched_at IS NULL THEN excluded.title ELSE youtube_videos.title END,
        channel_id=COALESCE(youtube_videos.channel_id, excluded.channel_id),
        channel_title=COALESCE(youtube_videos.channel_title, excluded.channel_title),
        thumbnail_url=CASE WHEN youtube_videos.thumbnail_url='' THEN excluded.thumbnail_url ELSE youtube_videos.thumbnail_url END,
        duration_seconds=COALESCE(youtube_videos.duration_seconds, excluded.duration_seconds)
    `);
    const insertWatch = this.db.prepare(`
      INSERT OR IGNORE INTO youtube_watch_events (
        event_id, activity_id, video_id, watched_at, raw_title, raw_url,
        channel_id, channel_title, channel_url, actual_watched_seconds, imported_at, activity_type
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const insertSearch = this.db.prepare(`
      INSERT OR IGNORE INTO youtube_search_events (
        event_id, searched_at, query_ciphertext, imported_at, activity_type
      ) VALUES (?, ?, ?, ?, ?)
    `);
    const watchSecondKeys = new Set(this.db.prepare(`
      SELECT substr(watched_at, 1, 19) watched_second,
        COALESCE(video_id, NULLIF(raw_url, ''), raw_title) identity
      FROM youtube_watch_events
    `).all().map((row) => {
      const value = row as { watched_second: string; identity: string };
      return `${value.watched_second}\u001f${value.identity}`;
    }));
    const searchSeconds = new Set(this.db.prepare(`
      SELECT substr(searched_at, 1, 19) searched_second
      FROM youtube_search_events
    `).all().map((row) => String((row as { searched_second: string }).searched_second)));
    const watchMinuteKeys = new Set(this.db.prepare(`
      SELECT substr(watched_at, 1, 16) watched_minute,
        COALESCE(video_id, NULLIF(raw_url, ''), raw_title) identity
      FROM youtube_watch_events
    `).all().map((row) => {
      const value = row as { watched_minute: string; identity: string };
      return `${value.watched_minute}\u001f${value.identity}`;
    }));

    this.db.exec('BEGIN IMMEDIATE');
    try {
      for (const watch of archive.watches) {
        const identity = watch.videoId ?? (watch.url || watch.title);
        const secondKey = `${watch.watchedAt.slice(0, 19)}\u001f${identity}`;
        const minuteKey = `${watch.watchedAt.slice(0, 16)}\u001f${identity}`;
        // HTML Takeout records omit milliseconds. Match at second precision so
        // importing HTML after JSON does not duplicate the overlapping window.
        const thumbnail = watch.videoId ? `https://i.ytimg.com/vi/${watch.videoId}/hqdefault.jpg` : '';
        if (watch.videoId) {
          insertVideo.run(
            watch.videoId, watch.title, watch.channelId, watch.channelTitle,
            thumbnail, watch.durationSeconds ?? null,
          );
        }
        if (
          watchSecondKeys.has(secondKey)
          || (archive.source === 'extension' && watchMinuteKeys.has(minuteKey))
        ) continue;
        const activity = activityFromEntry({
          source: 'youtube',
          sourceItemId: watch.videoId ?? watch.eventId,
          visibility: 'summary',
          kind: 'video',
          title: watch.title.slice(0, 500),
          image: thumbnail,
          status: watch.activityType === 'video' ? 'watched' : watch.activityType,
          activityAt: watch.watchedAt,
          rating: null,
          extra: {
            channel: watch.channelTitle ?? '',
            channelId: watch.channelId ?? '',
            url: watch.url,
          },
        }, importedAt);
        const wasPresent = Boolean(activityExists.get(activity.id));
        insertActivity.run(
          activity.id, activity.dedupeKey, activity.source, activity.sourceItemId,
          activity.type, activity.mediaKind, activity.title, activity.image,
          activity.status, activity.occurredAt, activity.occurredAtPrecision,
          null, null, activity.visibility, JSON.stringify(activity.extra),
          activity.firstSeenAt, activity.lastSeenAt
        );
        const result = insertWatch.run(
          watch.eventId, activity.id, watch.videoId, watch.watchedAt, watch.title,
          watch.url, watch.channelId, watch.channelTitle, watch.channelUrl,
          watch.actualWatchedSeconds, importedAt, watch.activityType
        );
        if (Number(result.changes) > 0) {
          watchesInserted++;
          watchSecondKeys.add(secondKey);
          watchMinuteKeys.add(minuteKey);
        }
        // A prior interrupted import can leave the generic activity but not the
        // YouTube event. Count only the canonical event insert.
        if (wasPresent && Number(result.changes) === 0) continue;
      }
      for (const search of archive.searches) {
        const searchedSecond = search.searchedAt.slice(0, 19);
        // Search HTML also omits milliseconds. Takeout emits at most one search
        // record per second, so time is the only private-safe cross-format key.
        if (searchSeconds.has(searchedSecond)) continue;
        const result = insertSearch.run(
          search.eventId, search.searchedAt, search.queryCiphertext, importedAt, search.activityType
        );
        if (Number(result.changes) > 0) {
          searchesInserted++;
          searchSeconds.add(searchedSecond);
        }
      }
      this.db.prepare(`
        INSERT OR IGNORE INTO youtube_imports (
          archive_hash, source, imported_at, watches_seen, watches_inserted,
          searches_seen, searches_inserted
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(
        archive.archiveHash, archive.source, importedAt, archive.watches.length,
        watchesInserted, archive.searches.length, searchesInserted
      );
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
    return {
      archiveHash: archive.archiveHash,
      watchesSeen: archive.watches.length,
      watchesInserted,
      searchesSeen: archive.searches.length,
      searchesInserted,
    };
  }

  upsertYoutubeCapture(
    watch: YoutubeCapturedWatch,
    importedAt = new Date().toISOString(),
  ): YoutubeCaptureResult {
    const existing = this.db.prepare(`
      SELECT video_id, watched_at, actual_watched_seconds
      FROM youtube_watch_events WHERE event_id=?
    `).get(watch.eventId) as {
      video_id: string;
      watched_at: string;
      actual_watched_seconds: number | null;
    } | undefined;
    if (existing && (existing.video_id !== watch.videoId || existing.watched_at !== watch.watchedAt)) {
      throw new Error('Capture session conflicts with an existing watch event');
    }

    const thumbnail = `https://i.ytimg.com/vi/${watch.videoId}/hqdefault.jpg`;
    const activity = activityFromEntry({
      source: 'youtube',
      sourceItemId: watch.videoId,
      visibility: 'summary',
      kind: 'video',
      title: watch.title,
      image: thumbnail,
      status: 'watched',
      activityAt: watch.watchedAt,
      rating: null,
      extra: {
        channel: watch.channelTitle ?? '',
        channelId: '',
        url: watch.url,
      },
    }, importedAt);

    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.prepare(`
        INSERT INTO youtube_videos (
          video_id, title, channel_title, thumbnail_url, duration_seconds
        ) VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(video_id) DO UPDATE SET
          title=CASE WHEN youtube_videos.metadata_fetched_at IS NULL
            THEN excluded.title ELSE youtube_videos.title END,
          channel_title=COALESCE(youtube_videos.channel_title, excluded.channel_title),
          thumbnail_url=CASE WHEN youtube_videos.thumbnail_url=''
            THEN excluded.thumbnail_url ELSE youtube_videos.thumbnail_url END,
          duration_seconds=COALESCE(youtube_videos.duration_seconds, excluded.duration_seconds)
      `).run(
        watch.videoId, watch.title, watch.channelTitle, thumbnail, watch.durationSeconds
      );
      this.db.prepare(`
        INSERT INTO activities (
          id, dedupe_key, source, source_item_id, type, media_kind, title, image,
          status, occurred_at, occurred_precision, rating_value, rating_scale,
          visibility, extra_json, first_seen_at, last_seen_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          title=excluded.title, image=excluded.image, extra_json=excluded.extra_json,
          last_seen_at=excluded.last_seen_at
      `).run(
        activity.id, activity.dedupeKey, activity.source, activity.sourceItemId,
        activity.type, activity.mediaKind, activity.title, activity.image,
        activity.status, activity.occurredAt, activity.occurredAtPrecision,
        null, null, activity.visibility, JSON.stringify(activity.extra),
        activity.firstSeenAt, activity.lastSeenAt
      );
      this.db.prepare(`
        INSERT INTO youtube_watch_events (
          event_id, activity_id, video_id, watched_at, raw_title, raw_url,
          channel_id, channel_title, channel_url, actual_watched_seconds,
          imported_at, activity_type
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'video')
        ON CONFLICT(event_id) DO UPDATE SET
          raw_title=excluded.raw_title,
          raw_url=excluded.raw_url,
          channel_title=COALESCE(excluded.channel_title, youtube_watch_events.channel_title),
          actual_watched_seconds=MAX(
            COALESCE(youtube_watch_events.actual_watched_seconds, 0),
            excluded.actual_watched_seconds
          )
      `).run(
        watch.eventId, activity.id, watch.videoId, watch.watchedAt, watch.title,
        watch.url, null, watch.channelTitle, null, watch.actualWatchedSeconds, importedAt
      );
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
    const previousSeconds = existing?.actual_watched_seconds ?? 0;
    return {
      eventId: watch.eventId,
      inserted: !existing,
      updated: Boolean(existing && watch.actualWatchedSeconds > previousSeconds),
      actualWatchedSeconds: Math.max(previousSeconds, watch.actualWatchedSeconds),
    };
  }

  ingestYoutubeProgress(
    batch: YoutubeProgressBatchInput,
    importedAt = new Date().toISOString(),
  ): YoutubeProgressImportResult {
    const existingImport = this.db.prepare(`
      SELECT observed_at, completed_at FROM youtube_progress_imports WHERE scan_id=?
    `).get(batch.scanId) as { observed_at: string; completed_at: string | null } | undefined;
    if (existingImport && existingImport.observed_at !== batch.observedAt) {
      throw new Error('Progress scan conflicts with an existing observation time');
    }
    if (existingImport?.completed_at && !batch.complete) {
      throw new Error('Progress scan is already complete');
    }

    let stored = 0;
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.prepare(`
        INSERT OR IGNORE INTO youtube_progress_imports (
          scan_id, observed_at, started_at, completed_at
        ) VALUES (?, ?, ?, NULL)
      `).run(batch.scanId, batch.observedAt, importedAt);
      const insertVideo = this.db.prepare(`
        INSERT INTO youtube_videos (
          video_id, title, thumbnail_url, duration_seconds
        ) VALUES (?, 'Unavailable video', ?, ?)
        ON CONFLICT(video_id) DO UPDATE SET
          duration_seconds=COALESCE(youtube_videos.duration_seconds, excluded.duration_seconds),
          thumbnail_url=CASE WHEN youtube_videos.thumbnail_url=''
            THEN excluded.thumbnail_url ELSE youtube_videos.thumbnail_url END
      `);
      const upsert = this.db.prepare(`
        INSERT INTO youtube_video_progress (
          video_id, progress_percent, resume_seconds, duration_seconds,
          progress_seconds, confidence, observed_at, scan_id
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(video_id) DO UPDATE SET
          progress_percent=excluded.progress_percent,
          resume_seconds=excluded.resume_seconds,
          duration_seconds=COALESCE(excluded.duration_seconds, youtube_video_progress.duration_seconds),
          progress_seconds=COALESCE(excluded.progress_seconds, youtube_video_progress.progress_seconds),
          confidence=excluded.confidence,
          observed_at=excluded.observed_at,
          scan_id=excluded.scan_id
        WHERE excluded.observed_at>youtube_video_progress.observed_at
          OR (
            excluded.observed_at=youtube_video_progress.observed_at
            AND (
              excluded.progress_percent IS NOT youtube_video_progress.progress_percent
              OR excluded.resume_seconds IS NOT youtube_video_progress.resume_seconds
              OR excluded.duration_seconds IS NOT youtube_video_progress.duration_seconds
              OR excluded.progress_seconds IS NOT youtube_video_progress.progress_seconds
              OR excluded.confidence IS NOT youtube_video_progress.confidence
              OR excluded.scan_id IS NOT youtube_video_progress.scan_id
            )
          )
      `);
      for (const item of batch.items) {
        insertVideo.run(
          item.videoId,
          `https://i.ytimg.com/vi/${item.videoId}/hqdefault.jpg`,
          item.durationSeconds,
        );
        const result = upsert.run(
          item.videoId, item.progressPercent, item.resumeSeconds, item.durationSeconds,
          progressSeconds(item), item.resumeSeconds !== null && item.resumeSeconds > 0
            ? 'resume'
            : 'progress',
          batch.observedAt, batch.scanId,
        );
        stored += Number(result.changes);
      }
      if (batch.complete) {
        this.db.prepare(`
          UPDATE youtube_progress_imports
          SET completed_at=COALESCE(completed_at, ?)
          WHERE scan_id=?
        `).run(importedAt, batch.scanId);
      }
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
    const total = this.db.prepare(`
      SELECT COUNT(*) count FROM youtube_video_progress WHERE scan_id=?
    `).get(batch.scanId) as { count: number };
    return {
      scanId: batch.scanId,
      accepted: batch.items.length,
      stored,
      totalStored: Number(total.count),
      completed: batch.complete || Boolean(existingImport?.completed_at),
    };
  }

  youtubeCounts(): {
    watches: number;
    videoWatches: number;
    videos: number;
    searches: number;
    searchQueries: number;
    channels: number;
  } {
    const row = this.db.prepare(`
      SELECT
        (SELECT COUNT(*) FROM youtube_watch_events) watches,
        (SELECT COUNT(*) FROM youtube_watch_events WHERE activity_type='video') video_watches,
        (SELECT COUNT(*) FROM youtube_videos) videos,
        (SELECT COUNT(*) FROM youtube_search_events) searches,
        (SELECT COUNT(*) FROM youtube_search_events WHERE activity_type='search') search_queries,
        (SELECT COUNT(DISTINCT COALESCE(channel_id, channel_title))
           FROM youtube_watch_events
           WHERE activity_type='video' AND (channel_id IS NOT NULL OR channel_title IS NOT NULL)) channels
    `).get() as Record<string, number>;
    return {
      watches: Number(row.watches),
      videoWatches: Number(row.video_watches),
      videos: Number(row.videos),
      searches: Number(row.searches),
      searchQueries: Number(row.search_queries),
      channels: Number(row.channels),
    };
  }

  youtubeHistoryStatus(): YoutubeHistoryStatus {
    const watch = this.db.prepare(`
      SELECT MAX(watched_at) latest_at, COUNT(*) count FROM youtube_watch_events
    `).get() as { latest_at: string | null; count: number };
    const search = this.db.prepare(`
      SELECT MAX(searched_at) latest_at, COUNT(*) count FROM youtube_search_events
    `).get() as { latest_at: string | null; count: number };
    const latest = [watch.latest_at, search.latest_at]
      .filter((value): value is string => Boolean(value))
      .sort()
      .at(-1) ?? null;
    return {
      latestEventAt: latest,
      latestWatchAt: watch.latest_at,
      latestSearchAt: search.latest_at,
      watches: Number(watch.count),
      searches: Number(search.count),
    };
  }

  youtubeDashboard(range: YoutubeRange = '28d', now = new Date()): YoutubeDashboardData {
    const cutoff = youtubeCutoff(range, now);
    const where = cutoff
      ? "WHERE w.activity_type='video' AND w.watched_at>=?"
      : "WHERE w.activity_type='video'";
    const params = cutoff ? [cutoff] : [];
    const estimatedWhere = cutoff ? 'WHERE e.watched_at>=?' : 'WHERE 1=1';
    const estimatedEvents = YOUTUBE_ESTIMATED_EVENTS_CTE;
    const stats = this.db.prepare(`
      ${estimatedEvents},
      selected_videos AS (
        SELECT DISTINCT e.video_id
        FROM estimated_events e
        ${estimatedWhere} AND e.video_id IS NOT NULL
      )
      SELECT COUNT(*) watch_events,
        COUNT(DISTINCT COALESCE(e.video_id, e.raw_url)) unique_videos,
        COUNT(DISTINCT COALESCE(e.channel_id, e.channel_title)) unique_channels,
        COALESCE(SUM(v.duration_seconds), 0) opened_duration_seconds,
        COALESCE(SUM(e.estimated_watch_seconds), 0) estimated_watch_seconds,
        COALESCE(SUM(CASE WHEN e.actual_watched_seconds IS NULL
          THEN e.estimated_watch_seconds ELSE 0 END), 0) inferred_watch_seconds,
        SUM(e.actual_watched_seconds) actual_watched_seconds,
        COUNT(DISTINCT CASE WHEN v.metadata_fetched_at IS NOT NULL THEN e.video_id END) enriched_videos,
        (SELECT COALESCE(SUM(v2.duration_seconds), 0)
          FROM selected_videos s JOIN youtube_videos v2 ON v2.video_id=s.video_id
        ) catalog_duration_seconds,
        (SELECT COALESCE(SUM(MIN(COALESCE(vp.progress_seconds, 0), COALESCE(v2.duration_seconds, vp.progress_seconds, 0))), 0)
          FROM selected_videos s
          JOIN youtube_videos v2 ON v2.video_id=s.video_id
          JOIN youtube_video_progress vp ON vp.video_id=s.video_id
        ) content_covered_seconds,
        (SELECT COALESCE(SUM(CASE WHEN vp.video_id IS NOT NULL THEN v2.duration_seconds ELSE 0 END), 0)
          FROM selected_videos s
          JOIN youtube_videos v2 ON v2.video_id=s.video_id
          LEFT JOIN youtube_video_progress vp ON vp.video_id=s.video_id
        ) progress_duration_seconds
      FROM estimated_events e
      LEFT JOIN youtube_videos v ON v.video_id=e.video_id
      ${estimatedWhere}
    `).get(...params, ...params) as Record<string, number | null>;
    const uniqueVideos = Number(stats.unique_videos ?? 0);
    const daily = this.db.prepare(`
      ${estimatedEvents}
      SELECT strftime('%Y-%m-%d', e.watched_at, '+8 hours') day,
        COUNT(*) watches, COALESCE(SUM(e.estimated_watch_seconds), 0) estimated_watch_seconds
      FROM estimated_events e
      ${estimatedWhere}
      GROUP BY day ORDER BY day
    `).all(...params) as Array<Record<string, string | number>>;
    const channelId = 'COALESCE(e.channel_id, v.channel_id)';
    const channelName = "COALESCE(NULLIF(c.name, ''), NULLIF(e.channel_title, ''), NULLIF(v.channel_title, ''))";
    const channelKey = `COALESCE(${channelId}, ${channelName})`;
    const topChannelRows = this.db.prepare(`
      ${estimatedEvents},
      aggregated AS (
        SELECT ${channelId} channel_id, ${channelName} name,
          COALESCE(c.thumbnail_url, '') thumbnail_url,
          COUNT(*) watches, COALESCE(SUM(e.estimated_watch_seconds), 0) estimated_watch_seconds
        FROM estimated_events e
        LEFT JOIN youtube_videos v ON v.video_id=e.video_id
        LEFT JOIN youtube_channels c ON c.channel_id=${channelId}
        ${estimatedWhere}
          AND ${channelName} IS NOT NULL
          AND LOWER(TRIM(${channelName}))<>'unknown channel'
        GROUP BY ${channelKey}
      ), ranked AS (
        SELECT *,
          ROW_NUMBER() OVER (ORDER BY watches DESC, estimated_watch_seconds DESC, name) watch_rank,
          ROW_NUMBER() OVER (ORDER BY estimated_watch_seconds DESC, watches DESC, name) time_rank
        FROM aggregated
      )
      SELECT channel_id, name, thumbnail_url, watches, estimated_watch_seconds
      FROM ranked
      WHERE watch_rank<=12 OR time_rank<=12
      ORDER BY estimated_watch_seconds DESC, watches DESC, name
    `).all(...params) as Array<Record<string, string | number | null>>;
    const topChannels: YoutubeChannelSummary[] = topChannelRows.map((row) => ({
      channelId: row.channel_id === null ? null : String(row.channel_id),
      name: String(row.name),
      thumbnailUrl: String(row.thumbnail_url),
      watches: Number(row.watches),
      estimatedWatchSeconds: Number(row.estimated_watch_seconds),
    }));
    const trendChannels = [...topChannels]
      .sort((a, b) => b.estimatedWatchSeconds - a.estimatedWatchSeconds || b.watches - a.watches)
      .slice(0, 8);
    const trendKeys = trendChannels.map((channel) => channel.channelId ?? channel.name);
    let channelTrend: YoutubeChannelTrendFrame[] = [];
    if (trendKeys.length) {
      const period = range === 'all'
        ? "strftime('%Y-%m', e.watched_at, '+8 hours')"
        : range === '90d'
          ? "strftime('%Y-%W', e.watched_at, '+8 hours')"
          : "strftime('%Y-%m-%d', e.watched_at, '+8 hours')";
      const trendRows = this.db.prepare(`
        ${estimatedEvents}
        SELECT ${period} period, ${channelId} channel_id, ${channelName} name,
          COALESCE(c.thumbnail_url, '') thumbnail_url,
          COUNT(*) watches, COALESCE(SUM(e.estimated_watch_seconds), 0) estimated_watch_seconds
        FROM estimated_events e
        LEFT JOIN youtube_videos v ON v.video_id=e.video_id
        LEFT JOIN youtube_channels c ON c.channel_id=${channelId}
        ${estimatedWhere}
          AND ${channelKey} IN (${trendKeys.map(() => '?').join(',')})
        GROUP BY period, ${channelKey}
        ORDER BY period, estimated_watch_seconds DESC
      `).all(...params, ...trendKeys) as Array<Record<string, string | number | null>>;
      const cumulative = new Map<string, YoutubeChannelSummary>();
      const frames = new Map<string, YoutubeChannelSummary[]>();
      for (let index = 0; index < trendRows.length; index++) {
        const row = trendRows[index];
        const key = row.channel_id === null ? String(row.name) : String(row.channel_id);
        const previous = cumulative.get(key);
        cumulative.set(key, {
          channelId: row.channel_id === null ? null : String(row.channel_id),
          name: String(row.name),
          thumbnailUrl: String(row.thumbnail_url),
          watches: (previous?.watches ?? 0) + Number(row.watches),
          estimatedWatchSeconds: (previous?.estimatedWatchSeconds ?? 0)
            + Number(row.estimated_watch_seconds),
        });
        const periodKey = String(row.period);
        frames.set(periodKey, []);
        const nextPeriod = trendRows[index + 1]?.period;
        if (nextPeriod !== row.period) {
          frames.set(periodKey, [...cumulative.values()]
            .sort((a, b) =>
              b.estimatedWatchSeconds - a.estimatedWatchSeconds || b.watches - a.watches
            )
            .slice(0, 8));
        }
      }
      channelTrend = [...frames.entries()]
        .filter(([, channels]) => channels.length)
        .map(([periodKey, channels]) => ({ period: periodKey, channels }));
    }
    const topics = this.db.prepare(`
      ${estimatedEvents}
      SELECT t.slug, t.name, COUNT(*) watches,
        COALESCE(SUM(e.estimated_watch_seconds), 0) estimated_watch_seconds
      FROM estimated_events e
      JOIN youtube_video_topics vt ON vt.video_id=e.video_id AND vt.rank=1
      JOIN youtube_topics t ON t.id=vt.topic_id
        AND t.taxonomy_version=(SELECT MAX(taxonomy_version) FROM youtube_topics)
      ${estimatedWhere}
      GROUP BY t.id ORDER BY watches DESC, estimated_watch_seconds DESC, t.name LIMIT 12
    `).all(...params) as Array<Record<string, string | number>>;
    const lengthWhere = cutoff
      ? "WHERE activity_type='video' AND watched_at>=? AND video_id IS NOT NULL"
      : "WHERE activity_type='video' AND video_id IS NOT NULL";
    const lengthBuckets = this.db.prepare(`
      WITH selected AS (
        SELECT DISTINCT video_id FROM youtube_watch_events ${lengthWhere}
      )
      SELECT CASE
        WHEN v.duration_seconds IS NULL THEN 'Unknown'
        WHEN v.duration_seconds<60 THEN '< 1 min'
        WHEN v.duration_seconds<300 THEN '1-5 min'
        WHEN v.duration_seconds<1200 THEN '5-20 min'
        WHEN v.duration_seconds<3600 THEN '20-60 min'
        ELSE '60+ min' END label,
        COUNT(*) videos
      FROM selected s JOIN youtube_videos v ON v.video_id=s.video_id
      GROUP BY label
    `).all(...params) as Array<Record<string, string | number>>;
    const recent = this.db.prepare(`
      WITH ranked AS (
        SELECT w.*, v.title metadata_title, v.channel_title metadata_channel,
          v.thumbnail_url, v.duration_seconds,
          ROW_NUMBER() OVER (
            PARTITION BY COALESCE(w.video_id, w.raw_url) ORDER BY w.watched_at DESC
          ) row_number,
          COUNT(*) OVER (PARTITION BY COALESCE(w.video_id, w.raw_url)) watch_count
        FROM youtube_watch_events w LEFT JOIN youtube_videos v ON v.video_id=w.video_id
        ${where}
      )
      SELECT video_id, COALESCE(metadata_title, raw_title) title, raw_url url,
        channel_id, COALESCE(channel_title, metadata_channel, 'Unknown channel') channel_title,
        COALESCE(thumbnail_url, '') thumbnail_url, duration_seconds,
        actual_watched_seconds, watched_at, watch_count
      FROM ranked WHERE row_number=1 ORDER BY watched_at DESC LIMIT 10
    `).all(...params) as Array<Record<string, string | number | null>>;
    const keywordRows = this.db.prepare(`
      WITH ranked AS (
        SELECT w.video_id, w.raw_url, w.raw_title, w.watched_at,
          ROW_NUMBER() OVER (
            PARTITION BY COALESCE(w.video_id, w.raw_url) ORDER BY w.watched_at DESC
          ) row_number
        FROM youtube_watch_events w
        ${where}
      )
      SELECT COALESCE(v.title, w.raw_title) title,
        SUBSTR(v.description, 1, 600) description, v.tags_json
      FROM ranked w LEFT JOIN youtube_videos v ON v.video_id=w.video_id
      WHERE w.row_number=1
      ORDER BY w.watched_at DESC
      LIMIT 2000
    `).all(...params) as Array<{ title: string; description: string | null; tags_json: string | null }>;
    return {
      range,
      generatedAt: now.toISOString(),
      stats: {
        watchEvents: Number(stats.watch_events ?? 0),
        uniqueVideos,
        uniqueChannels: Number(stats.unique_channels ?? 0),
        openedDurationSeconds: Number(stats.opened_duration_seconds ?? 0),
        catalogDurationSeconds: Number(stats.catalog_duration_seconds ?? 0),
        estimatedWatchSeconds: Number(stats.estimated_watch_seconds ?? 0),
        inferredWatchSeconds: Number(stats.inferred_watch_seconds ?? 0),
        contentCoveredSeconds: Number(stats.content_covered_seconds ?? 0),
        progressCoverage: Number(stats.catalog_duration_seconds ?? 0)
          ? Number(stats.progress_duration_seconds ?? 0) / Number(stats.catalog_duration_seconds)
          : 0,
        actualWatchedSeconds: stats.actual_watched_seconds === null ? null : Number(stats.actual_watched_seconds),
        metadataCoverage: uniqueVideos ? Number(stats.enriched_videos ?? 0) / uniqueVideos : 0,
      },
      daily: daily.map((row) => ({
        day: String(row.day), watches: Number(row.watches),
        estimatedWatchSeconds: Number(row.estimated_watch_seconds),
      })),
      lengthBuckets: lengthBuckets.map((row) => ({ label: String(row.label), videos: Number(row.videos) })),
      topChannels,
      channelTrend,
      topics: topics.map((row) => ({
        slug: String(row.slug), name: String(row.name),
        watches: Number(row.watches), estimatedWatchSeconds: Number(row.estimated_watch_seconds),
      })),
      keywords: extractYoutubeKeywords(keywordRows, 40),
      recent: recent.map((row) => ({
        videoId: row.video_id === null ? null : String(row.video_id),
        title: String(row.title), url: String(row.url),
        channelId: row.channel_id === null ? null : String(row.channel_id),
        channelTitle: String(row.channel_title), thumbnailUrl: String(row.thumbnail_url),
        durationSeconds: row.duration_seconds === null ? null : Number(row.duration_seconds),
        actualWatchedSeconds: row.actual_watched_seconds === null ? null : Number(row.actual_watched_seconds),
        watchedAt: String(row.watched_at), watchCount: Number(row.watch_count),
      })),
    };
  }

  youtubeVideosNeedingMetadata(limit = 500): string[] {
    const safeLimit = Math.max(1, Math.min(5000, Math.floor(limit)));
    const rows = this.db.prepare(`
      SELECT video_id FROM youtube_videos
      WHERE metadata_fetched_at IS NULL
      ORDER BY video_id LIMIT ?
    `).all(safeLimit) as Array<{ video_id: string }>;
    return rows.map((row) => row.video_id);
  }

  upsertYoutubeVideoMetadata(videos: YoutubeVideoMetadata[], fetchedAt = new Date().toISOString()): void {
    const statement = this.db.prepare(`
      INSERT INTO youtube_videos (
        video_id, title, channel_id, channel_title, description, tags_json,
        thumbnail_url, duration_seconds, published_at, category_id,
        availability, metadata_hash, metadata_fetched_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(video_id) DO UPDATE SET
        title=CASE WHEN excluded.title='' THEN youtube_videos.title ELSE excluded.title END,
        channel_id=COALESCE(excluded.channel_id, youtube_videos.channel_id),
        channel_title=COALESCE(excluded.channel_title, youtube_videos.channel_title),
        description=excluded.description, tags_json=excluded.tags_json,
        thumbnail_url=CASE WHEN excluded.thumbnail_url='' THEN youtube_videos.thumbnail_url ELSE excluded.thumbnail_url END,
        duration_seconds=excluded.duration_seconds, published_at=excluded.published_at,
        category_id=excluded.category_id, availability=excluded.availability,
        metadata_hash=excluded.metadata_hash, metadata_fetched_at=excluded.metadata_fetched_at
    `);
    this.db.exec('BEGIN IMMEDIATE');
    try {
      for (const video of videos) {
        statement.run(
          video.videoId, video.title, video.channelId, video.channelTitle,
          video.description, JSON.stringify(video.tags), video.thumbnailUrl,
          video.durationSeconds, video.publishedAt, video.categoryId,
          video.availability, video.metadataHash, fetchedAt
        );
      }
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  youtubeChannelsNeedingMetadata(limit = 500): string[] {
    const safeLimit = Math.max(1, Math.min(5000, Math.floor(limit)));
    const rows = this.db.prepare(`
      SELECT DISTINCT v.channel_id
      FROM youtube_videos v
      LEFT JOIN youtube_channels c ON c.channel_id=v.channel_id
      WHERE v.channel_id IS NOT NULL AND c.metadata_fetched_at IS NULL
      ORDER BY v.channel_id
      LIMIT ?
    `).all(safeLimit) as Array<{ channel_id: string }>;
    return rows.map((row) => row.channel_id);
  }

  upsertYoutubeChannelMetadata(
    channels: YoutubeChannelMetadata[],
    fetchedAt = new Date().toISOString(),
  ): void {
    const statement = this.db.prepare(`
      INSERT INTO youtube_channels(channel_id, name, thumbnail_url, metadata_fetched_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(channel_id) DO UPDATE SET
        name=excluded.name,
        thumbnail_url=excluded.thumbnail_url,
        metadata_fetched_at=excluded.metadata_fetched_at
    `);
    this.db.exec('BEGIN IMMEDIATE');
    try {
      for (const channel of channels) {
        statement.run(channel.channelId, channel.name, channel.thumbnailUrl, fetchedAt);
      }
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  youtubeVideosForClassification(limit = 250): Array<YoutubeVideoMetadata> {
    const rows = this.db.prepare(`
      SELECT v.* FROM youtube_videos v
      WHERE v.metadata_fetched_at IS NOT NULL AND v.availability='available'
        AND NOT EXISTS (
          SELECT 1 FROM youtube_video_topics vt
          JOIN youtube_topics t ON t.id=vt.topic_id
          WHERE vt.video_id=v.video_id AND vt.metadata_hash=v.metadata_hash
            AND t.taxonomy_version=(SELECT MAX(taxonomy_version) FROM youtube_topics)
        )
      ORDER BY v.metadata_fetched_at LIMIT ?
    `).all(Math.max(1, Math.min(1000, Math.floor(limit)))) as Array<Record<string, unknown>>;
    return this.youtubeMetadataRows(rows);
  }

  youtubeVideosForTaxonomy(limit = 160): Array<YoutubeVideoMetadata> {
    const rows = this.db.prepare(`
      SELECT v.* FROM youtube_videos v
      WHERE v.metadata_fetched_at IS NOT NULL AND v.availability='available'
      ORDER BY v.metadata_fetched_at DESC, v.video_id LIMIT ?
    `).all(Math.max(12, Math.min(1000, Math.floor(limit)))) as Array<Record<string, unknown>>;
    return this.youtubeMetadataRows(rows);
  }

  private youtubeMetadataRows(rows: Array<Record<string, unknown>>): YoutubeVideoMetadata[] {
    return rows.map((row) => ({
      videoId: String(row.video_id), title: String(row.title),
      channelId: row.channel_id === null ? null : String(row.channel_id),
      channelTitle: row.channel_title === null ? null : String(row.channel_title),
      description: String(row.description), tags: JSON.parse(String(row.tags_json)) as string[],
      thumbnailUrl: String(row.thumbnail_url),
      durationSeconds: row.duration_seconds === null ? null : Number(row.duration_seconds),
      publishedAt: row.published_at === null ? null : String(row.published_at),
      categoryId: row.category_id === null ? null : String(row.category_id),
      availability: row.availability as 'available' | 'unavailable',
      metadataHash: String(row.metadata_hash),
    }));
  }

  youtubeTopics(): YoutubeTopic[] {
    const rows = this.db.prepare(`
      SELECT id, taxonomy_version, slug, name, description FROM youtube_topics
      WHERE taxonomy_version=(SELECT MAX(taxonomy_version) FROM youtube_topics)
      ORDER BY id
    `).all() as Array<Record<string, unknown>>;
    return rows.map((row) => ({
      id: Number(row.id), version: Number(row.taxonomy_version), slug: String(row.slug),
      name: String(row.name), description: String(row.description),
    }));
  }

  replaceYoutubeTaxonomy(topics: Array<Omit<YoutubeTopic, 'id'>>, createdAt = new Date().toISOString()): YoutubeTopic[] {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const statement = this.db.prepare(`
        INSERT INTO youtube_topics(taxonomy_version, slug, name, description, created_at)
        VALUES (?, ?, ?, ?, ?)
      `);
      for (const topic of topics) statement.run(topic.version, topic.slug, topic.name, topic.description, createdAt);
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
    return this.youtubeTopics();
  }

  saveYoutubeVideoTopics(
    videoId: string,
    assignments: Array<{ topicId: number; rank: number; confidence: number }>,
    model: string,
    promptVersion: string,
    metadataHash: string,
    classifiedAt = new Date().toISOString(),
  ): void {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.prepare('DELETE FROM youtube_video_topics WHERE video_id=?').run(videoId);
      const statement = this.db.prepare(`
        INSERT INTO youtube_video_topics(
          video_id, topic_id, rank, confidence, model, prompt_version, metadata_hash, classified_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `);
      for (const item of assignments) {
        statement.run(videoId, item.topicId, item.rank, item.confidence, model, promptVersion, metadataHash, classifiedAt);
      }
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  createYoutubeOAuthState(state: string, expiresAt: string): void {
    this.db.prepare('INSERT INTO youtube_oauth_states(state, expires_at) VALUES (?, ?)').run(state, expiresAt);
  }

  consumeYoutubeOAuthState(state: string, now = new Date().toISOString()): boolean {
    const result = this.db.prepare(`
      UPDATE youtube_oauth_states SET used_at=?
      WHERE state=? AND used_at IS NULL AND expires_at>?
    `).run(now, state, now);
    return Number(result.changes) === 1;
  }

  saveYoutubeOAuthCredential(credential: YoutubeOAuthCredential): void {
    this.db.prepare(`
      INSERT INTO youtube_oauth(id, encrypted_refresh_token, expires_at, scope, updated_at)
      VALUES (1, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET encrypted_refresh_token=excluded.encrypted_refresh_token,
        expires_at=excluded.expires_at, scope=excluded.scope, updated_at=excluded.updated_at
    `).run(
      credential.encryptedRefreshToken, credential.expiresAt,
      credential.scope, credential.updatedAt
    );
  }

  youtubeOAuthCredential(): YoutubeOAuthCredential | null {
    const row = this.db.prepare(`
      SELECT encrypted_refresh_token, expires_at, scope, updated_at
      FROM youtube_oauth WHERE id=1
    `).get() as Record<string, unknown> | undefined;
    return row ? {
      encryptedRefreshToken: String(row.encrypted_refresh_token),
      expiresAt: row.expires_at === null ? null : String(row.expires_at),
      scope: String(row.scope),
      updatedAt: String(row.updated_at),
    } : null;
  }

  setYoutubeSyncState(key: string, value: string, updatedAt = new Date().toISOString()): void {
    this.db.prepare(`
      INSERT INTO youtube_sync_state(key, value, updated_at) VALUES (?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at
    `).run(key, value, updatedAt);
  }

  youtubeSyncState(key: string): string | null {
    const row = this.db.prepare('SELECT value FROM youtube_sync_state WHERE key=?')
      .get(key) as { value: string } | undefined;
    return row?.value ?? null;
  }

  countActivities(): number {
    const row = this.db.prepare('SELECT COUNT(*) count FROM activities').get() as { count: number };
    return Number(row.count);
  }

  countPublicActivities(): number {
    const row = this.db.prepare("SELECT COUNT(*) count FROM activities WHERE visibility='public'").get() as { count: number };
    return Number(row.count);
  }

  countBySource(): Record<string, number> {
    const rows = this.db.prepare("SELECT source, COUNT(*) count FROM activities WHERE visibility='public' GROUP BY source ORDER BY count DESC")
      .all() as Array<{ source: string; count: number }>;
    return Object.fromEntries(rows.map((row) => [row.source, Number(row.count)]));
  }

  wrapped(year: number): WrappedSummary {
    const yearText = String(year);
    const aggregateWhere = "visibility IN ('public', 'summary') AND (source!='youtube' OR status='watched') AND substr(occurred_at, 1, 4)=?";
    const publicWhere = "visibility='public' AND substr(occurred_at, 1, 4)=?";
    const totals = this.db.prepare(`
      SELECT COUNT(*) total, AVG(rating_value * 10.0 / rating_scale) average_rating,
             MIN(occurred_at) first_at, MAX(occurred_at) last_at
      FROM activities WHERE ${aggregateWhere}
    `).get(yearText) as { total: number; average_rating: number | null; first_at: string | null; last_at: string | null };
    const grouped = (column: 'source' | 'media_kind'): Record<string, number> => Object.fromEntries(
      (this.db.prepare(`SELECT ${column} name, COUNT(*) count FROM activities WHERE ${aggregateWhere} GROUP BY ${column} ORDER BY count DESC`)
        .all(yearText) as Array<{ name: string; count: number }>).map((row) => [row.name, Number(row.count)])
    );
    const topTitles = this.db.prepare(`
      SELECT title, media_kind kind, COUNT(*) count FROM activities WHERE ${publicWhere}
      GROUP BY media_kind, title ORDER BY count DESC, title LIMIT 10
    `).all(yearText) as Array<{ title: string; kind: string; count: number }>;
    return {
      year, totalActivities: Number(totals.total), bySource: grouped('source'), byKind: grouped('media_kind'),
      topTitles: topTitles.map((row) => ({ ...row, count: Number(row.count) })),
      averageRating: totals.average_rating === null ? null : Math.round(Number(totals.average_rating) * 10) / 10,
      firstActivityAt: totals.first_at, lastActivityAt: totals.last_at,
    };
  }

  // Fold a refreshed snapshot into the time ledger for sources that only
  // report a lifetime total (Simkl, Kitsu): the growth since the previous
  // refresh becomes estimated seconds on the day it happened. No-op for
  // sources with real per-event durations. Missing state seeds the watermark
  // without recording time, so a platform's whole history cannot land on
  // deploy day.
  recordTimeLedger(snapshot: SourceSnapshot<unknown>, now = new Date()): void {
    if (snapshot.source === 'backloggd') return this.recordBackloggdLedger(snapshot, now);
    const total = ledgerLifetimeSeconds(snapshot);
    if (total === null) return;
    const nowIso = now.toISOString();
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const state = this.db.prepare(
        "SELECT value, updated_at FROM time_ledger_state WHERE source=? AND key='total_seconds'"
      ).get(snapshot.source) as { value: number; updated_at: string } | undefined;
      // Negative deltas (platform-side recounts, removed items) clamp to zero.
      const delta = state ? Math.max(0, total - Number(state.value)) : 0;
      if (state && delta > 0) {
        // Attribute progress to when it happened rather than when this
        // refresh saw it: the newest entry activity since the watermark.
        const observed = snapshot.entries
          .map((entry) => entry.activityAt)
          .filter((at) => /^\d{4}-\d{2}-\d{2}/.test(at) && at >= state.updated_at)
          .sort()
          .at(-1);
        this.db.prepare(`
          INSERT INTO time_ledger(day, source, seconds, method, detail_json, updated_at)
          VALUES (?, ?, ?, 'estimated', ?, ?)
          ON CONFLICT(day, source) DO UPDATE SET
            seconds=seconds+excluded.seconds,
            detail_json=excluded.detail_json,
            updated_at=excluded.updated_at
        `).run(
          taipeiDay(observed ?? now), snapshot.source, delta,
          JSON.stringify({ basis: 'lifetime-delta', deltaSeconds: delta }), nowIso
        );
      }
      this.db.prepare(`
        INSERT INTO time_ledger_state(source, key, value, updated_at)
        VALUES (?, 'total_seconds', ?, ?)
        ON CONFLICT(source, key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at
      `).run(snapshot.source, total, nowIso);
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  // Backloggd reports a lifetime playtime total per game, so each game gets
  // its own watermark (`game:<slug>` in time_ledger_state): the growth
  // between syncs becomes estimated seconds on the game's last-played day.
  // First sightings only seed, like the source-level ledger, so a game's
  // pre-existing history never lands on one day.
  private recordBackloggdLedger(snapshot: SourceSnapshot<unknown>, now = new Date()): void {
    const games = snapshot.entries
      .filter((entry) => entry.sourceItemId && playtimeMinutes(entry.extra.playtime) !== null);
    if (!games.length) return;
    const nowIso = now.toISOString();
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const readState = this.db.prepare("SELECT value FROM time_ledger_state WHERE source='backloggd' AND key=?");
      const writeState = this.db.prepare(`
        INSERT INTO time_ledger_state(source, key, value, updated_at) VALUES ('backloggd', ?, ?, ?)
        ON CONFLICT(source, key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at
      `);
      const addLedger = this.db.prepare(`
        INSERT INTO time_ledger(day, source, seconds, method, detail_json, updated_at)
        VALUES (?, 'backloggd', ?, 'estimated', ?, ?)
        ON CONFLICT(day, source) DO UPDATE SET
          seconds=seconds+excluded.seconds,
          detail_json=excluded.detail_json,
          updated_at=excluded.updated_at
      `);
      for (const game of games) {
        const totalSeconds = playtimeMinutes(game.extra.playtime)! * 60;
        const key = `game:${game.sourceItemId}`;
        const state = readState.get(key) as { value: number } | undefined;
        const delta = state ? Math.max(0, totalSeconds - Number(state.value)) : 0;
        if (state && delta > 0) {
          const day = /^\d{4}-\d{2}-\d{2}/.test(game.activityAt) ? taipeiDay(game.activityAt) : taipeiDay(now);
          addLedger.run(
            day, delta,
            JSON.stringify({ basis: 'playtime-delta', game: game.sourceItemId, deltaSeconds: delta }), nowIso
          );
        }
        writeState.run(key, totalSeconds, nowIso);
      }
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  private statsfmSnapshotStats(): { stats: Record<string, unknown>; fetchedAt: string } | null {
    const row = this.db.prepare(
      "SELECT payload_json, fetched_at FROM snapshots WHERE source='statsfm'"
    ).get() as { payload_json: string | null; fetched_at: string | null } | undefined;
    if (!row?.payload_json || !row.fetched_at) return null;
    try {
      const parsed = JSON.parse(row.payload_json) as SourceSnapshot<unknown>;
      return { stats: (parsed.stats ?? {}) as Record<string, unknown>, fetchedAt: row.fetched_at };
    } catch {
      return null;
    }
  }

  // Time recorded with each platform across rolling-24h, Taipei-calendar, and
  // all-time windows. YouTube and stats.fm are measured (per-event durations);
  // Simkl and Kitsu come from the estimated time ledger.
  timeSpent(now = new Date()): TimeSpentSummary {
    const starts = taipeiWindowStarts(now);
    const cutoffs = {
      last24h: new Date(now.getTime() - 86_400_000).toISOString(),
      day: starts.day.toISOString(),
      week: starts.week.toISOString(),
      month: starts.month.toISOString(),
      year: starts.year.toISOString(),
    };
    const sources: SourceTimeSpent[] = [];
    const windowsFrom = (row: Record<string, number | null>): TimeWindows => ({
      last24h: Math.round(Number(row.last24h ?? 0)),
      day: Math.round(Number(row.day ?? 0)),
      week: Math.round(Number(row.week ?? 0)),
      month: Math.round(Number(row.month ?? 0)),
      year: Math.round(Number(row.year ?? 0)),
      allTime: Math.round(Number(row.all_time ?? 0)),
    });

    const youtube = windowsFrom(this.db.prepare(`
      ${YOUTUBE_ESTIMATED_EVENTS_CTE}
      SELECT
        COALESCE(SUM(CASE WHEN e.watched_at>=? THEN e.estimated_watch_seconds ELSE 0 END), 0) last24h,
        COALESCE(SUM(CASE WHEN e.watched_at>=? THEN e.estimated_watch_seconds ELSE 0 END), 0) day,
        COALESCE(SUM(CASE WHEN e.watched_at>=? THEN e.estimated_watch_seconds ELSE 0 END), 0) week,
        COALESCE(SUM(CASE WHEN e.watched_at>=? THEN e.estimated_watch_seconds ELSE 0 END), 0) month,
        COALESCE(SUM(CASE WHEN e.watched_at>=? THEN e.estimated_watch_seconds ELSE 0 END), 0) year,
        COALESCE(SUM(e.estimated_watch_seconds), 0) all_time
      FROM estimated_events e
    `).get(cutoffs.last24h, cutoffs.day, cutoffs.week, cutoffs.month, cutoffs.year) as Record<string, number>);
    if (youtube.allTime > 0) sources.push({ source: 'youtube', method: 'measured', windows: youtube });

    // Bucket a (occurred_at, seconds) subquery into all six windows at once.
    const activityWindows = (innerSql: string, ...innerParams: string[]): TimeWindows =>
      windowsFrom(this.db.prepare(`
        SELECT
          COALESCE(SUM(CASE WHEN occurred_at>=? THEN seconds ELSE 0 END), 0) last24h,
          COALESCE(SUM(CASE WHEN occurred_at>=? THEN seconds ELSE 0 END), 0) day,
          COALESCE(SUM(CASE WHEN occurred_at>=? THEN seconds ELSE 0 END), 0) week,
          COALESCE(SUM(CASE WHEN occurred_at>=? THEN seconds ELSE 0 END), 0) month,
          COALESCE(SUM(CASE WHEN occurred_at>=? THEN seconds ELSE 0 END), 0) year,
          COALESCE(SUM(seconds), 0) all_time
        FROM (${innerSql})
      `).get(
        cutoffs.last24h, cutoffs.day, cutoffs.week, cutoffs.month, cutoffs.year, ...innerParams
      ) as Record<string, number>);

    const local = activityWindows(`
      SELECT occurred_at, COALESCE(json_extract(extra_json, '$.durationMs'), 0) / 1000.0 seconds
      FROM activities WHERE source='statsfm' AND media_kind='music' AND occurred_at IS NOT NULL
    `);
    // Local streams only reach back to when infovore started syncing; the
    // snapshot carries stats.fm-side totals for the longer windows. A remote
    // value only applies while the fetch that produced it happened inside the
    // current window (fetched before Monday ⇒ stale for "this week").
    const remote = this.statsfmSnapshotStats();
    const remoteSeconds = (key: string, windowStart: string | null): number | null => {
      if (!remote) return null;
      if (windowStart !== null && remote.fetchedAt < windowStart) return null;
      const minutes = Number(remote.stats[key]);
      return Number.isFinite(minutes) ? Math.round(minutes * 60) : null;
    };
    const statsfm: TimeWindows = {
      last24h: local.last24h,
      day: local.day,
      week: remoteSeconds('weekMinutes', cutoffs.week) ?? local.week,
      month: remoteSeconds('monthMinutes', cutoffs.month) ?? local.month,
      year: remoteSeconds('yearMinutes', cutoffs.year) ?? local.year,
      allTime: remoteSeconds('lifetimeMinutes', null) ?? local.allTime,
    };
    if (statsfm.allTime > 0) sources.push({ source: 'statsfm', method: 'measured', windows: statsfm });

    // Manual events count their scheduled start–end span (default 2 h when no
    // end time was recorded) — only once marked attended, and never from
    // private entries, which stay out of public totals entirely.
    const events = activityWindows(`
      SELECT occurred_at,
        COALESCE(json_extract(extra_json, '$.durationMinutes') * 60.0, ${EVENT_DEFAULT_SECONDS}) seconds
      FROM activities
      WHERE source='events' AND status='attended' AND visibility IN ('public', 'summary')
        AND occurred_at IS NOT NULL AND occurred_at<=?
    `, now.toISOString());
    if (events.allTime > 0) sources.push({ source: 'events', method: 'estimated', windows: events });

    // Books: pages × reading pace, attributed to the day the book was
    // finished. Books without a page count in the shelf RSS are skipped.
    const goodreads = activityWindows(`
      SELECT occurred_at, json_extract(extra_json, '$.pages') * ${SECONDS_PER_PAGE}.0 seconds
      FROM activities
      WHERE source='goodreads' AND status='read' AND occurred_at IS NOT NULL
        AND json_extract(extra_json, '$.pages') > 0
    `);
    if (goodreads.allTime > 0) sources.push({ source: 'goodreads', method: 'estimated', windows: goodreads });

    const ledgerQuery = this.db.prepare(`
      SELECT
        COALESCE(SUM(CASE WHEN day>=? THEN seconds ELSE 0 END), 0) day,
        COALESCE(SUM(CASE WHEN day>=? THEN seconds ELSE 0 END), 0) week,
        COALESCE(SUM(CASE WHEN day>=? THEN seconds ELSE 0 END), 0) month,
        COALESCE(SUM(CASE WHEN day>=? THEN seconds ELSE 0 END), 0) year,
        COALESCE(SUM(seconds), 0) all_time
      FROM time_ledger WHERE source=?
    `);
    for (const source of ['simkl', 'kitsu', 'backloggd']) {
      const row = ledgerQuery.get(
        taipeiDay(starts.day), taipeiDay(starts.week), taipeiDay(starts.month), taipeiDay(starts.year), source
      ) as Record<string, number>;
      // Ledger data is day-granular, so "last 24 h" honestly approximates to
      // today's Taipei day.
      const windows = windowsFrom({ ...row, last24h: row.day });
      if (windows.allTime > 0) sources.push({ source, method: 'estimated', windows });
    }

    sources.sort((a, b) => b.windows.allTime - a.windows.allTime);
    const sum = (included: SourceTimeSpent[]): TimeWindows => {
      const total: TimeWindows = { last24h: 0, day: 0, week: 0, month: 0, year: 0, allTime: 0 };
      for (const entry of included) {
        for (const key of Object.keys(total) as Array<keyof TimeWindows>) total[key] += entry.windows[key];
      }
      return total;
    };
    return {
      generatedAt: now.toISOString(),
      sources,
      total: sum(sources),
      measuredTotal: sum(sources.filter((entry) => entry.method === 'measured')),
    };
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
