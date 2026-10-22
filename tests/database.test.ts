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

test('version 1 databases migrate through schema version 9 without data loss', () => {
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
    assert.equal(version.user_version, 14);
    assert.ok(watchColumns.some((column) => column.name === 'activity_type'));
    assert.ok(searchColumns.some((column) => column.name === 'activity_type'));
    assert.ok(channelColumns.some((column) => column.name === 'thumbnail_url'));
    assert.ok(progressColumns.some((column) => column.name === 'progress_seconds'));
    assert.ok(progressImportColumns.some((column) => column.name === 'completed_at'));
    const importSql = migrated.prepare(
      "SELECT sql FROM sqlite_master WHERE type='table' AND name='youtube_imports'"
    ).get() as { sql: string };
    assert.match(importSql.sql, /'extension'/);
    assert.match(activitiesSql.sql, /'summary'/);
    const ledgerSql = migrated.prepare(
      "SELECT sql FROM sqlite_master WHERE type='table' AND name='time_ledger'"
    ).get() as { sql: string } | undefined;
    assert.ok(ledgerSql, 'time_ledger table exists after migration');
    const healthSql = migrated.prepare(
      "SELECT sql FROM sqlite_master WHERE type='table' AND name='health_connect_records'"
    ).get() as { sql: string } | undefined;
    assert.ok(healthSql, 'health_connect_records table exists after migration');
    migrated.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('Health Connect batches upsert records, apply deletions, and are idempotent', () => {
  const repository = new Repository(':memory:');
  const record = {
    id: 'health-record-1',
    dataType: 'steps' as const,
    dataOrigin: 'com.garmin.android.apps.connectmobile',
    startTime: '2026-09-04T00:00:00.000Z',
    endTime: '2026-09-04T01:00:00.000Z',
    lastModifiedTime: '2026-09-04T01:01:00.000Z',
    payload: { count: 1234 },
  };
  const first = {
    syncId: 'health-sync-0001',
    deviceId: 'health-device-01',
    observedAt: '2026-09-04T02:00:00.000Z',
    records: [record],
    deletedRecordIds: [],
  };
  assert.deepEqual(repository.ingestHealthConnect(first, '2026-09-04T02:00:01.000Z'), {
    inserted: 1, updated: 0, deleted: 0, totalStored: 1,
  });
  assert.deepEqual(repository.ingestHealthConnect(first, '2026-09-04T02:00:02.000Z'), {
    inserted: 0, updated: 0, deleted: 0, totalStored: 1,
  });
  assert.deepEqual(repository.ingestHealthConnect({
    ...first,
    syncId: 'health-sync-0002',
    records: [{ ...record, payload: { count: 1500 } }],
  }, '2026-09-04T03:00:00.000Z'), {
    inserted: 0, updated: 1, deleted: 0, totalStored: 1,
  });
  assert.deepEqual(repository.healthConnectStatus(), {
    totalStored: 1,
    lastSyncedAt: '2026-09-04T03:00:00.000Z',
    lastDeviceId: 'health-device-01',
    recordsByType: { steps: 1 },
  });
  assert.deepEqual(repository.ingestHealthConnect({
    ...first,
    syncId: 'health-sync-0003',
    records: [],
    deletedRecordIds: [record.id],
  }, '2026-09-04T04:00:00.000Z'), {
    inserted: 0, updated: 0, deleted: 1, totalStored: 0,
  });
  repository.close();
});

test('Health Connect aggregates use one origin per day, preferring Garmin', () => {
  const repository = new Repository(':memory:');
  const steps = (id: string, dataOrigin: string, day: string, count: number) => ({
    id, dataType: 'steps' as const, dataOrigin,
    startTime: `${day}T01:00:00.000Z`, endTime: `${day}T02:00:00.000Z`, lastModifiedTime: `${day}T02:01:00.000Z`,
    payload: { count },
  });
  repository.ingestHealthConnect({
    syncId: 'health-sync-origins', deviceId: 'health-device-02', observedAt: '2026-09-07T00:00:00.000Z',
    deletedRecordIds: [],
    records: [
      // 2026-09-04: three writers recorded the same walk; only Garmin counts.
      steps('garmin-1', 'com.garmin.android.apps.connectmobile', '2026-09-04', 7148),
      steps('fitbit-1', 'com.fitbit.FitbitMobile', '2026-09-04', 7119),
      steps('phone-1', 'com.android.healthconnect.phone.j7e69ba632e1d3261aff981024c997e44', '2026-09-04', 7182),
      // 2026-09-05: Garmin absent, so Fitbit is used instead of the phone pedometer.
      steps('fitbit-2', 'com.fitbit.FitbitMobile', '2026-09-05', 928),
      steps('phone-2', 'com.android.healthconnect.phone.j7e69ba632e1d3261aff981024c997e44', '2026-09-05', 930),
      // 2026-09-06: a single unknown writer still counts.
      steps('other-3', 'android', '2026-09-06', 500),
    ],
  }, '2026-09-07T00:00:01.000Z');
  const snapshot = repository.healthConnectSnapshot('Sky', new Date('2026-09-07T00:00:00+08:00'));
  assert.deepEqual(snapshot.extra.steps?.days, [
    { day: '2026-09-06', steps: 500 },
    { day: '2026-09-05', steps: 928 },
    { day: '2026-09-04', steps: 7148 },
  ]);
  assert.equal(snapshot.stats.totalSteps, 7148 + 928 + 500);
  assert.equal(snapshot.stats.averageDailySteps, Math.round((7148 + 928 + 500) / 3));
  assert.equal(snapshot.extra.daily.find((d) => d.day === '2026-09-04')?.steps, 7148);
  // Raw storage keeps every record; only the public aggregates prefer one origin.
  assert.equal(repository.healthConnectStatus().totalStored, 6);
  repository.close();
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

test('pagination normalizes invalid numbers without exposing private activities', () => {
  const repository = new Repository(':memory:');
  try {
    repository.ingestEntries([
      { source: 'events', sourceItemId: 'page-old', visibility: 'public', kind: 'event', title: 'Pagination Old', image: '', status: 'attended', activityAt: '2026-05-01T12:00:00Z', rating: null, extra: {} },
      { source: 'events', sourceItemId: 'page-new', visibility: 'public', kind: 'event', title: 'Pagination New', image: '', status: 'attended', activityAt: '2026-05-02T12:00:00Z', rating: null, extra: {} },
      { source: 'events', sourceItemId: 'page-private', visibility: 'private', kind: 'event', title: 'Pagination Private', image: '', status: 'attended', activityAt: '2026-05-03T12:00:00Z', rating: null, extra: {} },
    ]);
    const cases = [
      { label: 'defaults', query: {}, limit: 100, offset: 0, titles: ['Pagination New', 'Pagination Old'] },
      ...[NaN, Infinity, -Infinity].map((value) => ({ label: `invalid limit ${value}`, query: { limit: value }, limit: 100, offset: 0, titles: ['Pagination New', 'Pagination Old'] })),
      ...[NaN, Infinity, -Infinity].map((value) => ({ label: `invalid offset ${value}`, query: { offset: value }, limit: 100, offset: 0, titles: ['Pagination New', 'Pagination Old'] })),
      { label: 'lower bounds', query: { limit: 0, offset: -10 }, limit: 1, offset: 0, titles: ['Pagination New'] },
      { label: 'negative limit', query: { limit: -2 }, limit: 1, offset: 0, titles: ['Pagination New'] },
      { label: 'fractional values', query: { limit: 1.9, offset: 1.9 }, limit: 1, offset: 1, titles: ['Pagination Old'] },
      { label: 'limit upper bound', query: { limit: 1000 }, limit: 500, offset: 0, titles: ['Pagination New', 'Pagination Old'] },
      { label: 'huge finite values', query: { limit: Number.MAX_VALUE, offset: Number.MAX_VALUE }, limit: 500, offset: Number.MAX_SAFE_INTEGER, titles: [] },
    ];
    for (const entry of cases) {
      const page = repository.queryActivities({ source: 'events', query: 'Pagination', ...entry.query });
      assert.equal(page.limit, entry.limit, entry.label);
      assert.equal(page.offset, entry.offset, entry.label);
      assert.equal(page.total, 2, entry.label);
      assert.deepEqual(page.data.map((activity) => activity.title), entry.titles, entry.label);
    }
  } finally {
    repository.close();
  }
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

test('latest source activities reach beyond the global page and exclude private and future records', () => {
  const repository = new Repository(':memory:');
  try {
    const entries = Array.from({ length: 510 }, (_, i) => ({ ...snapshot.entries[0],
      source: 'statsfm', sourceItemId: String(i), activityAt: '2026-08-01T12:00:00Z' }));
    repository.finishSync(repository.startSync('statsfm'), { ...snapshot, source: 'statsfm', entries });
    repository.finishSync(repository.startSync('kitsu'), { ...snapshot, entries: [snapshot.entries[0],
      { ...snapshot.entries[0], sourceItemId: 'future', activityAt: '2027-01-01T00:00:00Z' },
      { ...snapshot.entries[0], sourceItemId: 'private', visibility: 'private', activityAt: '2026-08-02T00:00:00Z' },
    ] });
    assert.equal(repository.listActivities(500).some(a => a.sourceItemId === '1' && a.source === 'kitsu'), false);
    const latest = repository.latestPublicActivitiesBySource(new Date('2026-09-06T00:00:00Z'));
    assert.equal(latest.length, 2);
    assert.equal(latest.find(a => a.source === 'kitsu')?.sourceItemId, '1');
    assert.equal(new Set(latest.map(a => a.source)).size, latest.length);
  } finally { repository.close(); }
});

test('latest source lookup preserves precision, timestamp ties and public-only eligibility', () => {
  const dir = mkdtempSync(join(tmpdir(), 'infovore-latest-'));
  const path = join(dir, 'data.sqlite');
  const repository = new Repository(path);
  const writer = new DatabaseSync(path);
  try {
    assert.deepEqual(repository.latestPublicActivitiesBySource(), []);
    const insert = writer.prepare(`INSERT INTO activities
      (id, dedupe_key, source, source_item_id, type, media_kind, title, image, status,
       occurred_at, occurred_precision, visibility, extra_json, first_seen_at, last_seen_at)
      VALUES (?, ?, ?, ?, 'media.completed', 'book', ?, '', 'completed', ?, ?, ?, ?, ?, ?)`);
    const add = (source: string, id: string, at: string | null, precision = 'exact',
      visibility = 'public', firstSeen = '2026-09-05T00:00:00.000Z') => {
      insert.run(id, id, source, id, id, at, precision, visibility, JSON.stringify({ payload: 'x'.repeat(4096) }), firstSeen, firstSeen);
    };
    add('a-dated', 'dated', '2026-09-05T10:00:00.000Z');
    add('a-dated', 'label-newer', 'Yesterday', 'label');
    add('a-dated', 'future-exact', '2026-09-06T00:00:00.001Z');
    add('a-dated', 'today', '2026-09-06', 'day');
    add('a-dated', 'tomorrow', '2026-09-07', 'day');
    add('b-first-seen', 'first-old', '2026-09-05T10:00:00.000Z');
    add('b-first-seen', 'first-new', '2026-09-05T10:00:00.000Z', 'exact', 'public', '2026-09-05T01:00:00.000Z');
    add('c-id-tie', 'tie-a', '2026-09-05T10:00:00.000Z');
    add('c-id-tie', 'tie-z', '2026-09-05T10:00:00.000Z');
    add('d-fallback', 'unknown', null, 'unknown');
    add('d-fallback', 'label', 'Jul 7', 'label');
    add('e-visibility', 'public', '2026-09-04T00:00:00.000Z');
    add('e-visibility', 'private', '2026-09-05T00:00:00.000Z', 'exact', 'private');
    add('e-visibility', 'summary', '2026-09-06T00:00:00.000Z', 'exact', 'summary');
    add('f-only-future', 'only-future', '2027-01-01T00:00:00.000Z');
    add('g-only-private', 'only-private', null, 'unknown', 'private');
    add('h-only-unknown', 'only-unknown', null, 'unknown');
    const now = new Date('2026-09-06T00:00:00.000Z');
    assert.deepEqual(repository.latestPublicActivitiesBySource(now).map(a => a.sourceItemId),
      ['today', 'first-new', 'tie-z', 'label', 'public', 'only-unknown']);
    assert.ok(repository.latestPublicActivitiesBySource(now).every(a => a.extra.payload === 'x'.repeat(4096)));
    // Same minute, external ingest changes eligibility: invalidate cached IDs.
    writer.prepare("UPDATE activities SET visibility='private' WHERE id='tie-z'").run();
    assert.equal(repository.latestPublicActivitiesBySource(now).find(a => a.source === 'c-id-tie')?.sourceItemId, 'tie-a');
    assert.equal(repository.latestPublicActivitiesBySource(new Date('2026-09-07T00:00:00.000Z'))[0].sourceItemId, 'tomorrow');
  } finally { writer.close(); repository.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('cached reads see writes from another connection, like the ingest container', () => {
  const dir = mkdtempSync(join(tmpdir(), 'infovore-cache-'));
  const reader = new Repository(join(dir, 'db.sqlite'));
  const writer = new Repository(join(dir, 'db.sqlite'));
  try {
    const at = new Date('2026-10-04T08:00:00Z');
    const coverage = () => reader.activityCoverage(at, { dayflow: false, health: false, computai: true }, 1)[0].recordedSeconds;
    const before = reader.healthConnectStatus().totalStored;
    assert.equal(coverage(), 0);                        // cached now
    writer.computai.ingestSegments({ schemaVersion: 1, deviceId: 'mac', observedAt: '2026-10-04T06:00:00Z',
      from: '2026-10-04T00:00:00Z', to: '2026-10-04T06:00:00Z', segments: [{ source: 'codex', machine: 'mac', project: 'p', session: '',
        subagent: false, start: '2026-10-04T01:00:00Z', end: '2026-10-04T01:30:00Z', tokens: 1, requests: 1 }] });
    assert.equal(coverage(), 1800);                     // the other connection's commit invalidated it
    assert.equal(reader.healthConnectStatus().totalStored, before);
  } finally { reader.close(); writer.close(); rmSync(dir, { recursive: true, force: true }); }
});
