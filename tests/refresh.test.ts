import assert from 'node:assert/strict';
import test from 'node:test';
import { setImmediate } from 'node:timers/promises';
import { app, fetchers, refreshSource, repository } from '../src/index.js';
import { getCache } from '../src/data/cache.js';
import type { SourceSnapshot } from '../src/data/types.js';

const snapshot = (source: string): SourceSnapshot<unknown> => ({
  source, profileUrl: `https://example.test/${source}`, fetchedAt: new Date().toISOString(), entries: [], extra: {},
} as unknown as SourceSnapshot<unknown>);

const latestRun = (source: string) => repository.latestRuns().find((run) => run.source === source);

test('a refresh that never settles is failed at its deadline and does not block the next run', async () => {
  let release!: (value: SourceSnapshot<unknown>) => void;
  let calls = 0;
  fetchers['synthetic-hang'] = () => {
    calls++;
    return calls === 1 ? new Promise((resolve) => { release = resolve; }) : Promise.resolve(snapshot('synthetic-hang'));
  };
  await refreshSource('synthetic-hang', true, 20);
  const failed = latestRun('synthetic-hang');
  assert.equal(failed?.status, 'error');
  assert.match(failed?.error ?? '', /synthetic-hang refresh timed out/);
  assert.match(getCache('data:synthetic-hang')?.error ?? '', /timed out/);

  await refreshSource('synthetic-hang', true, 1000);
  const recovered = latestRun('synthetic-hang');
  assert.equal(recovered?.status, 'success');

  // The abandoned first fetch finally answers: it must not touch any run.
  release(snapshot('synthetic-hang'));
  await setImmediate();
  const runs = repository.latestRuns().filter((run) => run.source === 'synthetic-hang');
  assert.equal(runs.length, 1);
  assert.equal(runs[0].id, recovered?.id);
  assert.equal(runs[0].status, 'success');
});

test('a source runs at most once at a time and /status shows the active run', async () => {
  let release!: (value: SourceSnapshot<unknown>) => void;
  let calls = 0;
  fetchers['synthetic-slow'] = () => { calls++; return new Promise((resolve) => { release = resolve; }); };
  const first = refreshSource('synthetic-slow', true, 1000);
  await setImmediate();
  const status = await (await app.request('/status')).json() as { refresh: { running: Array<{ source: string }> } };
  assert.deepEqual(status.refresh.running.map((run) => run.source), ['synthetic-slow']);
  await refreshSource('synthetic-slow', true, 1000);
  assert.equal(calls, 1);
  release(snapshot('synthetic-slow'));
  await first;
  assert.equal(latestRun('synthetic-slow')?.status, 'success');
});

test('a failure while recording a failure keeps the original error and still retries', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const failSync = t.mock.method(repository, 'failSync', () => { throw new Error('database is locked'); });
  const errors = t.mock.method(console, 'error', () => {});
  let calls = 0;
  fetchers['synthetic-fail'] = async () => { calls++; throw new Error('upstream exploded'); };
  await refreshSource('synthetic-fail');
  assert.equal(failSync.mock.callCount(), 1);
  assert.equal(getCache('data:synthetic-fail')?.error, 'upstream exploded');
  const logged = errors.mock.calls.map((call) => String(call.arguments[0]));
  assert.ok(logged.some((line) => line.includes('upstream exploded')));
  assert.ok(logged.some((line) => line.includes('database is locked')));

  t.mock.timers.tick(2 * 60_000);
  for (let i = 0; i < 5; i++) await setImmediate();
  assert.equal(calls, 2);
});

test('runs left running by a previous process are marked abandoned', () => {
  // Earlier tests mocked failSync, so their runs are still open as well.
  const id = repository.startSync('synthetic-orphan');
  assert.ok(repository.abandonRunningSyncs() >= 1);
  const run = latestRun('synthetic-orphan');
  assert.equal(run?.id, id);
  assert.equal(run?.status, 'error');
  assert.match(run?.error ?? '', /abandoned/);
  assert.notEqual(run?.completedAt, null);
  assert.equal(repository.abandonRunningSyncs(), 0);
});
