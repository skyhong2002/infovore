import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { Repository } from '../src/data/database.js';
import { migrateStatsfmPlayDuplicates, planStatsfmDedupe } from '../src/data/statsfm-plays.js';
import { normalizeStatsfm } from '../src/sources/statsfm.js';

const NOW = new Date('2026-11-12T12:00:00.000Z');

// The /streams/recent item shape: the same play comes back with a
// millisecond endTime and later floored to the minute.
function stream(trackId: number, name: string, endTime: string, durationMs = 180_000, artist = 'Theophany') {
  return {
    platform: 'SPOTIFY', endTime, durationMs,
    track: { id: trackId, name, durationMs, artists: [{ name: artist }], albums: [{ name: 'Album', image: '' }] },
  };
}

function snapshotOf(...items: ReturnType<typeof stream>[]) {
  return normalizeStatsfm('sky', { item: { displayName: 'Sky' } }, { items: {} }, { items: [] }, { items: [] }, { items });
}

function sync(repository: Repository, at: string, ...items: ReturnType<typeof stream>[]) {
  return repository.finishSync(repository.startSync('statsfm', at), snapshotOf(...items), at);
}

function statsfmRows(repository: Repository) {
  const db = (repository as unknown as { db: DatabaseSync }).db;
  return db.prepare("SELECT source_item_id, title, occurred_at, first_seen_at, last_seen_at FROM activities WHERE source='statsfm' ORDER BY occurred_at, title")
    .all() as Array<{ source_item_id: string; title: string; occurred_at: string; first_seen_at: string; last_seen_at: string }>;
}

test('a play reported with seconds and then floored to the minute is stored once, keeping the seconds', () => {
  const repository = new Repository(':memory:');
  try {
    assert.deepEqual(sync(repository, '2026-11-12T11:20:00.000Z', stream(13654053, 'Deku Palace', '2026-11-12T11:14:51.977Z')), { inserted: 1, updated: 0 });
    assert.deepEqual(sync(repository, '2026-11-12T11:40:00.000Z', stream(13654053, 'Deku Palace', '2026-11-12T11:14:00.000Z')), { inserted: 0, updated: 1 });
    // Relinked track id, same title and artist.
    sync(repository, '2026-11-12T11:50:00.000Z', stream(99, 'Deku Palace', '2026-11-12T11:14:00.000Z'));
    const rows = statsfmRows(repository);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].occurred_at, '2026-11-12T11:14:51.977Z');
    assert.equal(rows[0].first_seen_at, '2026-11-12T11:20:00.000Z');
    assert.equal(rows[0].last_seen_at, '2026-11-12T11:50:00.000Z');
  } finally {
    repository.close();
  }
});

test('a floored play stored first is replaced by its seconds-precision copy and keeps the earlier first-seen', () => {
  const repository = new Repository(':memory:');
  try {
    sync(repository, '2026-11-12T11:20:00.000Z', stream(1, 'Track 22', '2026-11-12T09:19:00.000Z'));
    // Same track id, title renamed upstream: still the same play.
    assert.deepEqual(sync(repository, '2026-11-12T11:30:00.000Z', stream(1, 'Santa Be Good to My Baby (Live)', '2026-11-12T09:19:46.214Z')), { inserted: 0, updated: 1 });
    const rows = statsfmRows(repository);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].occurred_at, '2026-11-12T09:19:46.214Z');
    assert.equal(rows[0].title, 'Santa Be Good to My Baby (Live)');
    assert.equal(rows[0].first_seen_at, '2026-11-12T11:20:00.000Z');
    // Both shapes inside one response collapse too.
    sync(repository, '2026-11-12T11:40:00.000Z',
      stream(2, 'Reunion', '2026-11-12T10:31:00.000Z'), stream(2, 'Reunion', '2026-11-12T10:31:08.510Z'));
    assert.deepEqual(statsfmRows(repository).map((row) => row.occurred_at), ['2026-11-12T09:19:46.214Z', '2026-11-12T10:31:08.510Z']);
  } finally {
    repository.close();
  }
});

