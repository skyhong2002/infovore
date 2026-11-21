import { narrativeKeywords } from '../dayflow/keywords.js';
import type { PocketlogActivity, PocketlogCategory, PocketlogStore } from './store.js';

// Pulls PocketLog's derived activity cards with a revocable journal device key
// (GET /v1/workspace and the paged GET /v1/activities, PocketLog docs/API.md).
// Every run re-reads the last few days for late uploads and category edits;
// once a day, and on the first run, a longer window. Titles and summaries are
// reduced to fixed-vocabulary keywords here and never stored.

export interface PocketlogConfig { baseUrl: string; token: string; intervalMinutes: number }

const DAY_MS = 86_400_000;
const WINDOW_MS = 30 * DAY_MS; // the API's largest range per read
const RECENT_DAYS = 3;
const FULL_DAYS = 35;
const BACKFILL_DAYS = 400;
const PAGE = 500;

interface ActivitiesPage {
  activities: Array<{ id: string; start_ms: number; end_ms: number; category: string }>;
  cards: Array<{ id: string; category?: string; title?: string; summary?: string; source?: string }>;
  next_cursor: { after_start_ms: number; after_id: string } | null;
  journal_epoch: number;
}

// Only cards summarized by the model or written by the owner are read for
// keywords: app-only cards are titled with the package name (com.google.android…)
// and excerpt cards are raw screen text. Package names are removed regardless.
const KEYWORD_SOURCES = new Set(['ai', 'user']);
const packageName = /\b[a-z][a-z0-9_]*(?:\.[a-z0-9_]+){2,}\b/gi;
export function cardKeywords(card: ActivitiesPage['cards'][number] | undefined): string[] {
  if (!card || !KEYWORD_SOURCES.has(card.source ?? '')) return [];
  return narrativeKeywords((card.title ?? '').replace(packageName, ' '), (card.summary ?? '').replace(packageName, ' '));
}

export class PocketlogHttpError extends Error {
  constructor(readonly status: number) { super(status === 401 ? 'PocketLog refused the key (expired or revoked?)' : `PocketLog HTTP ${status}`); }
}

async function get<T>(config: PocketlogConfig, path: string, fetcher: typeof fetch): Promise<T> {
  const response = await fetcher(`${config.baseUrl}${path}`, {
    headers: { Authorization: `Bearer ${config.token}`, Accept: 'application/json' },
    redirect: 'error', signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) throw new PocketlogHttpError(response.status);
  return await response.json() as T;
}

export async function readCategories(config: PocketlogConfig, fetcher: typeof fetch = fetch): Promise<PocketlogCategory[]> {
  const workspace = await get<{ categories: Array<{ id: string; name: string; color: string }> }>(config, '/v1/workspace', fetcher);
  return workspace.categories.map((c) => ({ id: c.id, name: c.name, color: /^#[0-9a-f]{6}$/i.test(c.color) ? c.color : '#b1a797', idle: c.id === 'idle' }));
}

/** Every activity overlapping [from, to), in ≤ 30-day reads; the epoch must stay the same throughout. */
export async function readActivities(config: PocketlogConfig, from: number, to: number, fetcher: typeof fetch = fetch): Promise<{ epoch: number; activities: PocketlogActivity[] }> {
  const activities: PocketlogActivity[] = [];
  let epoch: number | null = null;
  for (let start = from; start < to; start += WINDOW_MS) {
    const end = Math.min(to, start + WINDOW_MS);
    let cursor: ActivitiesPage['next_cursor'] = null;
    do {
      const query = new URLSearchParams({ from_ms: String(start), to_ms: String(end), limit: String(PAGE) });
      if (cursor && epoch !== null) {
        query.set('after_start_ms', String(cursor.after_start_ms));
        query.set('after_id', cursor.after_id);
        query.set('epoch', String(epoch));
      }
      const page = await get<ActivitiesPage>(config, `/v1/activities?${query}`, fetcher);
      if (epoch !== null && page.journal_epoch !== epoch) throw new Error('PocketLog journal changed during the read');
      epoch = page.journal_epoch;
      const cards = new Map(page.cards.map((card) => [card.id, card]));
      for (const a of page.activities) {
        const card = cards.get(a.id);
        activities.push({ id: a.id, start: a.start_ms, end: a.end_ms, category: card?.category ?? a.category,
          keywords: cardKeywords(card) });
      }
      cursor = page.next_cursor;
    } while (cursor);
  }
  if (epoch === null) throw new Error('PocketLog returned no journal epoch');
  return { epoch, activities };
}

export async function syncPocketlog(store: PocketlogStore, config: PocketlogConfig, now = new Date(), fetcher: typeof fetch = fetch, backfill = false) {
  const status = store.status();
  const latest = store.latestStart();
  const full = backfill || !status.lastFullAt || +now - Date.parse(status.lastFullAt) > DAY_MS;
  const start = +now - (backfill || latest === null ? BACKFILL_DAYS : full ? FULL_DAYS : RECENT_DAYS) * DAY_MS;
  let from = Math.min(start, latest ?? start);
  const to = +now + 60_000;
  const categories = await readCategories(config, fetcher);
  let read = await readActivities(config, from, to, fetcher);
  // The journal was deleted and restarted since the last run: read everything again.
  if (status.journalEpoch !== null && read.epoch !== status.journalEpoch && latest !== null) {
    from = +now - BACKFILL_DAYS * DAY_MS;
    read = await readActivities(config, from, to, fetcher);
  }
  const changed = store.save({
    ...read, categories, full: full || latest === null || read.epoch !== status.journalEpoch,
    window: { from, to, expectedAttempt: status.lastAttemptAt },
  }, now);
  return { read: read.activities.length, changed };
}

export function startPocketlogSync(store: PocketlogStore, config: PocketlogConfig): () => void {
  let running = false;
  const run = async () => {
    if (running) return;
    running = true;
    try {
      const result = await syncPocketlog(store, config);
      if (result.changed) console.log(`pocketlog sync: ${result.changed} of ${result.read} activities changed`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      store.failed(message);
      console.error(`pocketlog sync failed: ${message}`);
    } finally {
      running = false;
    }
  };
  void run();
  const timer = setInterval(run, config.intervalMinutes * 60_000);
  timer.unref();
  return () => clearInterval(timer);
}
