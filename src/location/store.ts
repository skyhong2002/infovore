import type { DatabaseSync } from 'node:sqlite';
import { TAIPEI_OFFSET_MS } from '../data/time.js';
import type {
  LocationActivity, LocationBatch, LocationDay, LocationPoint, LocationSource, LocationStatus, LocationVisit,
} from './types.js';

// Private location history, created on every boot when missing (unversioned:
// the stats.fm cleanup may hold user_version at 20 to retry, so no later step
// may bump it). Times are epoch milliseconds so a
// day is a cheap range scan. A point is keyed by (source, time): the phone
// resending a batch, or the same Timeline export imported twice, changes
// nothing. Visits and activities are keyed by their start, and a re-import
// replaces them (a newer export can refine an old segment).
export function migrateLocation(db: DatabaseSync): void {
  db.exec(`BEGIN;
    CREATE TABLE IF NOT EXISTS location_points (
      source TEXT NOT NULL, recorded_at INTEGER NOT NULL, lat REAL NOT NULL, lng REAL NOT NULL,
      accuracy_m REAL, altitude_m REAL, speed_mps REAL, device_id TEXT NOT NULL, received_at TEXT NOT NULL,
      PRIMARY KEY (source, recorded_at)
    ) WITHOUT ROWID;
    CREATE INDEX IF NOT EXISTS location_points_time ON location_points(recorded_at);
    CREATE TABLE IF NOT EXISTS location_visits (
      source TEXT NOT NULL, start_at INTEGER NOT NULL, end_at INTEGER NOT NULL, lat REAL NOT NULL, lng REAL NOT NULL,
      place_id TEXT, semantic_type TEXT, name TEXT, probability REAL, device_id TEXT NOT NULL, received_at TEXT NOT NULL,
      PRIMARY KEY (source, start_at)
    ) WITHOUT ROWID;
    CREATE INDEX IF NOT EXISTS location_visits_end ON location_visits(end_at);
    CREATE TABLE IF NOT EXISTS location_activities (
      source TEXT NOT NULL, start_at INTEGER NOT NULL, end_at INTEGER NOT NULL,
      start_lat REAL, start_lng REAL, end_lat REAL, end_lng REAL, distance_m REAL, mode TEXT, probability REAL,
      device_id TEXT NOT NULL, received_at TEXT NOT NULL,
      PRIMARY KEY (source, start_at)
    ) WITHOUT ROWID;
    CREATE INDEX IF NOT EXISTS location_activities_end ON location_activities(end_at);
    COMMIT;`);
}

const DAY_MS = 86_400_000;
// The map draws a day's track from at most this many points.
export const MAX_DAY_POINTS = 4_000;
// Fixes less precise than this do not count towards the day's distance.
const DISTANCE_ACCURACY_LIMIT_M = 100;

const iso = (ms: number) => new Date(ms).toISOString();
const nullable = <T,>(value: T | null | undefined): T | null => (value === undefined ? null : value);

export function locationDayBounds(day: string): { start: number; end: number } {
  const start = Date.parse(`${day}T00:00:00.000Z`) - TAIPEI_OFFSET_MS;
  return { start, end: start + DAY_MS };
}

export function distanceBetween(a: { lat: number; lng: number }, b: { lat: number; lng: number }): number {
  const rad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * rad;
  const dLng = (b.lng - a.lng) * rad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLng / 2) ** 2;
  return 2 * 6_371_008.8 * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** Track length over the fixes precise enough to trust, in metres. */
export function trackDistance(points: readonly LocationPoint[]): number {
  let total = 0;
  let previous: LocationPoint | null = null;
  for (const point of points) {
    if (point.accuracy !== null && point.accuracy > DISTANCE_ACCURACY_LIMIT_M) continue;
    if (previous) total += distanceBetween(previous, point);
    previous = point;
  }
  return Math.round(total);
}

function thin<T>(items: T[], max: number): T[] {
  if (items.length <= max) return items;
  const step = (items.length - 1) / (max - 1);
  return Array.from({ length: max }, (_, index) => items[Math.round(index * step)]);
}

interface PointRow { source: LocationSource; recorded_at: number; lat: number; lng: number; accuracy_m: number | null }
interface VisitRow {
  source: LocationSource; start_at: number; end_at: number; lat: number; lng: number;
  place_id: string | null; semantic_type: string | null; name: string | null;
}
interface ActivityRow {
  source: LocationSource; start_at: number; end_at: number; start_lat: number | null; start_lng: number | null;
  end_lat: number | null; end_lng: number | null; distance_m: number | null; mode: string | null;
}

