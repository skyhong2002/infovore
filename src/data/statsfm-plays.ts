import type { DatabaseSync } from 'node:sqlite';

// stats.fm reports one play in two shapes. /streams/recent first returns the
// live endTime to the millisecond (…:51.977Z); once stats.fm has processed the
// play into its stored history, the same endpoint can return the stored copy,
// floored to the minute (…:00.000Z) and sometimes under a relinked track id.
// The activity identity includes the exact endTime (and the track id), so
// both shapes used to land as separate rows. A floored row is the same play
// as a seconds-precision row in the same minute with the same track id, or
// with the same title and the same artist. Without an artist on either side
// only the track id can tell: a common title ("Intro") is no evidence that two
// plays ending in one minute are one. Two floored rows are the same play only
// under the same track id: two short songs sharing a title can both end in one
// minute, and with no seconds to go on, a different id is the only evidence
// left. Two rows that both keep their seconds are never merged: those are
// separate plays.

export interface StatsfmPlay {
  id: string;
  sourceItemId: string | null;
  title: string;
  artist: string;
  occurredAt: string;
  firstSeenAt: string;
}

// occurred_at is always stored as Date#toISOString(): YYYY-MM-DDTHH:MM:SS.sssZ.
export function isMinuteFloored(occurredAt: string): boolean {
  return occurredAt.slice(16) === ':00.000Z';
}

export function playMinute(occurredAt: string): string {
  return occurredAt.slice(0, 16);
}

function canonical(value: string): string {
  return value.trim().toLocaleLowerCase('en-US').replace(/\s+/g, ' ');
}

export function samePlay(a: StatsfmPlay, b: StatsfmPlay): boolean {
  if (playMinute(a.occurredAt) !== playMinute(b.occurredAt)) return false;
  const aFloored = isMinuteFloored(a.occurredAt);
  const bFloored = isMinuteFloored(b.occurredAt);
  if (!aFloored && !bFloored) return false;
  if (a.sourceItemId && a.sourceItemId === b.sourceItemId) return true;
  if (aFloored && bFloored) return false;
  if (canonical(a.title) !== canonical(b.title)) return false;
  // A missing artist leaves only the title, which is not enough (same track id was checked above).
  if (!a.artist.trim() || !b.artist.trim()) return false;
  return canonical(a.artist) === canonical(b.artist);
}

// Rows to keep first: a seconds-precision row, then the earliest seen.
function preference(a: StatsfmPlay, b: StatsfmPlay): number {
  const precise = Number(isMinuteFloored(a.occurredAt)) - Number(isMinuteFloored(b.occurredAt));
  if (precise) return precise;
  if (a.firstSeenAt !== b.firstSeenAt) return a.firstSeenAt < b.firstSeenAt ? -1 : 1;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

export interface StatsfmDedupePlan {
  remove: string[];
  // Kept rows that absorbed an earlier-seen duplicate: id → earliest first_seen_at.
  firstSeen: Map<string, string>;
}

export function planStatsfmDedupe(rows: StatsfmPlay[]): StatsfmDedupePlan {
  const byMinute = new Map<string, StatsfmPlay[]>();
  for (const row of rows) {
    const minute = playMinute(row.occurredAt);
    const group = byMinute.get(minute);
    if (group) group.push(row);
    else byMinute.set(minute, [row]);
  }
  const remove: string[] = [];
  const firstSeen = new Map<string, string>();
  for (const group of byMinute.values()) {
    if (group.length < 2) continue;
    const kept: StatsfmPlay[] = [];
    for (const row of [...group].sort(preference)) {
      const twin = kept.find((candidate) => samePlay(candidate, row));
      if (!twin) {
        kept.push(row);
        continue;
      }
      remove.push(row.id);
      if (row.firstSeenAt < (firstSeen.get(twin.id) ?? twin.firstSeenAt)) firstSeen.set(twin.id, row.firstSeenAt);
    }
  }
  return { remove, firstSeen };
}

export const STATSFM_PLAY_COLUMNS = `id, source_item_id, title, occurred_at,
  COALESCE(json_extract(extra_json, '$.artist'), '') artist, first_seen_at`;

export function playFromRow(row: Record<string, unknown>): StatsfmPlay {
  return {
    id: String(row.id),
    sourceItemId: row.source_item_id === null ? null : String(row.source_item_id),
    title: String(row.title),
    artist: String(row.artist ?? ''),
    occurredAt: String(row.occurred_at),
    firstSeenAt: String(row.first_seen_at),
  };
}

// Above this share the plan no longer looks like the precision duplicates it
// was written for; keep everything and leave the version for an operator.
export const STATSFM_DEDUPE_MAX_SHARE = 0.6;

export interface StatsfmDedupeResult {
  total: number;
  removed: number;
  aborted: boolean;
}

// Migration 21. On abort nothing changes and user_version stays at 20, so the
// next boot logs and retries; ingest already refuses new duplicates either way.
export function migrateStatsfmPlayDuplicates(
  db: DatabaseSync,
  log: (message: string) => void = (message) => console.warn(message),
): StatsfmDedupeResult {
  db.exec('BEGIN IMMEDIATE');
  try {
    const total = Number((db.prepare("SELECT COUNT(*) count FROM activities WHERE source='statsfm'")
      .get() as { count: number }).count);
    const rows = db.prepare(`SELECT ${STATSFM_PLAY_COLUMNS} FROM activities
      WHERE source='statsfm' AND occurred_precision='exact' AND occurred_at IS NOT NULL`)
      .all() as Record<string, unknown>[];
    const plan = planStatsfmDedupe(rows.map(playFromRow));
    if (plan.remove.length > total * STATSFM_DEDUPE_MAX_SHARE) {
      db.exec('ROLLBACK');
      log(`[migration 21] stats.fm duplicate cleanup aborted: it would remove ${plan.remove.length} of ${total} stats.fm rows, over the ${STATSFM_DEDUPE_MAX_SHARE * 100}% limit; no rows changed`);
      return { total, removed: 0, aborted: true };
    }
    const remove = db.prepare("DELETE FROM activities WHERE id=? AND source='statsfm'");
    for (const id of plan.remove) remove.run(id);
    const keepFirstSeen = db.prepare("UPDATE activities SET first_seen_at=? WHERE id=? AND source='statsfm'");
    for (const [id, seen] of plan.firstSeen) keepFirstSeen.run(seen, id);
    db.exec('PRAGMA user_version = 21');
    db.exec('COMMIT');
    if (plan.remove.length) log(`[migration 21] removed ${plan.remove.length} duplicate stats.fm plays of ${total} stats.fm rows`);
    return { total, removed: plan.remove.length, aborted: false };
  } catch (error) {
    try { db.exec('ROLLBACK'); } catch { /* keep the original error */ }
    throw error;
  }
}
