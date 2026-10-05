import { taipeiWindowStarts } from '../data/time.js';
import type { DatabaseSync } from 'node:sqlite';
import type { TimeWindows } from '../data/database.js';
import { recordedSleepWindows } from '../health/home.js';
import {
  compactNumber, computaiReportSchema, computaiSegmentsSchema, dailyTokens, duration, WORK_BLOCK_GAP_MS,
  type ComputaiReport, type ComputaiSegments, type ComputaiSnapshot, type WorkBlock,
} from './types.js';

export function migrateComputai(db: DatabaseSync): void {
  db.exec(`BEGIN;
    CREATE TABLE computai_reports (
      device_id TEXT PRIMARY KEY, observed_at TEXT NOT NULL, received_at TEXT NOT NULL,
      payload_json TEXT NOT NULL, revision INTEGER NOT NULL DEFAULT 1
    );
    PRAGMA user_version = 13;
    COMMIT;`);
}

export function migrateComputaiSegments(db: DatabaseSync): void {
  db.exec(`BEGIN;
    CREATE TABLE computai_segments (
      device_id TEXT NOT NULL, source TEXT NOT NULL, machine TEXT NOT NULL, project TEXT NOT NULL,
      session TEXT NOT NULL, subagent INTEGER NOT NULL, start_at TEXT NOT NULL, end_at TEXT NOT NULL,
      tokens INTEGER NOT NULL, requests INTEGER NOT NULL
    );
    CREATE INDEX computai_segments_start ON computai_segments(start_at);
    CREATE TABLE computai_segment_syncs (
      device_id TEXT PRIMARY KEY, received_at TEXT NOT NULL, revision INTEGER NOT NULL DEFAULT 1
    );
    PRAGMA user_version = 14;
    COMMIT;`);
}

export interface AgentPeriod {
  seconds: number;
  tokens: number;
  sessions: number;
  activeDays: number;
  // Work blocks: runs of agent activity split by gaps longer than WORK_BLOCK_GAP_MS,
  // the same unit the timeline shows as "AI agents" entries.
  workBlocks: number;
  projects: Array<{ name: string; tokens: number }>;
  agents: Array<{ name: string; tokens: number }>;
  machines: number;
}

interface SegmentRow { source: string; machine: string; project: string; session: string; start_at: string; end_at: string; tokens: number }

// Total length of a set of intervals, counting overlaps once.
function unionMs(spans: Array<[number, number]>): number {
  let total = 0, end = -Infinity;
  for (const [a, b] of [...spans].sort((x, y) => x[0] - y[0])) {
    if (b <= end) continue;
    total += b - Math.max(a, end);
    end = b;
  }
  return total;
}

