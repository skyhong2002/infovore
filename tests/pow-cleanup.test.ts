import assert from 'node:assert/strict';
import { Worker } from 'node:worker_threads';
import test from 'node:test';
import { PowSolver } from '../src/sources/anubis-pow.js';

test('failed worker termination never releases admission for an unconfirmed cleanup', async (t) => {
  // Finite real worker work exits naturally, so this injected API failure
  // cannot leak an infinite worker into the test runner.
  t.mock.method(Worker.prototype, 'terminate', () => Promise.reject(new Error('synthetic cleanup failure')));
  const solver = new PowSolver();
  await assert.rejects(solver.solve('synthetic', 0), /synthetic cleanup failure/);
  await assert.rejects(solver.solve('different synthetic', 0), /busy/);
});
