import type { DatabaseSync } from 'node:sqlite';
import { cleanQualityTitle, QUALITY_VERSION, qualityEligible, qualityHash, type QualityInput, type QualityLabel, type QualityLabels } from './quality.js';
import type { DayflowBatch } from './types.js';

export function migrateDayflowQuality(db: DatabaseSync): void {
  db.exec(`BEGIN;
    CREATE TABLE dayflow_keyword_quality (
      title_hash TEXT PRIMARY KEY, version TEXT NOT NULL, labels_json TEXT,
      requested_model TEXT, resolved_model TEXT, processed_at TEXT,
      retry_at INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE dayflow_keyword_quality_meta (
      id INTEGER PRIMARY KEY CHECK(id = 1), revision INTEGER NOT NULL DEFAULT 0,
      lease_until INTEGER NOT NULL DEFAULT 0
    );
    INSERT INTO dayflow_keyword_quality_meta (id) VALUES (1);
    PRAGMA user_version = 17;
    COMMIT;`);
}

export class DayflowQualityStore {
  constructor(private db: DatabaseSync) {}
  revision(): number {
    return Number(this.db.prepare('SELECT revision FROM dayflow_keyword_quality_meta WHERE id = 1').get()!.revision);
  }
  acquire(now = Date.now()): boolean {
    return Number(this.db.prepare(`UPDATE dayflow_keyword_quality_meta SET lease_until = ? WHERE id = 1 AND lease_until <= ?`)
      .run(now + 600_000, now).changes) === 1;
  }
  release(): void { this.db.prepare('UPDATE dayflow_keyword_quality_meta SET lease_until = 0 WHERE id = 1').run(); }
  pending(batches: DayflowBatch[], now: Date, limit = 16): QualityInput[] {
    const seen = new Set<string>(), result: QualityInput[] = [];
    const lookup = this.db.prepare('SELECT labels_json, retry_at FROM dayflow_keyword_quality WHERE title_hash = ?');
    for (const batch of [...batches].sort((a, b) => b.day.localeCompare(a.day))) for (const card of batch.cards) {
      if (!qualityEligible(batch, card, now)) continue;
      const hash = qualityHash(card.title), title = cleanQualityTitle(card.title);
      if (!title || seen.has(hash)) continue;
      seen.add(hash);
      const cached = lookup.get(hash) as { labels_json: string | null; retry_at: number } | undefined;
      if ((cached?.labels_json !== null && cached?.labels_json !== undefined) || (cached && Number(cached.retry_at) > +now)) continue;
      result.push({ hash, title });
      if (result.length >= limit) return result;
    }
    return result;
  }
  known(): QualityLabel[] {
    const result = new Map<string, QualityLabel>();
    const rows = this.db.prepare(`SELECT labels_json FROM dayflow_keyword_quality WHERE version = ? AND labels_json IS NOT NULL
      ORDER BY processed_at DESC LIMIT 500`).all(QUALITY_VERSION) as Array<{ labels_json: string }>;
    for (const row of rows) for (const label of JSON.parse(row.labels_json) as QualityLabel[]) {
      const key = label.name.toLowerCase();
      if (!result.has(key)) result.set(key, label);
    }
    return [...result.values()].slice(0, 120);
  }
  save(inputs: QualityInput[], labels: QualityLabel[][], requested: string, resolved: string, now = new Date()): void {
    if (labels.length !== inputs.length) throw new Error('Quality result count mismatch');
    const write = this.db.prepare(`INSERT INTO dayflow_keyword_quality
      (title_hash, version, labels_json, requested_model, resolved_model, processed_at, retry_at) VALUES (?, ?, ?, ?, ?, ?, 0)
      ON CONFLICT(title_hash) DO UPDATE SET labels_json=excluded.labels_json, requested_model=excluded.requested_model,
      resolved_model=excluded.resolved_model, processed_at=excluded.processed_at, retry_at=0`);
    this.db.exec('BEGIN IMMEDIATE');
    try {
      inputs.forEach((input, index) => write.run(input.hash, QUALITY_VERSION, JSON.stringify(labels[index]), requested, resolved, now.toISOString()));
      this.db.prepare('UPDATE dayflow_keyword_quality_meta SET revision = revision + 1 WHERE id = 1').run();
      this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  failed(inputs: QualityInput[], now = Date.now()): void {
    const write = this.db.prepare(`INSERT INTO dayflow_keyword_quality (title_hash, version, retry_at) VALUES (?, ?, ?)
      ON CONFLICT(title_hash) DO UPDATE SET retry_at=excluded.retry_at`);
    for (const input of inputs) write.run(input.hash, QUALITY_VERSION, now + 30 * 60_000);
  }
  labelsFor(batches: DayflowBatch[], now: Date): { get: QualityLabels; hasResults: boolean; classified: number; eligible: number; model: string | null } {
    const rows = this.db.prepare(`SELECT title_hash, labels_json, resolved_model FROM dayflow_keyword_quality
      WHERE version = ? AND labels_json IS NOT NULL`).all(QUALITY_VERSION) as Array<{ title_hash: string; labels_json: string; resolved_model: string }>;
    const ready = new Map(rows.map((row) => [row.title_hash, row]));
    const labels = new Map<string, QualityLabel[]>(), seen = new Set<string>();
    let classified = 0, eligible = 0, model: string | null = null;
    for (const batch of [...batches].sort((a, b) => b.observedAt.localeCompare(a.observedAt) || b.day.localeCompare(a.day))) for (const card of batch.cards) {
      if (!qualityEligible(batch, card, now)) continue;
      const id = batch.deviceId + ':' + card.record_id;
      if (seen.has(id)) continue;
      seen.add(id); eligible++;
      const hash = qualityHash(card.title), row = ready.get(hash);
      if (!row) continue;
      classified++; model ??= row.resolved_model;
      if (!labels.has(hash)) labels.set(hash, JSON.parse(row.labels_json) as QualityLabel[]);
    }
    return { get: (title) => labels.get(qualityHash(title)) ?? null, hasResults: rows.length > 0, classified, eligible, model };
  }
}
