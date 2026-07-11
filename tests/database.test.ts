import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
