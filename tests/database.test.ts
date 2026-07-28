import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { Repository } from '../src/data/database.js';
import type { SourceSnapshot } from '../src/data/types.js';

const snapshot: SourceSnapshot = {
  source: 'kitsu',
  profile: { id: 'sky', name: 'Sky', avatar: '', url: 'https://example.test/sky' },
  stats: { completed: 1 },
  entries: [{
    sourceItemId: '1', source: 'kitsu', kind: 'anime', title: 'Test Anime', image: '',
    status: 'completed', activityAt: '2026-07-10T12:00:00Z', rating: { value: 8, scale: 10 }, extra: { progress: 12 },
  }],
  extra: {},
};

test('snapshots and activities survive reopen and duplicate syncs upsert', () => {
  const dir = mkdtempSync(join(tmpdir(), 'infovore-'));
  const path = join(dir, 'data.sqlite');
  try {
    let repository = new Repository(path);
    const firstId = repository.startSync('kitsu', '2026-07-11T00:00:00Z');
    assert.deepEqual(repository.finishSync(firstId, snapshot, '2026-07-11T00:01:00Z'), { inserted: 1, updated: 0 });
    repository.close();

    repository = new Repository(path);
    assert.equal(repository.loadSnapshots()[0].snapshot.profile.name, 'Sky');
    assert.equal(repository.countActivities(), 1);
    const secondId = repository.startSync('kitsu', '2026-07-11T01:00:00Z');
    assert.deepEqual(repository.finishSync(secondId, snapshot, '2026-07-11T01:01:00Z'), { inserted: 0, updated: 1 });
    assert.equal(repository.countActivities(), 1);
    assert.equal(repository.listActivities()[0].lastSeenAt, '2026-07-11T01:01:00Z');
    assert.equal(repository.latestRuns()[0].status, 'success');
    repository.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('version 1 databases migrate through YouTube schema version 5 without data loss', () => {
  const dir = mkdtempSync(join(tmpdir(), 'infovore-v1-'));
  const path = join(dir, 'data.sqlite');
  try {
    const legacy = new DatabaseSync(path);
    legacy.exec(`
      CREATE TABLE snapshots (
        source TEXT PRIMARY KEY, payload_json TEXT, fetched_at TEXT,
        error TEXT, updated_at TEXT NOT NULL
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
      INSERT INTO activities VALUES (
        'legacy-id', 'legacy-key', 'kitsu', 'legacy-item', 'media.completed',
        'anime', 'Legacy Anime', '', 'completed', '2026-01-01T00:00:00.000Z',
        'instant', NULL, NULL, 'public', '{}',
        '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z'
      );
      PRAGMA user_version = 1;
    `);
    legacy.close();

    const repository = new Repository(path);
    assert.equal(repository.listActivities()[0].title, 'Legacy Anime');
    assert.deepEqual(repository.youtubeCounts(), {
      watches: 0,
      videoWatches: 0,
      videos: 0,
      searches: 0,
      searchQueries: 0,
      channels: 0,
    });
    repository.close();

    const migrated = new DatabaseSync(path);
    const version = migrated.prepare('PRAGMA user_version').get() as { user_version: number };
    const watchColumns = migrated.prepare('PRAGMA table_info(youtube_watch_events)').all() as Array<{ name: string }>;
    const searchColumns = migrated.prepare('PRAGMA table_info(youtube_search_events)').all() as Array<{ name: string }>;
    const channelColumns = migrated.prepare('PRAGMA table_info(youtube_channels)').all() as Array<{ name: string }>;
    const progressColumns = migrated.prepare('PRAGMA table_info(youtube_video_progress)').all() as Array<{ name: string }>;
    const progressImportColumns = migrated.prepare('PRAGMA table_info(youtube_progress_imports)').all() as Array<{ name: string }>;
    const activitiesSql = migrated.prepare(
      "SELECT sql FROM sqlite_master WHERE type='table' AND name='activities'"
    ).get() as { sql: string };
    assert.equal(version.user_version, 5);
    assert.ok(watchColumns.some((column) => column.name === 'activity_type'));
    assert.ok(searchColumns.some((column) => column.name === 'activity_type'));
    assert.ok(channelColumns.some((column) => column.name === 'thumbnail_url'));
    assert.ok(progressColumns.some((column) => column.name === 'progress_seconds'));
    assert.ok(progressImportColumns.some((column) => column.name === 'completed_at'));
    assert.match(activitiesSql.sql, /'summary'/);
    migrated.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('failed sync records error while retaining last-good snapshot', () => {
  const repository = new Repository(':memory:');
  const ok = repository.startSync('kitsu');
  repository.finishSync(ok, snapshot);
  const failed = repository.startSync('kitsu');
  repository.failSync(failed, 'kitsu', 'upstream unavailable');
  const saved = repository.loadSnapshots()[0];
  assert.equal(saved.snapshot.source, 'kitsu');
  assert.equal(saved.error, 'upstream unavailable');
  assert.equal(repository.latestRuns()[0].status, 'error');
  repository.close();
});

test('query filters, privacy, pagination and Wrapped use persisted history', () => {
  const repository = new Repository(':memory:');
  repository.ingestEntries([
    { source: 'events', sourceItemId: 'public', visibility: 'public', kind: 'event', title: 'Public Concert', image: '', status: 'attended', activityAt: '2026-05-01T12:00:00Z', rating: null, extra: { venue: 'Hall' } },
    { source: 'events', sourceItemId: 'private', visibility: 'private', kind: 'event', title: 'Secret Event', image: '', status: 'attended', activityAt: '2026-05-02T12:00:00Z', rating: null, extra: {} },
  ]);
  const page = repository.queryActivities({ kind: 'event', query: 'Concert', limit: 1, offset: 0 });
  assert.equal(page.total, 1);
  assert.equal(page.data[0].title, 'Public Concert');
  assert.equal(repository.queryActivities().total, 1);
  const wrapped = repository.wrapped(2026);
  assert.equal(wrapped.totalActivities, 1);
  assert.deepEqual(wrapped.byKind, { event: 1 });
  repository.close();
});

test('manual event edits update status and occurrence instead of duplicating', () => {
  const repository = new Repository(':memory:');
  const event = {
    source: 'events', sourceItemId: 'stable-event', visibility: 'public' as const,
    kind: 'event' as const, title: 'An event', image: 'https://example.test/event.webp',
    status: 'upcoming', activityAt: '2026-07-29', rating: null, extra: { tags: ['活動'] },
  };
  assert.deepEqual(repository.ingestEntries([event], '2026-07-28T00:00:00Z'), { inserted: 1, updated: 0 });
  assert.deepEqual(repository.ingestEntries([
    { ...event, status: 'attended', activityAt: '2026-07-29T11:00:00Z' },
  ], '2026-07-30T00:00:00Z'), { inserted: 0, updated: 1 });
  const stored = repository.listActivities();
  assert.equal(stored.length, 1);
  assert.equal(stored[0].status, 'attended');
  assert.equal(stored[0].type, 'event.attended');
  assert.equal(stored[0].occurredAt, '2026-07-29T11:00:00.000Z');
  repository.close();
});
