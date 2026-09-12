import { recordedCoverage, type RecordedInterval } from './coverage.js';
import { DayflowStore, migrateDayflow } from '../dayflow/store.js';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { activityFromEntry } from './activity.js';
import { taipeiDay, taipeiWindowStarts } from './time.js';
import { sleepDays } from '../health/sleep.js';
import { recordedSleepWindows } from '../health/home.js';
import type { Activity, SourceSnapshot } from './types.js';
import type {
  HealthConnectBatchInput,
  HealthConnectSnapshot,
  HealthConnectIngestResult,
  HealthConnectStatus,
  HealthDailySummary,
} from '../health/types.js';

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

// Estimation rates for sources with schedules or page counts instead of
// measured durations.
const EVENT_DEFAULT_SECONDS = 2 * 3600; // attended event with no scheduled end time
const SECONDS_PER_PAGE = 120;           // ~30 pages/hour reading pace

// Health Connect keeps a copy of every app that writes the same activity, so a
// day recorded by Garmin, Fitbit and the phone pedometer would count its steps
// three times. Aggregations therefore read a single data origin per data type
// and Taipei day, preferring Garmin and falling back to the other writers only
// for days Garmin did not record.
const HEALTH_ORIGIN_RANK = `CASE
  WHEN data_origin LIKE 'com.garmin.%' THEN 0
  WHEN data_origin LIKE 'com.fitbit.%' THEN 1
  WHEN data_origin LIKE 'com.google.android.apps.fitness%' THEN 2
  ELSE 3 END`;
const PREFERRED_HEALTH_RECORDS = `
  SELECT r.* FROM health_connect_records r
  JOIN (
    SELECT data_type, day, data_origin FROM (
      SELECT data_type, date(start_at, '+8 hours') day, data_origin,
        ROW_NUMBER() OVER (
          PARTITION BY data_type, date(start_at, '+8 hours')
          ORDER BY ${HEALTH_ORIGIN_RANK}, data_origin
        ) origin_rank
      FROM health_connect_records
      GROUP BY data_type, day, data_origin
    ) WHERE origin_rank = 1
  ) preferred ON preferred.data_type = r.data_type
    AND preferred.day = date(r.start_at, '+8 hours')
    AND preferred.data_origin = r.data_origin`;

const EXERCISE_NAMES: Record<number, string> = {
  0: 'Workout', 2: 'Badminton', 4: 'Baseball', 5: 'Basketball', 8: 'Cycling',
  9: 'Stationary cycling', 10: 'Boot camp', 11: 'Boxing', 13: 'Calisthenics',
  14: 'Cricket', 16: 'Dancing', 25: 'Elliptical', 26: 'Exercise class',
  27: 'Fencing', 28: 'American football', 29: 'Australian football',
  31: 'Disc sports', 32: 'Golf', 33: 'Guided breathing', 34: 'Gymnastics',
  35: 'Handball', 36: 'HIIT', 37: 'Hiking', 38: 'Ice hockey',
  39: 'Ice skating', 44: 'Martial arts', 46: 'Paddling', 47: 'Paragliding',
  48: 'Pilates', 50: 'Racquetball', 51: 'Rock climbing', 52: 'Roller hockey',
  53: 'Rowing', 54: 'Rowing machine', 55: 'Rugby', 56: 'Running',
  57: 'Treadmill running', 58: 'Sailing', 59: 'Scuba diving', 60: 'Skating',
  61: 'Skiing', 62: 'Snowboarding', 63: 'Snowshoeing', 64: 'Soccer',
  65: 'Softball', 66: 'Squash', 68: 'Stair climbing', 69: 'Stair machine',
  70: 'Strength training', 71: 'Stretching', 72: 'Surfing',
  73: 'Open-water swimming', 74: 'Pool swimming', 75: 'Table tennis',
  76: 'Tennis', 78: 'Volleyball', 79: 'Walking', 80: 'Water polo',
  81: 'Weightlifting', 82: 'Wheelchair exercise', 83: 'Yoga',
};