test('separate plays of one song stay separate rows', () => {
  const repository = new Repository(':memory:');
  try {
    sync(repository, '2026-11-12T11:20:00.000Z',
      stream(1, 'Snow', '2026-11-12T10:00:10.000Z', 22_000), stream(1, 'Snow', '2026-11-12T10:00:40.500Z', 22_000), // two short plays in one minute
      stream(1, 'Snow', '2026-11-12T10:05:00.000Z', 22_000), // a later minute, floored
      stream(2, 'Snow', '2026-11-12T10:07:00.000Z', 22_000, 'Someone Else')); // floored, same title, different artist in another minute
    sync(repository, '2026-11-12T11:30:00.000Z', stream(3, 'Snow', '2026-11-12T10:05:00.000Z', 22_000, 'Someone Else')); // same minute, other song
    assert.equal(statsfmRows(repository).length, 5);
  } finally {
    repository.close();
  }
});

test('Time counts a duplicated play once', () => {
  const repository = new Repository(':memory:');
  try {
    sync(repository, '2026-11-12T11:20:00.000Z', stream(1, 'Reunion', '2026-11-12T10:31:08.510Z', 600_000));
    sync(repository, '2026-11-12T11:40:00.000Z', stream(1, 'Reunion', '2026-11-12T10:31:00.000Z', 600_000));
    const statsfm = repository.timeSpent(NOW).sources.find((entry) => entry.source === 'statsfm');
    assert.equal(statsfm?.windows.last24h, 600);
    assert.equal(statsfm?.windows.day, 600);
    assert.equal(repository.dailyTime(NOW).sources.statsfm?.at(-1), 600);
  } finally {
    repository.close();
  }
});

// Raw rows as migration 21 finds them: written before ingest learned to merge.
function insertRaw(db: DatabaseSync, row: { id: string; source?: string; itemId?: string | null; title: string; at: string; artist?: string; seen?: string; durationMs?: number }) {
  db.prepare(`INSERT INTO activities (id, dedupe_key, source, source_item_id, type, media_kind, title, image, status,
    occurred_at, occurred_precision, rating_value, rating_scale, visibility, extra_json, first_seen_at, last_seen_at)
    VALUES (?, ?, ?, ?, 'music.listened', 'music', ?, '', 'listened', ?, 'exact', NULL, NULL, 'public', ?, ?, ?)`)
    .run(row.id, `key-${row.id}`, row.source ?? 'statsfm', row.itemId ?? row.id, row.title, row.at,
      JSON.stringify({ artist: row.artist ?? 'A', durationMs: row.durationMs ?? 600_000 }), row.seen ?? '2026-11-11T00:00:00.000Z', row.seen ?? '2026-11-11T00:00:00.000Z');
}

function rawDb(repository: Repository): DatabaseSync {
  return (repository as unknown as { db: DatabaseSync }).db;
}

