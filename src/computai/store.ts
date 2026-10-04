import type { DatabaseSync } from 'node:sqlite';
import { computaiReportSchema, type ComputaiReport, type ComputaiSnapshot } from './types.js';

export function migrateComputai(db: DatabaseSync): void {
  db.exec(`BEGIN;
    CREATE TABLE computai_reports (
      device_id TEXT PRIMARY KEY, observed_at TEXT NOT NULL, received_at TEXT NOT NULL,
      payload_json TEXT NOT NULL, revision INTEGER NOT NULL DEFAULT 1
    );
    PRAGMA user_version = 13;
    COMMIT;`);
}

// One rolling 30-day report per reporting machine. ComputAI already merges every
// computer it reads, so the newest report is the whole picture.
export class ComputaiStore {
  constructor(private db: DatabaseSync) {}

  ingest(input: ComputaiReport, receivedAt = new Date().toISOString()) {
    const report = computaiReportSchema.parse(input);
    const observed = new Date(report.observedAt).toISOString();
    const result = this.db.prepare(`INSERT INTO computai_reports (device_id, observed_at, received_at, payload_json) VALUES (?, ?, ?, ?)
      ON CONFLICT(device_id) DO UPDATE SET observed_at=excluded.observed_at,
      received_at=excluded.received_at, payload_json=excluded.payload_json, revision=computai_reports.revision+1
      WHERE excluded.observed_at > computai_reports.observed_at`).run(report.deviceId, observed, receivedAt, JSON.stringify(report));
    return { updated: Number(result.changes), observedAt: observed };
  }

  status() {
    const row = this.db.prepare('SELECT MAX(received_at) lastSyncedAt, COALESCE(SUM(revision), 0) revision FROM computai_reports').get()!;
    return { lastSyncedAt: row.lastSyncedAt as string | null, revision: Number(row.revision) };
  }

  snapshot(owner: string): ComputaiSnapshot {
    const row = this.db.prepare('SELECT payload_json FROM computai_reports ORDER BY observed_at DESC LIMIT 1').get() as { payload_json: string } | undefined;
    const report = row ? JSON.parse(row.payload_json) as ComputaiReport : null;
    const { deviceId: _device, schemaVersion: _version, ...open } = report ?? ({} as ComputaiReport);
    return {
      source: 'computai', profile: { id: 'computai', name: owner, avatar: '', url: '' },
      stats: report ? { tokens: report.tokens, agentHours: report.agentHours, peakParallel: report.peakParallel, cacheHitPct: report.cacheHitPct } : {},
      entries: [],
      extra: { report: report ? open : null, lastSyncedAt: this.status().lastSyncedAt },
    };
  }
}
