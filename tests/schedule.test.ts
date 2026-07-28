import assert from 'node:assert/strict';
import test from 'node:test';
import { nextIntervalAt } from '../src/data/schedule.js';

test('hourly refreshes align to the next clock hour', () => {
  const now = Date.parse('2026-07-28T12:34:56Z');
  assert.equal(new Date(nextIntervalAt(now, 60)).toISOString(), '2026-07-28T13:00:00.000Z');
});

test('an interval boundary always advances instead of immediately rerunning', () => {
  const boundary = Date.parse('2026-07-28T13:00:00Z');
  assert.equal(new Date(nextIntervalAt(boundary, 60)).toISOString(), '2026-07-28T14:00:00.000Z');
});
