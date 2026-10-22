import assert from 'node:assert/strict';
import test from 'node:test';
import { createReadTimer } from '../src/data/read-timing.js';

test('slow-read diagnostics preserve values/errors and log no input data', () => {
  let clock = 0;
  const reports: unknown[] = [];
  const measure = createReadTimer({ now: () => clock, wallNow: () => 0, report: entry => reports.push(entry) });
  const value = { privatePayload: 'must never appear in logs' };
  assert.equal(measure('homepage', () => { clock += 500; return value; }), value);
  const error = new Error('private query parameters');
  assert.throws(() => measure('health_snapshot', () => { clock += 300; throw error; }), e => e === error);
  assert.deepEqual(reports, [
    { phase: 'homepage', startedAt: '1970-01-01T00:00:00.000Z', milliseconds: 500, failed: false },
    { phase: 'health_snapshot', startedAt: '1970-01-01T00:00:00.000Z', milliseconds: 300, failed: true },
  ]);
  assert.doesNotMatch(JSON.stringify(reports), /private|Payload|parameters/);
});

test('diagnostics bound repeated output and cannot replace a work result or error', () => {
  let clock = 0, count = 0;
  const measure = createReadTimer({ now: () => clock, wallNow: () => 0, report: () => { count++; throw new Error('logger'); } });
  assert.equal(measure('homepage', () => { clock += 200; return 1; }), 1);
  assert.equal(count, 0);
  for (let i = 0; i < 3; i++) assert.equal(measure('homepage', () => { clock += 500; return 2; }), 2);
  assert.equal(count, 1);
  clock += 10_000;
  const error = new Error('original');
  assert.throws(() => measure('homepage', () => { clock += 500; throw error; }), e => e === error);
  assert.equal(count, 2);
});
