import type { DayflowPhoneStore, PhoneSegment } from './phone-store.js';
import type { QualityConfig } from './quality.js';
import { fallbackPhoneCards, summarizePhoneSegment } from './phone-summarize.js';

// Segments that keep failing, or are too old to wait for the model, fall back
// to app-run cards so phone time is never lost.
const MAX_ATTEMPTS = 4;
const MAX_WAIT_MS = 48 * 3600_000;

export class DayflowPhoneWorker {
  private running = false;
  constructor(private store: DayflowPhoneStore, private config: QualityConfig | null,
    private summarize = summarizePhoneSegment) {}
  async tick(now = new Date()): Promise<number> {
    if (this.running || !this.store.acquire(+now)) return 0;
    this.running = true;
    let processed = 0;
    try {
      this.store.purge(+now);
      for (const segment of this.store.readySegments(+now)) {
        if (await this.process(segment, now)) processed++;
        else break;
      }
    } finally { this.store.release(); this.running = false; }
    return processed;
  }
  private async process(segment: PhoneSegment, now: Date): Promise<boolean> {
    const attempts = Math.max(...segment.observations.map((o) => o.attempts));
    if (!this.config || attempts >= MAX_ATTEMPTS || +now - segment.end > MAX_WAIT_MS) {
      this.store.saveCards(segment, fallbackPhoneCards(segment), null, +now);
      return true;
    }
    try {
      const result = await this.summarize(segment, this.config);
      this.store.saveCards(segment, result.cards, result.model, +now);
      console.log(`[dayflow-phone] summarized ${segment.observations.length} observations into ${result.cards.length} cards`);
      return true;
    } catch {
      this.store.failed(segment, +now);
      // Never log screen text, images, API bodies or credentials.
      console.warn('[dayflow-phone] summary failed; retry after cooldown');
      return false;
    }
  }
}

export function startDayflowPhoneWorker(store: DayflowPhoneStore, config: QualityConfig | null): () => void {
  const worker = new DayflowPhoneWorker(store, config);
  let stopped = false, timer: ReturnType<typeof setTimeout>;
  const run = async () => {
    let processed = 0;
    try { processed = await worker.tick(); }
    catch { console.warn('[dayflow-phone] worker unavailable; retrying later'); }
    finally { if (!stopped) timer = setTimeout(() => void run(), processed >= 4 ? 5_000 : 60_000); }
  };
  void run();
  return () => { stopped = true; clearTimeout(timer); };
}