// Per-day Backloggd playtime logs carried in the snapshot's extra. Kept
// structural (not imported from sources/) so the data layer stays below the
// source layer.
interface BackloggdDailySession {
  game: string;
  day: string;
  minutes: number;
}

function backloggdSessions(snapshot: SourceSnapshot<unknown>): BackloggdDailySession[] {
  const raw = (snapshot.extra as { sessions?: unknown } | null)?.sessions;
  if (!Array.isArray(raw)) return [];
  // Aggregate duplicate (game, day) rows — e.g. two playthroughs logged on
  // the same day — so the watermark compares against the day's full total.
  const byGameDay = new Map<string, BackloggdDailySession>();
  for (const value of raw) {
    const session = value as Partial<BackloggdDailySession> | null;
    if (!session || typeof session !== 'object') continue;
    if (typeof session.game !== 'string' || !session.game) continue;
    if (typeof session.day !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(session.day)) continue;
    if (typeof session.minutes !== 'number' || !Number.isFinite(session.minutes) || session.minutes <= 0) continue;
    const key = `${session.game}${session.day}`;
    const existing = byGameDay.get(key);
    if (existing) existing.minutes += session.minutes;
    else byGameDay.set(key, { game: session.game, day: session.day, minutes: session.minutes });
  }
  return [...byGameDay.values()];
}

