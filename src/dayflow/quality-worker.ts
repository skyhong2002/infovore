import type { DayflowStore } from './store.js';
import { classifyQualityTitles, type QualityConfig } from './quality.js';

// Ingest is the sole owner. The DB lease also prevents overlapping workers
// during a rollout/restart. Reads and ingestion never wait on the model.
export class DayflowQualityWorker {
  private running = false;
  constructor(private store: DayflowStore, private config: QualityConfig,
    private classify = classifyQualityTitles) {}
  async tick(now = new Date()): Promise<number> {
    if (this.running || !this.store.quality.acquire(+now)) return 0;
    this.running = true;
    let processed = 0;
    try {
      // pending() sorts newest first, so fresh imports take priority over the
      // historical backlog each cycle. Cached titles are never sent again.
      const batches = this.store.batchesSince('0000-00-00');
      for (let round = 0; round < 4; round++) {
        const inputs = this.store.quality.pending(batches, now);
        if (!inputs.length) break;
        try {
          const result = await this.classify(inputs, this.store.quality.known(), this.config);
          this.store.quality.save(inputs, result.labels, this.config.model, result.model);
          processed += inputs.length;
          console.log(`[dayflow-quality] classified ${inputs.length} titles`);
        } catch {
          this.store.quality.failed(inputs);
          // Never log API bodies, activity text, URLs, credentials or IDs.
          console.warn('[dayflow-quality] classification failed; retry after cooldown');
          break;
        }
      }
    } finally { this.store.quality.release(); this.running = false; }
    return processed;
  }
}
export function startDayflowQualityWorker(store: DayflowStore, config: QualityConfig): () => void {
  const worker = new DayflowQualityWorker(store, config);
  let stopped = false, timer: ReturnType<typeof setTimeout>;
  const run = async () => {
    let processed = 0;
    try { processed = await worker.tick(); }
    catch { console.warn('[dayflow-quality] worker unavailable; retrying later'); }
    finally {
      // Drain the backlog without a minute-long pause after every 64 titles.
      // Calls stay serial and bounded; idle/failing workers retain the slower poll.
      if (!stopped) timer = setTimeout(() => void run(), processed === 64 ? 5_000 : 60_000);
    }
  };
  void run();
  return () => { stopped = true; clearTimeout(timer); };
}
