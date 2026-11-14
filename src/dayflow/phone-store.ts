import type { DatabaseSync } from 'node:sqlite';
import { dayflowDay, type DayflowBatch } from './types.js';
import { PHONE_CATEGORIES, type PhoneObservationBatch } from './phone-types.js';

export function migrateDayflowPhone(db: DatabaseSync): void {
  db.exec(`BEGIN;
    CREATE TABLE dayflow_phone_observations (
      device_id TEXT NOT NULL, id TEXT NOT NULL, captured_at INTEGER NOT NULL,
      package TEXT NOT NULL, app_label TEXT NOT NULL, text TEXT NOT NULL, blocked INTEGER NOT NULL,
      image BLOB, received_at INTEGER NOT NULL, processed INTEGER NOT NULL DEFAULT 0,
      attempts INTEGER NOT NULL DEFAULT 0, retry_at INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY(device_id, id)
    );
    CREATE INDEX dayflow_phone_observations_pending ON dayflow_phone_observations(processed, device_id, captured_at);
    CREATE TABLE dayflow_phone_cards (
      id INTEGER PRIMARY KEY AUTOINCREMENT, device_id TEXT NOT NULL,
      start_at INTEGER NOT NULL, end_at INTEGER NOT NULL, title TEXT NOT NULL, summary TEXT NOT NULL,
      category TEXT NOT NULL, apps_json TEXT NOT NULL, model TEXT, created_at INTEGER NOT NULL
    );
    CREATE INDEX dayflow_phone_cards_start ON dayflow_phone_cards(start_at);
    CREATE TABLE dayflow_phone_meta (
      id INTEGER PRIMARY KEY CHECK(id = 1), revision INTEGER NOT NULL DEFAULT 0,
      lease_until INTEGER NOT NULL DEFAULT 0
    );
    INSERT INTO dayflow_phone_meta (id) VALUES (1);
    PRAGMA user_version = 18;
    COMMIT;`);
}

export interface PhoneObservationRow {
  id: string; capturedAt: number; package: string; appLabel: string; text: string; blocked: boolean;
  image: Buffer | null; attempts: number;
}
export interface PhoneSegment { deviceId: string; start: number; end: number; observations: PhoneObservationRow[] }
export interface PhoneCardInput { start: number; end: number; title: string; summary: string; category: string; apps: string[] }

// Each capture stands for the time until the next one (the phone samples every
// minute and on every app switch). A longer silence means the screen was off.
export const OBSERVATION_SPAN_MS = 60_000;
export const SEGMENT_GAP_MS = 5 * 60_000;
export const SEGMENT_MAX_MS = 20 * 60_000;
// The phone uploads every five minutes; wait past that before treating the
// newest observations as a finished segment.
export const SEGMENT_SETTLE_MS = 12 * 60_000;

export function buildSegments(deviceId: string, rows: PhoneObservationRow[], now: number): PhoneSegment[] {
  const segments: PhoneSegment[] = [];
  let current: PhoneObservationRow[] = [];
  const close = (closed: boolean) => {
    if (!current.length) return;
    const last = current[current.length - 1];
    if (closed) segments.push({ deviceId, start: current[0].capturedAt, end: last.capturedAt + OBSERVATION_SPAN_MS, observations: current });
    current = [];
  };
  for (const row of rows) {
    const last = current[current.length - 1];
    if (last && row.capturedAt - last.capturedAt > SEGMENT_GAP_MS) close(true);
    else if (current.length && row.capturedAt - current[0].capturedAt >= SEGMENT_MAX_MS) close(true);
    current.push(row);
  }
  const last = current[current.length - 1];
  close(Boolean(last) && now - last.capturedAt > SEGMENT_SETTLE_MS);
  return segments;
}

// Raw screen text and thumbnails live only until their segment is summarized.
export class DayflowPhoneStore {
  constructor(private db: DatabaseSync) {}

