import type { DayflowStore } from './store.js';
import { classifyQualityTitles, type QualityConfig } from './quality.js';
import { dayflowDay } from './types.js';

// Ingest is the sole owner. The DB lease also prevents overlapping workers
// during a rollout/restart. Reads and ingestion never wait on the model.
export class DayflowQualityWorker {
  private running = false;
  constructor(private store: DayflowStore, private config: QualityConfig,
    private classify = classifyQualityTitles) {}
  async tick(now = new Date()): Promise<void> {
    if (this.running || !this.store.quality.acquire(+now)) return;
    this.running = true;
    try {
      const since = dayflowDay(new Date(+now - 96 * 86400000));
      const batches = this.store.batchesSince(since);
      for (let round = 0; round < 4; round++) {
        const inputs = this.store.quality.pending(batches, now);
        if (!inputs.length) break;
        try {
          const result = await this.classify(inputs, this.store.quality.known(), this.config);
          this.store.quality.save(inputs, result.labels, this.config.model, result.model);
          console.log(`[dayflow-quality] classified ${inputs.length} titles`);
        } catch {
          this.store.quality.failed(inputs);
          // Never log API bodies, activity text, URLs, credentials or IDs.
          console.warn('[dayflow-quality] classification failed; retry after cooldown');
          break;
        }
      }
    } finally { this.store.quality.release(); this.running = false; }
  }
}
export function startDayflowQualityWorker(store: DayflowStore, config: QualityConfig): () => void {
  const worker = new DayflowQualityWorker(store, config);
  let stopped = false, timer: ReturnType<typeof setTimeout>;
  const run = async () => {
    try { await worker.tick(); }
    catch { console.warn('[dayflow-quality] worker unavailable; retrying later'); }
    finally { if (!stopped) timer = setTimeout(() => void run(), 60_000); }
  };
  void run();
  return () => { stopped = true; clearTimeout(timer); };
}