// Lifetime totals the delta-based time ledger can watch. Only sources whose
// platform reports a cumulative time figure but no per-session durations.
function youtubeDailySeries(snapshot: SourceSnapshot<unknown>): Array<{ day: string; seconds: number; watches: number }> {
  const extra = snapshot.extra as { daily?: unknown } | null | undefined;
  if (!Array.isArray(extra?.daily)) return [];
  const series: Array<{ day: string; seconds: number; watches: number }> = [];
  for (const row of extra.daily as Array<Record<string, unknown>>) {
    const day = String(row?.day ?? '');
    const seconds = Math.round(Number(row?.estimatedWatchSeconds));
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || !Number.isFinite(seconds) || seconds <= 0) continue;
    series.push({ day, seconds, watches: Math.round(Number(row?.watches)) || 0 });
  }
  return series;
}

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
  readonly dayflow: DayflowStore;

  constructor(path: string) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
    this.migrate();
    this.dayflow = new DayflowStore(this.db);
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
    const afterTimeLedger = this.db.prepare('PRAGMA user_version').get() as { user_version: number };
    if (afterTimeLedger.user_version < 8) this.migrateBackloggdDailyLedger();
    const afterBackloggdDailyLedger = this.db.prepare('PRAGMA user_version').get() as { user_version: number };
    if (afterBackloggdDailyLedger.user_version < 9) this.migrateHealthConnect();
    const afterHealth = this.db.prepare('PRAGMA user_version').get() as { user_version: number };
    if (afterHealth.user_version < 10) migrateDayflow(this.db);
    const afterDayflow = this.db.prepare('PRAGMA user_version').get() as { user_version: number };
    if (afterDayflow.user_version < 11) this.migrateHealthOriginIndex();
  }

  private migrateHealthOriginIndex(): void {
    this.db.exec(`
      BEGIN;
      CREATE INDEX IF NOT EXISTS health_connect_records_origin_day_idx
        ON health_connect_records(data_type, date(start_at, '+8 hours'), data_origin);
      PRAGMA user_version = 11;
      COMMIT;
    `);
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

  // The Backloggd ledger switched from per-game lifetime deltas to per-day
  // playtime logs, which re-derive the full history from the log pages —
  // drop the old accumulation so the backfill cannot double-count.
  private migrateBackloggdDailyLedger(): void {
    this.db.exec(`
      BEGIN;
      DELETE FROM time_ledger WHERE source = 'backloggd';
      DELETE FROM time_ledger_state WHERE source = 'backloggd';
      PRAGMA user_version = 8;
      COMMIT;
    `);
  }

  private migrateHealthConnect(): void {
    this.db.exec(`
      BEGIN;
      CREATE TABLE health_connect_records (
        record_id TEXT PRIMARY KEY,
        data_type TEXT NOT NULL,
        data_origin TEXT NOT NULL,
        start_at TEXT NOT NULL,
        end_at TEXT NOT NULL,
        last_modified_at TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        first_seen_at TEXT NOT NULL,
        last_seen_at TEXT NOT NULL
      );
      CREATE INDEX health_connect_records_time_idx
        ON health_connect_records(start_at DESC);
      CREATE INDEX health_connect_records_type_time_idx
        ON health_connect_records(data_type, start_at DESC);
      CREATE TABLE health_connect_syncs (
        sync_id TEXT PRIMARY KEY,
        device_id TEXT NOT NULL,
        observed_at TEXT NOT NULL,
        received_at TEXT NOT NULL,
        records_seen INTEGER NOT NULL,
        inserted_count INTEGER NOT NULL,
        updated_count INTEGER NOT NULL,
        deleted_count INTEGER NOT NULL
      );
      CREATE INDEX health_connect_syncs_received_idx
        ON health_connect_syncs(received_at DESC);
      PRAGMA user_version = 9;
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

  // Exercise sessions since `since`, grouped by type, with their measured
  // duration. Feeds the cross-source word cloud; titles are the Health Connect
  // exercise type names, never free text from the device.
  healthExerciseSince(since: string): Array<{ title: string; sessions: number; seconds: number }> {
    const rows = this.db.prepare(`
      SELECT json_extract(payload_json, '$.exerciseType') exercise_type, COUNT(*) sessions,
        COALESCE(SUM(MAX(0, (julianday(end_at) - julianday(start_at)) * 86400)), 0) seconds
      FROM (${PREFERRED_HEALTH_RECORDS}) health_connect_records
      WHERE data_type='exercise_session' AND start_at>=?
      GROUP BY exercise_type ORDER BY seconds DESC
    `).all(since) as Array<{ exercise_type: number | null; sessions: number; seconds: number }>;
    return rows.map((row) => ({
      title: EXERCISE_NAMES[Number(row.exercise_type ?? 0)] ?? 'Workout',
      sessions: Number(row.sessions), seconds: Math.round(Number(row.seconds)),
    }));
  }

  // Every dated public activity since `since`, newest first. Unlike
  // queryActivities this is uncapped by the API page size, so aggregate
  // views (the word cloud) see the whole window.
  activitiesSince(since: string, limit = 5000): Activity[] {
    const rows = this.db.prepare(`
      SELECT * FROM activities
      WHERE visibility='public' AND occurred_precision IN ('exact', 'day') AND occurred_at>=?
      ORDER BY occurred_at DESC, first_seen_at DESC LIMIT ?
    `).all(since, limit) as Record<string, unknown>[];
    return rows.map((row) => this.rowToActivity(row));
  }

  activityCoverage(now = new Date(), enabled = { dayflow: true, health: true }) {
    const since = new Date(+taipeiWindowStarts(now).day - 6 * 86400000).toISOString();
    const intervals: RecordedInterval[] = [];
    if (enabled.dayflow) intervals.push(...this.dayflow.recordedIntervals(taipeiDay(new Date(Date.parse(since) - 86400000)), now));
    if (enabled.health) {
      const rows = this.db.prepare(`SELECT data_type, start_at, end_at FROM (${PREFERRED_HEALTH_RECORDS}) health_connect_records
        WHERE data_type IN ('sleep_session', 'exercise_session') AND end_at >= ? AND start_at <= ?`)
        .all(since, now.toISOString()) as Array<{ data_type: string; start_at: string; end_at: string }>;
      intervals.push(...rows.map(row => ({ source: row.data_type === 'sleep_session' ? 'health-sleep' : 'health',
        start: Date.parse(row.start_at), end: Date.parse(row.end_at) })));
    }
    // Listening records have an end timestamp and duration; daily totals and
    // completion timestamps from other media cannot locate a recorded interval.
    const music = this.db.prepare(`SELECT occurred_at, json_extract(extra_json, '$.durationMs') duration
      FROM activities WHERE source = 'statsfm' AND visibility = 'public' AND occurred_precision = 'exact'
        AND occurred_at <= ? AND occurred_at >= ?`)
      .all(now.toISOString(), since) as Array<{ occurred_at: string; duration: number }>;
    intervals.push(...music.map(row => ({ source: 'statsfm', start: Date.parse(row.occurred_at) - Number(row.duration),
      end: Date.parse(row.occurred_at) })));
    return recordedCoverage(intervals, now);
  }

  latestPublicActivitiesBySource(now = new Date()): Activity[] {
    const rows = this.db.prepare(`
      SELECT * FROM (
        SELECT *, ROW_NUMBER() OVER (
          PARTITION BY source
          ORDER BY CASE WHEN occurred_precision IN ('exact', 'day') THEN 0 ELSE 1 END,
                   occurred_at DESC, first_seen_at DESC, id DESC
        ) AS source_rank
        FROM activities
        WHERE visibility = 'public'
          AND (occurred_at IS NULL OR occurred_precision NOT IN ('exact', 'day')
            OR (occurred_precision = 'exact' AND occurred_at <= ?)
            OR (occurred_precision = 'day' AND substr(occurred_at, 1, 10) <= ?))
      ) WHERE source_rank = 1
    `).all(now.toISOString(), taipeiDay(now)) as Record<string, unknown>[];
    return rows.map(row => this.rowToActivity(row));
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
    if (snapshot.source === 'youtube') return this.recordYoutubeLedger(snapshot, now);
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

  // Backloggd logs playtime per game per day, and each (game, day) gets its
  // own watermark (`day:<slug>:<date>` in time_ledger_state) so re-scraped
  // history never double-counts while same-day growth keeps accruing. Unlike
  // the lifetime-delta sources these are explicit dated logs, so first
  // sightings record in full — that is what backfills each recently-played
  // game's whole visible history into the ledger.
  private recordBackloggdLedger(snapshot: SourceSnapshot<unknown>, now = new Date()): void {
    const sessions = backloggdSessions(snapshot);
    if (!sessions.length) return;
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
        VALUES (?, 'backloggd', ?, 'measured', ?, ?)
        ON CONFLICT(day, source) DO UPDATE SET
          seconds=seconds+excluded.seconds,
          detail_json=excluded.detail_json,
          updated_at=excluded.updated_at
      `);
      for (const session of sessions) {
        const seconds = Math.round(session.minutes) * 60;
        const key = `day:${session.game}:${session.day}`;
        const state = readState.get(key) as { value: number } | undefined;
        // A shrunk log (user edited a day downwards) keeps the old watermark:
        // recorded time cannot be taken back, and only growth past the old
        // value will accrue again.
        const delta = Math.max(0, seconds - Number(state?.value ?? 0));
        if (delta > 0) {
          addLedger.run(
            session.day, delta,
            JSON.stringify({ basis: 'daily-log', game: session.game, deltaSeconds: delta }), nowIso
          );
          writeState.run(key, seconds, nowIso);
        }
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
  // urtube is the system of record for YouTube time and its summary carries
  // the whole lifetime per-day series, so the mirror replaces the series
  // instead of accruing deltas: an upstream revision (a re-imported archive,
  // a corrected progress scan) shows up here unchanged.
  private recordYoutubeLedger(snapshot: SourceSnapshot<unknown>, now = new Date()): void {
    const daily = youtubeDailySeries(snapshot);
    if (!daily.length) return;
    const nowIso = now.toISOString();
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.prepare("DELETE FROM time_ledger WHERE source='youtube'").run();
      const insert = this.db.prepare(`
        INSERT INTO time_ledger(day, source, seconds, method, detail_json, updated_at)
        VALUES (?, 'youtube', ?, 'estimated', ?, ?)
      `);
      for (const entry of daily) {
        insert.run(entry.day, entry.seconds, JSON.stringify({ basis: 'urtube-daily', watches: entry.watches }), nowIso);
      }
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

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

    // Health Connect exercise sessions have exact start/end instants, so the
    // duration is measured directly while raw health records stay private.
    const health = activityWindows(`
      SELECT start_at occurred_at,
        MAX(0, (julianday(end_at)-julianday(start_at)) * 86400.0) seconds
      FROM (${PREFERRED_HEALTH_RECORDS}) health_connect_records
      WHERE data_type='exercise_session' AND end_at>=start_at
    `);
    if (health.allTime > 0) sources.push({ source: 'health', method: 'measured', windows: health });

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
    // Backloggd's ledger rows are explicit per-day playtime logs; Simkl's and
    // Kitsu's are lifetime-total deltas; YouTube's are urtube's per-day
    // estimates, mirrored as a whole series.
    const ledgerSources: Array<{ source: string; method: TimeMethod }> = [
      { source: 'simkl', method: 'estimated' },
      { source: 'kitsu', method: 'estimated' },
      { source: 'backloggd', method: 'measured' },
      { source: 'youtube', method: 'estimated' },
    ];
    for (const { source, method } of ledgerSources) {
      const row = ledgerQuery.get(
        taipeiDay(starts.day), taipeiDay(starts.week), taipeiDay(starts.month), taipeiDay(starts.year), source
      ) as Record<string, number>;
      // Ledger data is day-granular, so "last 24 h" honestly approximates to
      // today's Taipei day.
      const windows = windowsFrom({ ...row, last24h: row.day });
      if (windows.allTime > 0) sources.push({ source, method, windows });
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

  ingestHealthConnect(
    batch: HealthConnectBatchInput,
    receivedAt = new Date().toISOString(),
  ): HealthConnectIngestResult {
    const alreadyProcessed = this.db.prepare(
      'SELECT 1 FROM health_connect_syncs WHERE sync_id=?'
    ).get(batch.syncId);
    if (alreadyProcessed) {
      return { inserted: 0, updated: 0, deleted: 0, totalStored: this.healthConnectCount() };
    }

    let inserted = 0;
    let updated = 0;
    let deleted = 0;
    const exists = this.db.prepare('SELECT 1 FROM health_connect_records WHERE record_id=?');
    const upsert = this.db.prepare(`
      INSERT INTO health_connect_records (
        record_id, data_type, data_origin, start_at, end_at, last_modified_at,
        payload_json, first_seen_at, last_seen_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(record_id) DO UPDATE SET
        data_type=excluded.data_type,
        data_origin=excluded.data_origin,
        start_at=excluded.start_at,
        end_at=excluded.end_at,
        last_modified_at=excluded.last_modified_at,
        payload_json=excluded.payload_json,
        last_seen_at=excluded.last_seen_at
    `);
    const remove = this.db.prepare('DELETE FROM health_connect_records WHERE record_id=?');

    this.db.exec('BEGIN IMMEDIATE');
    try {
      for (const record of batch.records) {
        const present = Boolean(exists.get(record.id));
        upsert.run(
          record.id,
          record.dataType,
          record.dataOrigin,
          record.startTime,
          record.endTime,
          record.lastModifiedTime,
          JSON.stringify(record.payload),
          receivedAt,
          receivedAt,
        );
        if (present) updated++;
        else inserted++;
      }
      for (const id of new Set(batch.deletedRecordIds)) {
        if (Number(remove.run(id).changes) > 0) deleted++;
      }
      this.db.prepare(`
        INSERT INTO health_connect_syncs (
          sync_id, device_id, observed_at, received_at, records_seen,
          inserted_count, updated_count, deleted_count
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        batch.syncId,
        batch.deviceId,
        batch.observedAt,
        receivedAt,
        batch.records.length,
        inserted,
        updated,
        deleted,
      );
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
    return { inserted, updated, deleted, totalStored: this.healthConnectCount() };
  }

  private healthConnectCount(): number {
    const row = this.db.prepare('SELECT COUNT(*) count FROM health_connect_records').get() as { count: number };
    return Number(row.count);
  }

  healthConnectStatus(): HealthConnectStatus {
    const latest = this.db.prepare(`
      SELECT device_id, received_at FROM health_connect_syncs
      ORDER BY received_at DESC LIMIT 1
    `).get() as { device_id: string; received_at: string } | undefined;
    const typeRows = this.db.prepare(`
      SELECT data_type, COUNT(*) count FROM health_connect_records
      GROUP BY data_type ORDER BY data_type
    `).all() as Array<{ data_type: string; count: number }>;
    return {
      totalStored: this.healthConnectCount(),
      lastSyncedAt: latest?.received_at ?? null,
      lastDeviceId: latest?.device_id ?? null,
      recordsByType: Object.fromEntries(typeRows.map((row) => [row.data_type, Number(row.count)])),
    };
  }

  healthConnectSnapshot(ownerName: string, now = new Date()): HealthConnectSnapshot {
    const status = this.healthConnectStatus();
    const sleepRows = this.db.prepare(`
      SELECT date(end_at, '+8 hours') day, start_at, end_at,
        json_extract(payload_json, '$.stages') stages_json
      FROM (${PREFERRED_HEALTH_RECORDS}) health_connect_records WHERE data_type='sleep_session'
        AND date(end_at, '+8 hours') IN (
          SELECT date(end_at, '+8 hours') FROM (${PREFERRED_HEALTH_RECORDS}) health_connect_records
          WHERE data_type='sleep_session'
          GROUP BY date(end_at, '+8 hours') ORDER BY date(end_at, '+8 hours') DESC LIMIT 30
        )
      ORDER BY end_at DESC, start_at
    `).all() as Array<{ day: string; start_at: string; end_at: string; stages_json: string | null }>;
    const cutoff = new Date(taipeiWindowStarts(now).day.getTime() - 29 * 86_400_000).toISOString();
    const totals = this.db.prepare(`
      SELECT
        COUNT(DISTINCT date(start_at, '+8 hours')) tracked_days,
        COUNT(DISTINCT CASE WHEN data_type='steps' THEN date(start_at, '+8 hours') END) step_days,
        COUNT(CASE WHEN data_type='exercise_session' THEN 1 END) workouts,
        COALESCE(SUM(CASE WHEN data_type='steps' THEN json_extract(payload_json, '$.count') ELSE 0 END), 0) steps,
        COALESCE(SUM(CASE WHEN data_type='distance' THEN json_extract(payload_json, '$.meters') ELSE 0 END), 0) meters,
        COALESCE(SUM(CASE WHEN data_type='exercise_session'
          THEN MAX(0, (julianday(end_at)-julianday(start_at))*86400.0) ELSE 0 END), 0) exercise_seconds
      FROM (${PREFERRED_HEALTH_RECORDS}) health_connect_records
    `).get() as Record<string, number>;
    const dailyRows = this.db.prepare(`
      SELECT date(start_at, '+8 hours') day,
        COALESCE(SUM(CASE WHEN data_type='steps' THEN json_extract(payload_json, '$.count') ELSE 0 END), 0) steps,
        COALESCE(SUM(CASE WHEN data_type='distance' THEN json_extract(payload_json, '$.meters') ELSE 0 END), 0) meters,
        COALESCE(SUM(CASE WHEN data_type='total_calories_burned' THEN json_extract(payload_json, '$.kilocalories') ELSE 0 END), 0) kilocalories,
        COALESCE(SUM(CASE WHEN data_type='exercise_session' THEN MAX(0, (julianday(end_at)-julianday(start_at))*86400.0) ELSE 0 END), 0) exercise_seconds,
        COALESCE(SUM(CASE WHEN data_type='sleep_session' THEN MAX(0, (julianday(end_at)-julianday(start_at))*86400.0) ELSE 0 END), 0) sleep_seconds
      FROM (${PREFERRED_HEALTH_RECORDS}) health_connect_records
      WHERE start_at>=?
      GROUP BY day ORDER BY day DESC LIMIT 30
    `).all(cutoff) as Array<Record<string, string | number>>;
    const heartRows = this.db.prepare(`
      SELECT date(COALESCE(json_extract(sample.value, '$.time'), records.start_at), '+8 hours') day,
        ROUND(AVG(json_extract(sample.value, '$.beatsPerMinute'))) average_bpm,
        MIN(json_extract(sample.value, '$.beatsPerMinute')) minimum_bpm,
        MAX(json_extract(sample.value, '$.beatsPerMinute')) maximum_bpm
      FROM (${PREFERRED_HEALTH_RECORDS}) records, json_each(records.payload_json, '$.samples') sample
      WHERE records.data_type='heart_rate' AND records.start_at>=?
      GROUP BY day
    `).all(cutoff) as Array<Record<string, string | number>>;
    const heartByDay = new Map(heartRows.map((row) => [String(row.day), row]));
    const daily: HealthDailySummary[] = dailyRows.map((row) => {
      const heart = heartByDay.get(String(row.day));
      return {
        day: String(row.day),
        steps: Math.round(Number(row.steps)),
        distanceMeters: Math.round(Number(row.meters)),
        kilocalories: Math.round(Number(row.kilocalories)),
        exerciseSeconds: Math.round(Number(row.exercise_seconds)),
        sleepSeconds: Math.round(Number(row.sleep_seconds)),
        heartRateAverage: heart ? Math.round(Number(heart.average_bpm)) : null,
        heartRateMinimum: heart ? Math.round(Number(heart.minimum_bpm)) : null,
        heartRateMaximum: heart ? Math.round(Number(heart.maximum_bpm)) : null,
      };
    });
    const latestMeasurement = (dataType: 'weight' | 'body_fat', path: string) => this.db.prepare(`
      SELECT start_at, json_extract(payload_json, ?) value
      FROM (${PREFERRED_HEALTH_RECORDS}) health_connect_records WHERE data_type=?
      ORDER BY start_at DESC LIMIT 1
    `).get(path, dataType) as { start_at: string; value: number } | undefined;
    const weight = latestMeasurement('weight', '$.kilograms');
    const bodyFat = latestMeasurement('body_fat', '$.percentage');
    const exerciseRows = this.db.prepare(`
      SELECT record_id, start_at, end_at, payload_json
      FROM (${PREFERRED_HEALTH_RECORDS}) health_connect_records WHERE data_type='exercise_session'
      ORDER BY start_at DESC LIMIT 20
    `).all() as Array<{ record_id: string; start_at: string; end_at: string; payload_json: string }>;
    const exerciseEntries = exerciseRows.map((row) => {
      const payload = JSON.parse(row.payload_json) as { exerciseType?: number; title?: string | null };
      const exerciseType = Number(payload.exerciseType ?? 0);
      const durationMinutes = Math.max(0, Math.round((Date.parse(row.end_at) - Date.parse(row.start_at)) / 60_000));
      return {
        sourceItemId: createHash('sha256').update(`health-exercise\u001f${row.record_id}`).digest('hex').slice(0, 24),
        visibility: 'summary' as const,
        source: 'health',
        kind: 'fitness' as const,
        title: payload.title || EXERCISE_NAMES[exerciseType] || `Exercise type ${exerciseType}`,
        image: '',
        status: 'workout',
        activityAt: row.start_at,
        rating: null,
        extra: { durationMinutes, exerciseType },
      };
    });
    const dailyEntries = daily.map((day) => ({
      sourceItemId: `day:${day.day}`,
      visibility: 'summary' as const,
      source: 'health',
      kind: 'fitness' as const,
      title: day.steps ? `${day.steps.toLocaleString('en')} steps` : 'Daily health summary',
      image: '',
      status: 'daily',
      activityAt: `${day.day}T00:00:00+08:00`,
      rating: null,
      extra: {
        steps: day.steps,
        distanceKm: Math.round(day.distanceMeters / 100) / 10,
        kilocalories: day.kilocalories,
        exerciseMinutes: Math.round(day.exerciseSeconds / 60),
        sleepHours: Math.round(day.sleepSeconds / 360) / 10,
        ...(day.heartRateAverage === null ? {} : { heartRateAverage: day.heartRateAverage }),
      },
    }));
    const entries = [...dailyEntries, ...exerciseEntries]
      .sort((a, b) => b.activityAt.localeCompare(a.activityAt));
    const totalSteps = Math.round(Number(totals.steps));
    const stepDays = Number(totals.step_days);
    const recentStepDays = this.db.prepare(`
      SELECT date(start_at, '+8 hours') day,
        ROUND(SUM(COALESCE(json_extract(payload_json, '$.count'), 0))) steps
      FROM (${PREFERRED_HEALTH_RECORDS}) health_connect_records WHERE data_type='steps'
      GROUP BY day HAVING steps > 0 ORDER BY day DESC LIMIT 14
    `).all() as Array<{ day: string; steps: number }>;
    const recentExerciseDays = this.db.prepare(`
      SELECT date(start_at, '+8 hours') day, COUNT(*) sessions,
        ROUND(SUM(MAX(0, (julianday(end_at)-julianday(start_at))*86400.0))) seconds
      FROM (${PREFERRED_HEALTH_RECORDS}) health_connect_records WHERE data_type='exercise_session'
      GROUP BY day ORDER BY day DESC LIMIT 3
    `).all() as Array<{ day: string; seconds: number; sessions: number }>;
    return {
      source: 'health',
      profile: { id: 'health-connect', name: ownerName, avatar: '', url: '' },
      stats: {
        records: status.totalStored,
        trackedDays: Number(totals.tracked_days),
        workouts: Number(totals.workouts),
        totalExerciseSeconds: Math.round(Number(totals.exercise_seconds)),
        totalSteps,
        averageDailySteps: stepDays ? Math.round(totalSteps / stepDays) : 0,
        totalDistanceKm: Math.round(Number(totals.meters) / 100) / 10,
      },
      entries,
      extra: {
        daily,
        steps: { days: recentStepDays.map((day) => ({ day: day.day, steps: Number(day.steps) })) },
        exercise: { days: recentExerciseDays.map((day) => ({ day: day.day, seconds: Number(day.seconds), sessions: Number(day.sessions) })) },
        sleep: {
          days: sleepDays(sleepRows),
          totalSessions: status.recordsByType.sleep_session ?? 0,
        },
        latest: {
          weightKilograms: weight ? Math.round(Number(weight.value) * 10) / 10 : null,
          weightAt: weight?.start_at ?? null,
          bodyFatPercentage: bodyFat ? Math.round(Number(bodyFat.value) * 10) / 10 : null,
          bodyFatAt: bodyFat?.start_at ?? null,
        },
        coverage: status.recordsByType,
      },
    };
  }

  healthConnectSleepTime(now = new Date()): TimeWindows {
    const rows = this.db.prepare(`SELECT start_at, end_at FROM (${PREFERRED_HEALTH_RECORDS}) health_connect_records
      WHERE data_type='sleep_session'`).all() as Array<{ start_at: string; end_at: string }>;
    return recordedSleepWindows(rows, now);
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
