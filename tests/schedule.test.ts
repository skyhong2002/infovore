import assert from 'node:assert/strict';
import test from 'node:test';
import { setImmediate } from 'node:timers/promises';
import { nextIntervalAt, refreshAndSchedule, scheduleState, withDeadline } from '../src/data/schedule.js';

test('hourly refreshes align to the next clock hour', () => {
  const now = Date.parse('2026-07-28T12:34:56Z');
  assert.equal(new Date(nextIntervalAt(now, 60)).toISOString(), '2026-07-28T13:00:00.000Z');
});

test('an interval boundary always advances instead of immediately rerunning', () => {
  const boundary = Date.parse('2026-07-28T13:00:00Z');
  assert.equal(new Date(nextIntervalAt(boundary, 60)).toISOString(), '2026-07-28T14:00:00.000Z');
});

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

test('startup and later slow cycles skip elapsed boundaries without overlapping', async (t) => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: Date.parse('2026-07-28T12:59:59Z') });
  const cycles = [deferred(), deferred(), deferred()];
  let starts = 0;
  let active = 0;
  let maximumActive = 0;
  const first = refreshAndSchedule(async () => {
    const cycle = cycles[starts++];
    maximumActive = Math.max(maximumActive, ++active);
    await cycle.promise;
    active--;
  }, 60);
  assert.equal(starts, 1);
  t.mock.timers.tick(2 * 60_000); // The startup cycle crosses 13:00.
  assert.equal(starts, 1);
  cycles[0].resolve();
  await first;

  const untilNext = Date.parse('2026-07-28T14:00:00Z') - Date.now();
  t.mock.timers.tick(untilNext - 1);
  assert.equal(starts, 1);
  t.mock.timers.tick(1);
  assert.equal(starts, 2);
  t.mock.timers.tick(61 * 60_000); // The second cycle also crosses an hour.
  assert.equal(starts, 2);
  cycles[1].resolve();
  await setImmediate(); // Drain promise continuations without wall-clock sleeps.
  const untilThird = Date.parse('2026-07-28T16:00:00Z') - Date.now();
  t.mock.timers.tick(untilThird - 1);
  assert.equal(starts, 2);
  t.mock.timers.tick(1);
  assert.equal(starts, 3);
  cycles[2].resolve();
  await setImmediate();
  assert.equal(active, 0);
  assert.equal(maximumActive, 1);
});

test('a cycle completing exactly on a boundary schedules the following boundary', async (t) => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: Date.parse('2026-07-28T12:59:59Z') });
  const initial = deferred();
  let starts = 0;
  const first = refreshAndSchedule(async () => {
    if (++starts === 1) await initial.promise;
  }, 60);
  t.mock.timers.tick(1000);
  initial.resolve();
  await first;
  t.mock.timers.tick(60 * 60_000 - 1);
  assert.equal(starts, 1);
  t.mock.timers.tick(1);
  assert.equal(starts, 2);
  await setImmediate();
});

test('a rejected initial cycle still schedules a later attempt', async (t) => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: Date.parse('2026-07-28T12:59:00Z') });
  let starts = 0;
  await assert.rejects(refreshAndSchedule(async () => {
    if (++starts === 1) throw new Error('synthetic cycle failure');
  }, 60), /synthetic cycle failure/);
  t.mock.timers.tick(59_999);
  assert.equal(starts, 1);
  t.mock.timers.tick(1);
  assert.equal(starts, 2);
  await setImmediate();
});

test('a cycle that never settles is abandoned and the next boundary still runs', async (t) => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: Date.parse('2026-07-28T12:59:00Z') });
  t.mock.method(console, 'error', () => {});
  let starts = 0;
  const first = refreshAndSchedule(() => { starts++; return new Promise<void>(() => {}); }, 60, 10 * 60_000);
  assert.equal(scheduleState.armedFor, null);
  t.mock.timers.tick(10 * 60_000);
  await assert.rejects(first, /refresh cycle timed out after 600s/);
  assert.equal(new Date(scheduleState.armedFor!).toISOString(), '2026-07-28T14:00:00.000Z');
  t.mock.timers.tick(Date.parse('2026-07-28T14:00:00Z') - Date.now());
  assert.equal(starts, 2);
  // The second hung cycle is abandoned too and arms 15:00 without crashing.
  t.mock.timers.tick(10 * 60_000);
  for (let i = 0; i < 5; i++) await setImmediate();
  assert.equal(new Date(scheduleState.armedFor!).toISOString(), '2026-07-28T15:00:00.000Z');
});

test('withDeadline passes results through and clears its timer', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  assert.equal(await withDeadline(Promise.resolve(7), 1000, 'quick'), 7);
  await assert.rejects(withDeadline(Promise.reject(new Error('own failure')), 1000, 'quick'), /own failure/);
  const slow = withDeadline(new Promise(() => {}), 1000, 'slow work');
  t.mock.timers.tick(1000);
  await assert.rejects(slow, /slow work timed out after 1s/);
});