  /** Owner-only view; never include observations, screen text, images or device identifiers. */
  activity(day: string, deviceId?: string) {
    const from = Date.parse(`${day}T04:00:00+08:00`), to = from + 86400_000;
    const filter = deviceId ? ' AND device_id = ?' : '';
    const args = deviceId ? [deviceId] : [];
    const rows = this.db.prepare(`SELECT id, start_at, end_at, title, summary, category, apps_json, model
      FROM dayflow_phone_cards WHERE end_at > ? AND start_at < ?${filter}
      ORDER BY start_at DESC, id DESC LIMIT 1001`).all(from, to, ...args);
    const cards = rows.slice(0, 1000).map((r) => ({
      id: Number(r.id), startAt: new Date(Math.max(from, Number(r.start_at))).toISOString(),
      endAt: new Date(Math.min(to, Number(r.end_at))).toISOString(),
      title: String(r.title), summary: String(r.summary), category: String(r.category),
      apps: JSON.parse(String(r.apps_json)) as string[], summarized: r.model !== null,
    }));
    const obs = this.db.prepare(`SELECT MAX(captured_at) last, COUNT(*) pending,
      SUM(attempts > 0) retrying FROM dayflow_phone_observations WHERE processed = 0${filter}`).get(...args)!;
    const last = this.db.prepare(`SELECT MAX(captured_at) last FROM dayflow_phone_observations WHERE 1=1${filter}`).get(...args)!;
    return { day, timezone: 'Asia/Taipei', dayStartsAt: '04:00', cards, truncated: rows.length > 1000,
      status: { pending: Number(obs.pending), retrying: Number(obs.retrying ?? 0),
        lastObservationAt: last.last == null ? null : new Date(Number(last.last)).toISOString(),
        oldestPendingAt: this.oldestPending(deviceId) },
      categories: PHONE_CATEGORIES.map((c) => ({ name: c.name, color: c.color_hex,
        minutes: Math.round(cards.filter((r) => r.category === c.name)
          .reduce((sum, r) => sum + Date.parse(r.endAt) - Date.parse(r.startAt), 0) / 60000) })),
    };
  }

  private oldestPending(deviceId?: string): string | null {
    const row = deviceId
      ? this.db.prepare('SELECT MIN(captured_at) first FROM dayflow_phone_observations WHERE processed = 0 AND device_id = ?').get(deviceId)!
      : this.db.prepare('SELECT MIN(captured_at) first FROM dayflow_phone_observations WHERE processed = 0').get()!;
    return row.first == null ? null : new Date(Number(row.first)).toISOString();
  }