// One rolling 30-day report per reporting machine. ComputAI already merges every
// computer it reads, so the newest report is the whole picture. Work segments
// carry the clock times behind it.
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

  // Replaces this reporter's segments that start inside the window, so a resend
  // of the same window is idempotent and sessions that grew are rewritten.
  ingestSegments(input: ComputaiSegments, receivedAt = new Date().toISOString()) {
    const batch = computaiSegmentsSchema.parse(input);
    const iso = (value: string) => new Date(value).toISOString();
    const insert = this.db.prepare(`INSERT INTO computai_segments (device_id, source, machine, project, session, subagent, start_at, end_at, tokens, requests)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    this.db.exec('BEGIN');
    try {
      const removed = this.db.prepare('DELETE FROM computai_segments WHERE device_id = ? AND start_at >= ? AND start_at < ?')
        .run(batch.deviceId, iso(batch.from), iso(batch.to));
      for (const s of batch.segments) {
        insert.run(batch.deviceId, s.source, s.machine, s.project, s.session, s.subagent ? 1 : 0, iso(s.start), iso(s.end), s.tokens, s.requests);
      }
      this.db.prepare(`INSERT INTO computai_segment_syncs (device_id, received_at) VALUES (?, ?)
        ON CONFLICT(device_id) DO UPDATE SET received_at=excluded.received_at, revision=computai_segment_syncs.revision+1`).run(batch.deviceId, receivedAt);
      this.db.exec('COMMIT');
      return { removed: Number(removed.changes), stored: batch.segments.length };
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  status() {
    const reports = this.db.prepare('SELECT MAX(received_at) lastSyncedAt, COALESCE(SUM(revision), 0) revision FROM computai_reports').get()!;
    const segments = this.db.prepare('SELECT MAX(received_at) lastSyncedAt, COALESCE(SUM(revision), 0) revision FROM computai_segment_syncs').get()!;
    const last = [reports.lastSyncedAt, segments.lastSyncedAt].filter(Boolean).sort().at(-1) as string | undefined;
    return { lastSyncedAt: last ?? null, revision: Number(reports.revision) * 100_000 + Number(segments.revision) };
  }

  private segmentsSince(since: string): SegmentRow[] {
    return this.db.prepare('SELECT source, machine, project, session, start_at, end_at, tokens FROM computai_segments WHERE end_at >= ? ORDER BY start_at')
      .all(since) as unknown as SegmentRow[];
  }

  recordedIntervals(since: string): Array<{ source: string; start: number; end: number }> {
    return this.segmentsSince(since).map((s) => ({ source: 'computai', start: Date.parse(s.start_at), end: Date.parse(s.end_at) }));
  }

  // Wall-clock time with any agent working, overlaps counted once, per window.
  // It scans every segment, so Home reuses it until new segments arrive or the
  // five-minute bucket moves.
  private agentTimeCache: { key: string; windows: TimeWindows } | null = null;
  agentTime(now = new Date()): TimeWindows {
    const key = `${this.status().revision}:${Math.floor(+now / 300_000)}`;
    if (this.agentTimeCache?.key !== key) {
      const rows = this.db.prepare('SELECT start_at, end_at FROM computai_segments').all() as Array<{ start_at: string; end_at: string }>;
      this.agentTimeCache = { key, windows: recordedSleepWindows(rows, now) };
    }
    return this.agentTimeCache.windows;
  }

  // Agent wall-clock seconds per Taipei day for the last `days` days, oldest
  // first: segments merged so parallel sessions count once, then split at
  // Taipei midnights.
  agentDaily(now = new Date(), days = 28): number[] {
    const start = +taipeiWindowStarts(now).day - (days - 1) * 86_400_000;
    const merged: Array<[number, number]> = [];
    for (const s of this.segmentsSince(new Date(start).toISOString())) {
      const from = Math.max(start, Date.parse(s.start_at));
      const to = Math.min(+now, Date.parse(s.end_at));
      if (!(to > from)) continue;
      const last = merged.at(-1);
      if (last && from <= last[1]) last[1] = Math.max(last[1], to);
      else merged.push([from, to]);
    }
    const series = new Array<number>(days).fill(0);
    for (let [from, to] of merged) {
      while (from < to) {
        const index = Math.floor((from - start) / 86_400_000);
        const dayEnd = start + (index + 1) * 86_400_000;
        const end = Math.min(to, dayEnd);
        if (index >= 0 && index < days) series[index] += (end - from) / 1000;
        from = end;
      }
    }
    return series.map(Math.round);
  }

  // Agent activity between two instants: wall-clock seconds (parallel
  // sessions once), tokens, distinct sessions, and the heaviest projects,
  // agents and machines by tokens.
  periodSummary(start: Date, end: Date): AgentPeriod {
    const rows = this.db.prepare('SELECT source, machine, project, session, start_at, end_at, tokens FROM computai_segments WHERE end_at >= ? AND start_at < ? ORDER BY start_at')
      .all(start.toISOString(), end.toISOString()) as unknown as SegmentRow[];
    const clipped = rows.map((row) => [Math.max(+start, Date.parse(row.start_at)), Math.min(+end, Date.parse(row.end_at))] as [number, number]).filter(([a, b]) => b > a);
    const rank = (key: (row: SegmentRow) => string) => {
      const totals = new Map<string, number>();
      for (const row of rows) if (key(row)) totals.set(key(row), (totals.get(key(row)) ?? 0) + row.tokens);
      return [...totals].sort((a, b) => b[1] - a[1]).map(([name, tokens]) => ({ name, tokens }));
    };
    const days = new Set(clipped.map(([a]) => new Date(a + 8 * 3_600_000).toISOString().slice(0, 10)));
    let workBlocks = 0;
    let blockEnd = -Infinity;
    for (const [from, to] of [...clipped].sort((a, b) => a[0] - b[0])) {
      if (from > blockEnd + WORK_BLOCK_GAP_MS) workBlocks += 1;
      blockEnd = Math.max(blockEnd, to);
    }
    return {
      seconds: Math.round(unionMs(clipped) / 1000),
      tokens: rows.reduce((sum, row) => sum + row.tokens, 0),
      sessions: new Set(rows.map((row) => `${row.source}|${row.machine}|${row.session || row.project}`)).size,
      activeDays: days.size,
      workBlocks,
      projects: rank((row) => row.project).slice(0, 5),
      agents: rank((row) => row.source),
      machines: rank((row) => row.machine).length,
    };
  }

  workBlocks(since: string): WorkBlock[] {
    const groups: SegmentRow[][] = [];
    let end = -Infinity;
    for (const s of this.segmentsSince(since)) {
      const start = Date.parse(s.start_at), stop = Date.parse(s.end_at);
      if (!groups.length || start > end + WORK_BLOCK_GAP_MS) { groups.push([s]); end = stop; }
      else { groups.at(-1)!.push(s); end = Math.max(end, stop); }
    }
    return groups.map((group) => {
      const byTokens = (key: (s: SegmentRow) => string) => {
        const totals = new Map<string, number>();
        for (const s of group) if (key(s)) totals.set(key(s), (totals.get(key(s)) ?? 0) + s.tokens);
        return [...totals].sort((a, b) => b[1] - a[1]).map(([name]) => name);
      };
      return {
        start: group[0].start_at, end: new Date(Math.max(...group.map((s) => Date.parse(s.end_at)))).toISOString(),
        activeSeconds: Math.round(unionMs(group.map((s) => [Date.parse(s.start_at), Date.parse(s.end_at)])) / 1000),
        tokens: group.reduce((sum, s) => sum + s.tokens, 0),
        sessions: new Set(group.map((s) => `${s.source}|${s.machine}|${s.session || s.project}`)).size,
        sources: byTokens((s) => s.source), projects: byTokens((s) => s.project), machines: byTokens((s) => s.machine),
      };
    }).reverse();
  }

  snapshot(owner: string, now = new Date()): ComputaiSnapshot {
    const row = this.db.prepare('SELECT payload_json FROM computai_reports ORDER BY observed_at DESC LIMIT 1').get() as { payload_json: string } | undefined;
    const report = row ? JSON.parse(row.payload_json) as ComputaiReport : null;
    const { deviceId: _device, schemaVersion: _version, ...open } = report ?? ({} as ComputaiReport);
    const blocks = this.workBlocks(new Date(+now - 14 * 86_400_000).toISOString());
    // Work blocks once segments arrive; before that, one entry per day with usage.
    const entries = blocks.length ? blocks.map((b) => ({
      source: 'computai', sourceItemId: `block:${b.start}`, kind: 'ai' as const, visibility: 'public' as const,
      title: `AI agents · ${duration(b.activeSeconds)}`, image: '/logos/computai.svg', status: 'work_block',
      activityAt: b.start, rating: null, extra: { ...b },
    })) : report ? dailyTokens(report).filter((d) => d.tokens > 0).slice(0, 14).map((d) => ({
      source: 'computai', sourceItemId: `day:${d.day}`, kind: 'ai' as const, visibility: 'public' as const,
      title: `AI agents · ${compactNumber(d.tokens)} tokens`, image: '/logos/computai.svg', status: 'daily_summary',
      activityAt: d.day, rating: null, extra: { tokens: d.tokens },
    })) : [];
    return {
      source: 'computai', profile: { id: 'computai', name: owner, avatar: '', url: '' },
      stats: report ? { tokens: report.tokens, agentHours: Math.round(report.agentHours), sessionsAtOnce: report.peakParallel, promptCachePercent: Math.round(report.cacheHitPct) } : {},
      entries,
      extra: { report: report ? open : null, lastSyncedAt: this.status().lastSyncedAt, blocks: blocks.slice(0, 40) },
    };
  }
}
