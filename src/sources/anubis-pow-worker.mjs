import { parentPort, workerData } from 'node:worker_threads';
import { createHash } from 'node:crypto';

// Keep the reference nonce order, leading-zero test and exhaustion semantics.
const { randomData, difficulty, maxIters } = workerData;
let solution = null;
for (let nonce = 0; nonce < maxIters; nonce++) {
  const hash = createHash('sha256').update(randomData + nonce).digest('hex');
  let zeros = 0;
  while (zeros < hash.length && hash[zeros] === '0') zeros++;
  if (zeros >= difficulty) { solution = { hash, nonce }; break; }
}
parentPort.postMessage(solution);