  ingest(batch: PhoneObservationBatch, receivedAt = Date.now()) {
    const insert = this.db.prepare(`INSERT OR IGNORE INTO dayflow_phone_observations
      (device_id, id, captured_at, package, app_label, text, blocked, image, received_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    let accepted = 0;
    this.db.exec('BEGIN');
    try {
      for (const o of batch.observations) {
        accepted += Number(insert.run(batch.deviceId, o.id, Date.parse(o.capturedAt), o.package, o.appLabel || o.package,
          o.blocked ? '' : o.text, o.blocked ? 1 : 0, !o.blocked && o.image ? Buffer.from(o.image, 'base64') : null, receivedAt).changes);
      }
      this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
    return { accepted, duplicates: batch.observations.length - accepted };
  }

  status() {
    const obs = this.db.prepare(`SELECT MAX(captured_at) last, SUM(processed = 0) pending FROM dayflow_phone_observations`).get()!;
    const cards = this.db.prepare('SELECT COUNT(*) n, MAX(end_at) last FROM dayflow_phone_cards').get()!;
    const iso = (v: unknown) => v === null || v === undefined ? null : new Date(Number(v)).toISOString();
    return { lastObservationAt: iso(obs.last), pending: Number(obs.pending ?? 0), cards: Number(cards.n), lastActivityAt: iso(cards.last) };
  }
  revision(): number {
    return Number(this.db.prepare('SELECT revision FROM dayflow_phone_meta WHERE id = 1').get()!.revision);
  }
  acquire(now = Date.now()): boolean {
    return Number(this.db.prepare('UPDATE dayflow_phone_meta SET lease_until = ? WHERE id = 1 AND lease_until <= ?')
      .run(now + 600_000, now).changes) === 1;
  }
  release(): void { this.db.prepare('UPDATE dayflow_phone_meta SET lease_until = 0 WHERE id = 1').run(); }

  readySegments(now = Date.now(), limit = 4): PhoneSegment[] {
    const devices = this.db.prepare(`SELECT DISTINCT device_id FROM dayflow_phone_observations WHERE processed = 0`).all() as Array<{ device_id: string }>;
    const select = this.db.prepare(`SELECT id, captured_at, package, app_label, text, blocked, image, attempts, retry_at
      FROM dayflow_phone_observations WHERE processed = 0 AND device_id = ? ORDER BY captured_at, id LIMIT 3000`);
    const ready: PhoneSegment[] = [];
    for (const { device_id } of devices) {
      const rows = select.all(device_id) as Array<Record<string, unknown>>;
      const segments = buildSegments(device_id, rows.map((r) => ({
        id: String(r.id), capturedAt: Number(r.captured_at), package: String(r.package), appLabel: String(r.app_label),
        text: String(r.text), blocked: Number(r.blocked) === 1, image: r.image ? Buffer.from(r.image as Uint8Array) : null,
        attempts: Number(r.attempts),
      })), now);
      const retryAt = new Map(rows.map((r) => [String(r.id), Number(r.retry_at)]));
      for (const segment of segments) {
        if (segment.observations.some((o) => (retryAt.get(o.id) ?? 0) > now)) continue;
        ready.push(segment);
      }
    }
    return ready.sort((a, b) => a.start - b.start).slice(0, limit);
  }

  saveCards(segment: PhoneSegment, cards: PhoneCardInput[], model: string | null, now = Date.now()): void {
    const insert = this.db.prepare(`INSERT INTO dayflow_phone_cards (device_id, start_at, end_at, title, summary, category, apps_json, model, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    // Keep the IDs (so a re-sent upload stays a duplicate) but drop the content.
    const done = this.db.prepare(`UPDATE dayflow_phone_observations SET processed = 1, text = '', image = NULL WHERE device_id = ? AND id = ?`);
    this.db.exec('BEGIN');
    try {
      for (const c of cards) insert.run(segment.deviceId, c.start, c.end, c.title, c.summary, c.category, JSON.stringify(c.apps), model, now);
      for (const o of segment.observations) done.run(segment.deviceId, o.id);
      this.db.prepare('UPDATE dayflow_phone_meta SET revision = revision + 1 WHERE id = 1').run();
      this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }

  failed(segment: PhoneSegment, now = Date.now()): void {
    const update = this.db.prepare(`UPDATE dayflow_phone_observations SET attempts = attempts + 1, retry_at = ? WHERE device_id = ? AND id = ?`);
    const attempts = Math.max(...segment.observations.map((o) => o.attempts)) + 1;
    const retryAt = now + Math.min(6 * 3600_000, 5 * 60_000 * 2 ** (attempts - 1));
    for (const o of segment.observations) update.run(retryAt, segment.deviceId, o.id);
  }

  purge(now = Date.now()): void {
    this.db.prepare('DELETE FROM dayflow_phone_observations WHERE processed = 1 AND captured_at < ?').run(now - 14 * 86400_000);
  }

  // Cards as Dayflow day batches so the computer summaries can be reused.
  // A card that crosses the 4am boundary appears in both days and is clipped.
  batchesSince(day: string, now = new Date()): DayflowBatch[] {
    const from = Date.parse(`${day}T04:00:00+08:00`);
    const rows = this.db.prepare(`SELECT id, device_id, start_at, end_at, title, summary, category FROM dayflow_phone_cards
      WHERE end_at > ? ORDER BY start_at`).all(from) as Array<Record<string, unknown>>;
    const byDay = new Map<string, DayflowBatch>();
    for (const r of rows) {
      const start = Number(r.start_at), end = Number(r.end_at);
      for (const d of new Set([dayflowDay(new Date(start)), dayflowDay(new Date(Math.max(start, end - 1)))])) {
        if (d < day) continue;
        const batch = byDay.get(d) ?? { schemaVersion: 1 as const, deviceId: `phone-${String(r.device_id)}`.slice(0, 100), day: d,
          observedAt: now.toISOString(), timeZone: 'Asia/Taipei' as const, dayBoundaryHour: 4 as const,
          categories: PHONE_CATEGORIES.map((c) => ({ ...c })), cards: [] };
        batch.cards.push({ record_id: Number(r.id), start: new Date(start).toISOString(), end: new Date(end).toISOString(),
          title: String(r.title), summary: String(r.summary), category: String(r.category), duration_minutes: (end - start) / 60000 });
        byDay.set(d, batch);
      }
    }
    return [...byDay.values()];
  }
}
