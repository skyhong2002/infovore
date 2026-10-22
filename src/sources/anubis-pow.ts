import { Worker } from 'node:worker_threads';
export type PowSolution = { hash: string; nonce: number } | null;

// One active job, no waiting queue. An identical challenge shares that job.
// Never release admission until the worker has actually terminated.
export class PowSolver {
  private active: { key: string; promise: Promise<PowSolution> } | null = null;
  constructor(private readonly options: { timeoutMs?: number; workerUrl?: URL } = {}) {}

  solve(randomData: string, difficulty: number, maxIters = 5_000_000): Promise<PowSolution> {
    const key = JSON.stringify([randomData, difficulty, maxIters]);
    if (this.active) return this.active.key === key ? this.active.promise : Promise.reject(new Error('PoW worker busy'));
    const worker = new Worker(this.options.workerUrl ?? new URL('./anubis-pow-worker.mjs', import.meta.url), {
      workerData: { randomData, difficulty, maxIters }, execArgv: [],
    });
    const promise = new Promise<PowSolution>((resolve, reject) => {
      let settled = false;
      const finish = (error: Error | null, value: PowSolution = null) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        void worker.terminate().then(() => {
          this.active = null;
          if (error) reject(error); else resolve(value);
        }, (failure: Error) => {
          // Fail closed: without confirmed termination, releasing this slot
          // could create a second live worker. An operator restart is required.
          reject(failure);
        });
      };
      const timer = setTimeout(() => finish(new Error('PoW deadline exceeded')), this.options.timeoutMs ?? 15_000);
      worker.once('message', (value: PowSolution) => finish(null, value));
      worker.once('error', (error) => finish(error instanceof Error ? error : new Error(String(error))));
      worker.once('exit', (code) => finish(new Error(`PoW worker exited without a result (${code})`)));
    });
    this.active = { key, promise };
    return promise;
  }
}

const solver = new PowSolver();
export const solvePow = (randomData: string, difficulty: number, maxIters = 5_000_000): Promise<PowSolution> =>
  solver.solve(randomData, difficulty, maxIters);
