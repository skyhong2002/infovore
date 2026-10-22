import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import * as pow from '../src/sources/anubis-pow.js';

test('PoW preserves reference first nonce/hash and exhaustion', async () => {
  const answer = await pow.solvePow('synthetic', 2, 10_000);
  let expected = null;
  for (let nonce = 0; nonce < 10_000; nonce++) {
    const hash = createHash('sha256').update('synthetic' + nonce).digest('hex');
    if (hash.startsWith('00')) { expected = { nonce, hash }; break; }
  }
  assert.deepEqual(answer, expected);
  assert.equal(await pow.solvePow('synthetic', 65, 100), null);
});

test('bounded solver single-flights identical work and rejects overflow without a queue', async () => {
  assert.equal(typeof pow.PowSolver, 'function', 'bounded worker lifecycle is required');
  const options = { timeoutMs: 150 };
  const solver = new pow.PowSolver(options);
  const a = solver.solve('synthetic', 65);
  const same = solver.solve('synthetic', 65);
  assert.equal(same, a);
  await assert.rejects(solver.solve('different synthetic', 65), /busy/);
  await assert.rejects(a, /deadline/);
  // Use the normal production startup budget for the recovery job; the short
  // first deadline is deliberate fault injection, not a worker-startup SLA.
  options.timeoutMs = 15_000;
  assert.deepEqual(await solver.solve('recovered', 0), { nonce: 0, hash: createHash('sha256').update('recovered0').digest('hex') });
});

for (const [label, source, error] of [
  ['crash', 'throw new Error("synthetic worker crash")', /synthetic worker crash/],
  ['early exit', 'process.exit(0)', /exited without a result/],
] as const) {
  test(`PoW ${label} rejects and releases admission rather than hanging or leaking a worker`, async () => {
    const solver = new pow.PowSolver({ workerUrl: new URL(`data:text/javascript,${encodeURIComponent(source)}`) });
    await assert.rejects(solver.solve('synthetic', 65), error);
    await assert.rejects(solver.solve('different synthetic', 65), error);
  });
}