test('migration 21 removes only stats.fm precision duplicates and fixes the music time', () => {
  const repository = new Repository(':memory:');
  try {
    const db = rawDb(repository);
    // Pair: precise + floored copy under another track id, the copy seen first.
    insertRaw(db, { id: 'p1', itemId: '10', title: 'Reunion', at: '2026-11-12T10:31:08.510Z', seen: '2026-11-12T10:40:00.000Z' });
    insertRaw(db, { id: 'f1', itemId: '11', title: 'Reunion', at: '2026-11-12T10:31:00.000Z', seen: '2026-11-12T10:35:00.000Z' });
    // Three floored copies of one play: earliest seen survives.
    insertRaw(db, { id: 'f2a', title: 'Caren\'s Theme', at: '2026-11-12T10:22:00.000Z', seen: '2026-11-11T02:00:00.000Z' });
    insertRaw(db, { id: 'f2b', title: 'caren\'s  theme', at: '2026-11-12T10:22:00.000Z', seen: '2026-11-11T01:00:00.000Z' });
    insertRaw(db, { id: 'f2c', title: 'Caren\'s Theme', at: '2026-11-12T10:22:00.000Z', seen: '2026-11-11T03:00:00.000Z' });
    // Not duplicates: two precise plays in one minute, other minutes, other artist.
    insertRaw(db, { id: 's1', title: 'Snow', at: '2026-11-12T09:00:10.000Z', durationMs: 22_000 });
    insertRaw(db, { id: 's2', title: 'Snow', at: '2026-11-12T09:00:40.000Z', durationMs: 22_000 });
    insertRaw(db, { id: 's3', title: 'Snow', at: '2026-11-12T09:01:00.000Z', durationMs: 22_000 });
    insertRaw(db, { id: 'o1', title: 'Blitzen', at: '2026-11-12T08:27:00.000Z', artist: 'X' });
    insertRaw(db, { id: 'o2', title: 'Blitzen', at: '2026-11-12T08:27:00.000Z', artist: 'Y' });
    // Other sources with the same shape are untouched.
    insertRaw(db, { id: 'y1', source: 'youtube', title: 'Video', at: '2026-11-12T08:00:00.000Z' });
    insertRaw(db, { id: 'y2', source: 'youtube', title: 'Video', at: '2026-11-12T08:00:31.000Z' });
    const before = repository.timeSpent(NOW).sources.find((entry) => entry.source === 'statsfm')!.windows.last24h;
    db.exec('PRAGMA user_version = 20');

    const logs: string[] = [];
    assert.deepEqual(migrateStatsfmPlayDuplicates(db, (message) => logs.push(message)), { total: 10, removed: 3, aborted: false });
    const ids = (db.prepare('SELECT id FROM activities ORDER BY id').all() as Array<{ id: string }>).map((row) => row.id);
    assert.deepEqual(ids, ['f2b', 'o1', 'o2', 'p1', 's1', 's2', 's3', 'y1', 'y2']);
    assert.equal((db.prepare("SELECT first_seen_at FROM activities WHERE id='p1'").get() as { first_seen_at: string }).first_seen_at, '2026-11-12T10:35:00.000Z');
    assert.equal((db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version, 21);
    assert.match(logs.join('\n'), /removed 3 duplicate stats\.fm plays of 10/);
    const after = repository.timeSpent(NOW).sources.find((entry) => entry.source === 'statsfm')!.windows.last24h;
    assert.equal(before - after, 3 * 600);
  } finally {
    repository.close();
  }
});

test('migration 21 keeps everything when it would remove over 60% of stats.fm rows', () => {
  const repository = new Repository(':memory:');
  try {
    const db = rawDb(repository);
    for (let copy = 0; copy < 4; copy++) insertRaw(db, { id: `c${copy}`, itemId: '1', title: 'Loop', at: '2026-11-12T10:00:00.000Z' });
    db.exec('PRAGMA user_version = 20');
    const logs: string[] = [];
    assert.deepEqual(migrateStatsfmPlayDuplicates(db, (message) => logs.push(message)), { total: 4, removed: 0, aborted: true });
    assert.equal((db.prepare("SELECT COUNT(*) count FROM activities WHERE source='statsfm'").get() as { count: number }).count, 4);
    assert.equal((db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version, 20);
    assert.match(logs[0], /aborted: it would remove 3 of 4 stats\.fm rows, over the 60% limit; no rows changed/);
  } finally {
    repository.close();
  }
});

test('migration 21 runs at startup on an existing database', () => {
  const dir = mkdtempSync(join(tmpdir(), 'infovore-statsfm-'));
  const path = join(dir, 'data.sqlite');
  try {
    let repository = new Repository(path);
    const db = rawDb(repository);
    insertRaw(db, { id: 'p', title: 'Reunion', at: '2026-11-12T10:31:08.510Z' });
    insertRaw(db, { id: 'f', title: 'Reunion', at: '2026-11-12T10:31:00.000Z' });
    for (let index = 0; index < 3; index++) insertRaw(db, { id: `k${index}`, title: `Other ${index}`, at: `2026-11-12T0${index}:00:00.000Z` });
    db.exec('PRAGMA user_version = 20');
    const warn = console.warn;
    console.warn = () => {};
    try {
      repository.close();
      repository = new Repository(path);
    } finally {
      console.warn = warn;
    }
    assert.deepEqual(statsfmRows(repository).map((row) => row.occurred_at).filter((at) => at.startsWith('2026-11-12T10')), ['2026-11-12T10:31:08.510Z']);
    repository.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the dedupe plan prefers the seconds-precision row, then the earliest seen', () => {
  const play = (id: string, occurredAt: string, firstSeenAt: string) => ({ id, sourceItemId: id, title: 'T', artist: '', occurredAt, firstSeenAt });
  const plan = planStatsfmDedupe([
    play('floored-early', '2026-11-12T10:00:00.000Z', '2026-11-10T00:00:00.000Z'),
    play('precise-late', '2026-11-12T10:00:42.123Z', '2026-11-12T00:00:00.000Z'),
  ]);
  assert.deepEqual(plan.remove, ['floored-early']);
  assert.deepEqual([...plan.firstSeen], [['precise-late', '2026-11-10T00:00:00.000Z']]);
});