const point = (row: PointRow): LocationPoint => ({
  time: iso(row.recorded_at), lat: row.lat, lng: row.lng, accuracy: row.accuracy_m, source: row.source,
});

export class LocationStore {
  constructor(private readonly db: DatabaseSync) {}

  ingest(batch: LocationBatch, receivedAt = new Date().toISOString()): { points: number; visits: number; activities: number } {
    const insertPoint = this.db.prepare(`INSERT OR IGNORE INTO location_points
      (source, recorded_at, lat, lng, accuracy_m, altitude_m, speed_mps, device_id, received_at) VALUES (?,?,?,?,?,?,?,?,?)`);
    const upsertVisit = this.db.prepare(`INSERT INTO location_visits
      (source, start_at, end_at, lat, lng, place_id, semantic_type, name, probability, device_id, received_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(source, start_at) DO UPDATE SET end_at=excluded.end_at, lat=excluded.lat, lng=excluded.lng,
        place_id=excluded.place_id, semantic_type=excluded.semantic_type, name=COALESCE(excluded.name, location_visits.name),
        probability=excluded.probability, device_id=excluded.device_id, received_at=excluded.received_at`);
    const upsertActivity = this.db.prepare(`INSERT INTO location_activities
      (source, start_at, end_at, start_lat, start_lng, end_lat, end_lng, distance_m, mode, probability, device_id, received_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(source, start_at) DO UPDATE SET end_at=excluded.end_at, start_lat=excluded.start_lat,
        start_lng=excluded.start_lng, end_lat=excluded.end_lat, end_lng=excluded.end_lng, distance_m=excluded.distance_m,
        mode=excluded.mode, probability=excluded.probability, device_id=excluded.device_id, received_at=excluded.received_at`);
    let points = 0;
    let visits = 0;
    let activities = 0;
    this.db.exec('BEGIN IMMEDIATE');
    try {
      for (const p of batch.points) {
        points += Number(insertPoint.run(batch.source, Date.parse(p.time), p.lat, p.lng, nullable(p.accuracy),
          nullable(p.altitude), nullable(p.speed), batch.deviceId, receivedAt).changes);
      }
      for (const v of batch.visits) {
        const start = Date.parse(v.start);
        const end = Math.max(start, Date.parse(v.end));
        visits += Number(upsertVisit.run(batch.source, start, end, v.lat, v.lng, nullable(v.placeId),
          nullable(v.semanticType), nullable(v.name), nullable(v.probability), batch.deviceId, receivedAt).changes);
      }
      for (const a of batch.activities) {
        const start = Date.parse(a.start);
        const end = Math.max(start, Date.parse(a.end));
        activities += Number(upsertActivity.run(batch.source, start, end, nullable(a.startLat), nullable(a.startLng),
          nullable(a.endLat), nullable(a.endLng), nullable(a.distanceMeters), nullable(a.mode), nullable(a.probability),
          batch.deviceId, receivedAt).changes);
      }
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
    return { points, visits, activities };
  }

  latest(): LocationPoint | null {
    const row = this.db.prepare(`SELECT source, recorded_at, lat, lng, accuracy_m FROM location_points
      ORDER BY recorded_at DESC LIMIT 1`).get() as PointRow | undefined;
    return row ? point(row) : null;
  }

  status(): LocationStatus {
    const count = (table: string) => Number((this.db.prepare(`SELECT COUNT(*) n FROM ${table}`).get() as { n: number }).n);
    const live = this.db.prepare("SELECT MAX(recorded_at) at FROM location_points WHERE source='live'").get() as { at: number | null };
    const received = this.db.prepare(`SELECT MAX(r) at FROM (SELECT MAX(received_at) r FROM location_points
      UNION ALL SELECT MAX(received_at) FROM location_visits UNION ALL SELECT MAX(received_at) FROM location_activities)`)
      .get() as { at: string | null };
    const range = this.db.prepare(`SELECT MIN(a) "from", MAX(b) "to" FROM (
      SELECT MIN(recorded_at) a, MAX(recorded_at) b FROM location_points WHERE source='timeline'
      UNION ALL SELECT MIN(start_at), MAX(end_at) FROM location_visits WHERE source='timeline'
      UNION ALL SELECT MIN(start_at), MAX(end_at) FROM location_activities WHERE source='timeline')`)
      .get() as { from: number | null; to: number | null };
    return {
      points: count('location_points'),
      visits: count('location_visits'),
      activities: count('location_activities'),
      latest: this.latest(),
      lastLiveAt: live.at === null ? null : iso(live.at),
      lastReceivedAt: received.at,
      timelineRange: range.from === null || range.to === null ? null : { from: iso(range.from), to: iso(range.to) },
    };
  }

  /** Every point recorded before [until] (epoch ms), oldest first, for the public Places summary. */
  pointsBefore(until: number): Array<{ source: LocationSource; time: number; lat: number; lng: number; accuracy: number | null }> {
    return (this.db.prepare(`SELECT source, recorded_at, lat, lng, accuracy_m FROM location_points
      WHERE recorded_at < ? ORDER BY recorded_at`).all(until) as unknown as PointRow[])
      .map((row) => ({ source: row.source, time: row.recorded_at, lat: row.lat, lng: row.lng, accuracy: row.accuracy_m }));
  }

  /** Every trip that ended before [until]: when, how far and how (no coordinates). */
  activitiesBefore(until: number): Array<{ start: number; end: number; distanceMeters: number | null; mode: string | null }> {
    return (this.db.prepare(`SELECT start_at, end_at, distance_m, mode FROM location_activities
      WHERE end_at < ? ORDER BY start_at`).all(until) as unknown as ActivityRow[])
      .map((row) => ({ start: row.start_at, end: row.end_at, distanceMeters: row.distance_m, mode: row.mode }));
  }

  /** The latest point in [from, until), newest first, as a lazy sequence. */
  *pointsBackwards(from: number, until: number): Generator<{ time: number; lat: number; lng: number; accuracy: number | null }> {
    for (const row of this.db.prepare(`SELECT recorded_at, lat, lng, accuracy_m FROM location_points
      WHERE recorded_at >= ? AND recorded_at < ? ORDER BY recorded_at DESC`).iterate(from, until) as Iterable<PointRow>) {
      yield { time: row.recorded_at, lat: row.lat, lng: row.lng, accuracy: row.accuracy_m };
    }
  }

  /** One Asia/Taipei calendar day: its track, the places stayed at and the trips between them. */
  day(day: string): LocationDay {
    const { start, end } = locationDayBounds(day);
    const rows = this.db.prepare(`SELECT source, recorded_at, lat, lng, accuracy_m FROM location_points
      WHERE recorded_at >= ? AND recorded_at < ? ORDER BY recorded_at`).all(start, end) as unknown as PointRow[];
    const all = rows.map(point);
    const visits = (this.db.prepare(`SELECT source, start_at, end_at, lat, lng, place_id, semantic_type, name
      FROM location_visits WHERE end_at >= ? AND start_at < ? ORDER BY start_at`).all(start, end) as unknown as VisitRow[])
      .map((row): LocationVisit => ({
        start: iso(row.start_at), end: iso(row.end_at), lat: row.lat, lng: row.lng, placeId: row.place_id,
        semanticType: row.semantic_type, name: row.name, source: row.source,
      }));
    const activities = (this.db.prepare(`SELECT source, start_at, end_at, start_lat, start_lng, end_lat, end_lng, distance_m, mode
      FROM location_activities WHERE end_at >= ? AND start_at < ? ORDER BY start_at`).all(start, end) as unknown as ActivityRow[])
      .map((row): LocationActivity => ({
        start: iso(row.start_at), end: iso(row.end_at), startLat: row.start_lat, startLng: row.start_lng,
        endLat: row.end_lat, endLng: row.end_lng, distanceMeters: row.distance_m, mode: row.mode, source: row.source,
      }));
    // Prefer the phone's own fixes for the day's distance; a day known only
    // from the Timeline export uses its segments' distances when it has them.
    const live = all.filter((p) => p.source === 'live');
    const timelineDistance = activities.reduce((sum, a) => sum + (a.distanceMeters ?? 0), 0);
    const distanceMeters = live.length > 1 ? trackDistance(live) : timelineDistance > 0 ? Math.round(timelineDistance) : trackDistance(all);
    return {
      day,
      points: thin(all, MAX_DAY_POINTS),
      thinned: all.length > MAX_DAY_POINTS,
      visits,
      activities,
      distanceMeters,
      latest: this.latest(),
    };
  }
}
