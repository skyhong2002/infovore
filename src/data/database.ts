import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { activityFromEntry } from './activity.js';
import type { Activity, SourceSnapshot } from './types.js';
import type {
  YoutubeDashboardData,
  YoutubeCapturedWatch,
  YoutubeCaptureResult,
  YoutubeImportResult,
  YoutubeOAuthCredential,
  YoutubeParsedArchive,
  YoutubeRange,
  YoutubeTopic,
  YoutubeVideoMetadata,
} from '../youtube/types.js';
import { extractYoutubeKeywords } from '../youtube/keywords.js';

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

function youtubeCutoff(range: YoutubeRange, now: Date): string | null {
  if (range === 'all') return null;
  const days = Number.parseInt(range, 10);
  return new Date(now.getTime() - days * 86_400_000).toISOString();
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
        video_id, title, channel_id, channel_title, thumbnail_url
      ) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(video_id) DO UPDATE SET
        title=CASE WHEN youtube_videos.metadata_fetched_at IS NULL THEN excluded.title ELSE youtube_videos.title END,
        channel_id=COALESCE(youtube_videos.channel_id, excluded.channel_id),
        channel_title=COALESCE(youtube_videos.channel_title, excluded.channel_title),
        thumbnail_url=CASE WHEN youtube_videos.thumbnail_url='' THEN excluded.thumbnail_url ELSE youtube_videos.thumbnail_url END
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

    this.db.exec('BEGIN IMMEDIATE');
    try {
      for (const watch of archive.watches) {
        const thumbnail = watch.videoId ? `https://i.ytimg.com/vi/${watch.videoId}/hqdefault.jpg` : '';
        if (watch.videoId) {
          insertVideo.run(watch.videoId, watch.title, watch.channelId, watch.channelTitle, thumbnail);
        }
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
        if (Number(result.changes) > 0) watchesInserted++;
        // A prior interrupted import can leave the generic activity but not the
        // YouTube event. Count only the canonical event insert.
        if (wasPresent && Number(result.changes) === 0) continue;
      }
      for (const search of archive.searches) {
        const result = insertSearch.run(
          search.eventId, search.searchedAt, search.queryCiphertext, importedAt, search.activityType
        );
        if (Number(result.changes) > 0) searchesInserted++;
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

  youtubeDashboard(range: YoutubeRange = '28d', now = new Date()): YoutubeDashboardData {
    const cutoff = youtubeCutoff(range, now);
    const where = cutoff
      ? "WHERE w.activity_type='video' AND w.watched_at>=?"
      : "WHERE w.activity_type='video'";
    const params = cutoff ? [cutoff] : [];
    const stats = this.db.prepare(`
      SELECT COUNT(*) watch_events,
        COUNT(DISTINCT COALESCE(w.video_id, w.raw_url)) unique_videos,
        COUNT(DISTINCT COALESCE(w.channel_id, w.channel_title)) unique_channels,
        COALESCE(SUM(v.duration_seconds), 0) opened_duration_seconds,
        SUM(w.actual_watched_seconds) actual_watched_seconds,
        COUNT(DISTINCT CASE WHEN v.metadata_fetched_at IS NOT NULL THEN w.video_id END) enriched_videos
      FROM youtube_watch_events w
      LEFT JOIN youtube_videos v ON v.video_id=w.video_id
      ${where}
    `).get(...params) as Record<string, number | null>;
    const uniqueVideos = Number(stats.unique_videos ?? 0);
    const daily = this.db.prepare(`
      SELECT strftime('%Y-%m-%d', w.watched_at, '+8 hours') day,
        COUNT(*) watches, COALESCE(SUM(v.duration_seconds), 0) duration_seconds
      FROM youtube_watch_events w LEFT JOIN youtube_videos v ON v.video_id=w.video_id
      ${where}
      GROUP BY day ORDER BY day
    `).all(...params) as Array<Record<string, string | number>>;
    const topChannels = this.db.prepare(`
      SELECT w.channel_id, COALESCE(w.channel_title, v.channel_title, 'Unknown channel') name,
        COUNT(*) watches, COALESCE(SUM(v.duration_seconds), 0) duration_seconds
      FROM youtube_watch_events w LEFT JOIN youtube_videos v ON v.video_id=w.video_id
      ${where}
      GROUP BY COALESCE(w.channel_id, w.channel_title, 'unknown')
      ORDER BY watches DESC, duration_seconds DESC, name LIMIT 12
    `).all(...params) as Array<Record<string, string | number | null>>;
    const topics = this.db.prepare(`
      SELECT t.slug, t.name, COUNT(*) watches, COALESCE(SUM(v.duration_seconds), 0) duration_seconds
      FROM youtube_watch_events w
      JOIN youtube_video_topics vt ON vt.video_id=w.video_id AND vt.rank=1
      JOIN youtube_topics t ON t.id=vt.topic_id
        AND t.taxonomy_version=(SELECT MAX(taxonomy_version) FROM youtube_topics)
      LEFT JOIN youtube_videos v ON v.video_id=w.video_id
      ${where}
      GROUP BY t.id ORDER BY watches DESC, duration_seconds DESC, t.name LIMIT 12
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
      SELECT DISTINCT COALESCE(v.title, w.raw_title) title, v.description, v.tags_json
      FROM youtube_watch_events w LEFT JOIN youtube_videos v ON v.video_id=w.video_id
      ${where}
    `).all(...params) as Array<{ title: string; description: string | null; tags_json: string | null }>;
    return {
      range,
      generatedAt: now.toISOString(),
      stats: {
        watchEvents: Number(stats.watch_events ?? 0),
        uniqueVideos,
        uniqueChannels: Number(stats.unique_channels ?? 0),
        openedDurationSeconds: Number(stats.opened_duration_seconds ?? 0),
        actualWatchedSeconds: stats.actual_watched_seconds === null ? null : Number(stats.actual_watched_seconds),
        metadataCoverage: uniqueVideos ? Number(stats.enriched_videos ?? 0) / uniqueVideos : 0,
      },
      daily: daily.map((row) => ({
        day: String(row.day), watches: Number(row.watches), durationSeconds: Number(row.duration_seconds),
      })),
      lengthBuckets: lengthBuckets.map((row) => ({ label: String(row.label), videos: Number(row.videos) })),
      topChannels: topChannels.map((row) => ({
        channelId: row.channel_id === null ? null : String(row.channel_id),
        name: String(row.name), watches: Number(row.watches), durationSeconds: Number(row.duration_seconds),
      })),
      topics: topics.map((row) => ({
        slug: String(row.slug), name: String(row.name),
        watches: Number(row.watches), durationSeconds: Number(row.duration_seconds),
      })),
      keywords: extractYoutubeKeywords(keywordRows),
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
