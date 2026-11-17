import type { DatabaseSync } from 'node:sqlite';
import { clearZonesRgba, encodePng, exploredKm2, parseTile, renderFogRgba, type FogTile } from './tiles.js';
import type { PrivacyZone } from '../location/zones.js';

// Fog of World tiles mirrored from the owner's Dropbox (src/fog/dropbox.ts).
// The files are kept as Dropbox has them (with their revision) so a sync only
// downloads what changed; they are decoded when read. Private, like location.
// Created when missing on every boot (unversioned, see migrateLocation).
export function migrateFog(db: DatabaseSync): void {
  db.exec(`BEGIN;
    CREATE TABLE IF NOT EXISTS fog_tiles (
      name TEXT PRIMARY KEY, rev TEXT NOT NULL, data BLOB NOT NULL, synced_at TEXT NOT NULL
    ) WITHOUT ROWID;
    CREATE TABLE IF NOT EXISTS fog_sync (
      id INTEGER PRIMARY KEY CHECK (id = 1), last_attempt_at TEXT, last_success_at TEXT, last_change_at TEXT, last_error TEXT
    );
    -- Earlier revisions, so the public map can show the fog as it was a few
    -- days ago (src/location/public.ts); pruned to the newest one past the delay.
    CREATE TABLE IF NOT EXISTS fog_tile_history (
      name TEXT NOT NULL, synced_at TEXT NOT NULL, rev TEXT NOT NULL, data BLOB NOT NULL, PRIMARY KEY (name, synced_at)
    ) WITHOUT ROWID;
    INSERT OR IGNORE INTO fog_tile_history (name, synced_at, rev, data)
      SELECT name, synced_at, rev, data FROM fog_tiles WHERE NOT EXISTS (SELECT 1 FROM fog_tile_history h WHERE h.name = fog_tiles.name);
    -- The public explored area, once a Taipei day, for growth over time.
    CREATE TABLE IF NOT EXISTS fog_area_daily (day TEXT PRIMARY KEY, km2 REAL NOT NULL) WITHOUT ROWID;
    COMMIT;`);
}

export interface FogStatus {
  tiles: number;
  blocks: number;
  exploredKm2: number;
  lastSuccessAt: string | null;
  lastChangeAt: string | null;
  lastError: string | null;
  /** Tiles that could not be decoded (left out of the map). */
  unreadable: number;
}

interface Decoded {
  version: string;
  tiles: Map<string, FogTile>;
  unreadable: number;
  km2: number;
  blocks: number;
}

export class FogStore {
  private decoded: Decoded | null = null;
  private pngCache = new Map<string, Buffer>();
  private publicDecoded: Decoded | null = null;
  private publicPngCache = new Map<string, Buffer>();

  constructor(private readonly db: DatabaseSync) {}

  revisions(): Map<string, string> {
    const rows = this.db.prepare('SELECT name, rev FROM fog_tiles').all() as Array<{ name: string; rev: string }>;
    return new Map(rows.map((row) => [row.name, row.rev]));
  }

  put(name: string, rev: string, data: Uint8Array, at = new Date().toISOString()): void {
    this.db.prepare(`INSERT INTO fog_tiles (name, rev, data, synced_at) VALUES (?,?,?,?)
      ON CONFLICT(name) DO UPDATE SET rev=excluded.rev, data=excluded.data, synced_at=excluded.synced_at`).run(name, rev, data, at);
    this.db.prepare('INSERT OR REPLACE INTO fog_tile_history (name, synced_at, rev, data) VALUES (?,?,?,?)').run(name, at, rev, data);
  }

  remove(name: string): void {
    this.db.prepare('DELETE FROM fog_tiles WHERE name = ?').run(name);
    this.db.prepare('DELETE FROM fog_tile_history WHERE name = ?').run(name);
  }

  /** Drops revisions no public view can need: all but the newest at or before [cutoff], per tile. */
  pruneHistory(cutoff: string): number {
    return Number(this.db.prepare(`DELETE FROM fog_tile_history WHERE synced_at < ?
      AND synced_at < (SELECT MAX(h.synced_at) FROM fog_tile_history h WHERE h.name = fog_tile_history.name AND h.synced_at <= ?)`)
      .run(cutoff, cutoff).changes);
  }

  /** The tiles as they were at [cutoff]: each tile's newest revision synced by then. */
  private loadAt(cutoff: string): Decoded {
    const chosen = this.db.prepare('SELECT name, MAX(synced_at) at FROM fog_tile_history WHERE synced_at <= ? GROUP BY name ORDER BY name')
      .all(cutoff) as Array<{ name: string; at: string }>;
    const version = chosen.map((row) => `${row.name}@${row.at}`).join('|');
    if (this.publicDecoded?.version === version) return this.publicDecoded;
    const tiles = new Map<string, FogTile>();
    let unreadable = 0;
    const read = this.db.prepare('SELECT data FROM fog_tile_history WHERE name = ? AND synced_at = ?');
    for (const row of chosen) {
      try {
        const tile = parseTile(row.name, (read.get(row.name, row.at) as { data: Uint8Array }).data);
        tiles.set(`${tile.x},${tile.y}`, tile);
      } catch {
        unreadable++;
      }
    }
    let blocks = 0;
    for (const tile of tiles.values()) blocks += tile.blocks.length;
    this.publicDecoded = { version, tiles, unreadable, km2: exploredKm2(tiles.values()), blocks };
    this.publicPngCache.clear();
    return this.publicDecoded;
  }

  /** Tiles, blocks and explored area as of [cutoff]; [version] changes whenever they do. */
  publicState(cutoff: string): { version: string; tiles: ReadonlyMap<string, FogTile>; exploredKm2: number } {
    const data = this.loadAt(cutoff);
    return { version: data.version, tiles: data.tiles, exploredKm2: Math.round(data.km2 * 100) / 100 };
  }

  /** The public overlay as of [cutoff], with every privacy zone cleared. */
  publicPng(z: number, x: number, y: number, cutoff: string, zones: readonly PrivacyZone[]): Buffer | null {
    if (!Number.isInteger(z) || z < 0 || z > 20) return null;
    const n = 2 ** z;
    if (!Number.isInteger(x) || !Number.isInteger(y) || x < 0 || y < 0 || x >= n || y >= n) return null;
    const data = this.loadAt(cutoff);
    const key = `${z}/${x}/${y}`;
    const cached = this.publicPngCache.get(key);
    if (cached) return cached;
    const rgba = renderFogRgba(data.tiles, z, x, y);
    clearZonesRgba(rgba, z, x, y, zones);
    const png = encodePng(rgba, 256, 256);
    if (this.publicPngCache.size >= 600) this.publicPngCache.delete(this.publicPngCache.keys().next().value!);
    this.publicPngCache.set(key, png);
    return png;
  }

  recordArea(day: string, km2: number): void {
    this.db.prepare('INSERT INTO fog_area_daily (day, km2) VALUES (?, ?) ON CONFLICT(day) DO UPDATE SET km2 = excluded.km2').run(day, km2);
  }

  areaHistory(): Array<{ day: string; km2: number }> {
    return this.db.prepare('SELECT day, km2 FROM fog_area_daily ORDER BY day').all() as Array<{ day: string; km2: number }>;
  }

  recordSync(outcome: { at: string; changed: boolean; error?: string | null }): void {
    this.db.prepare(`INSERT INTO fog_sync (id, last_attempt_at, last_success_at, last_change_at, last_error) VALUES (1, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET last_attempt_at=excluded.last_attempt_at,
        last_success_at=COALESCE(excluded.last_success_at, fog_sync.last_success_at),
        last_change_at=COALESCE(excluded.last_change_at, fog_sync.last_change_at),
        last_error=excluded.last_error`)
      .run(outcome.at, outcome.error ? null : outcome.at, outcome.changed ? outcome.at : null, outcome.error ?? null);
  }

  /** Decodes the stored tiles once per change of the table (another process writes it). */
  private load(): Decoded {
    const stamp = this.db.prepare('SELECT COUNT(*) n, MAX(synced_at) at, (SELECT last_change_at FROM fog_sync WHERE id = 1) c FROM fog_tiles')
      .get() as { n: number; at: string | null; c: string | null };
    const version = `${stamp.n}:${stamp.at}:${stamp.c}`;
    if (this.decoded?.version === version) return this.decoded;
    const tiles = new Map<string, FogTile>();
    let unreadable = 0;
    for (const row of this.db.prepare('SELECT name, data FROM fog_tiles').iterate() as Iterable<{ name: string; data: Uint8Array }>) {
      try {
        const tile = parseTile(row.name, row.data);
        tiles.set(`${tile.x},${tile.y}`, tile);
      } catch {
        unreadable++;
      }
    }
    let blocks = 0;
    for (const tile of tiles.values()) blocks += tile.blocks.length;
    this.decoded = { version, tiles, unreadable, km2: exploredKm2(tiles.values()), blocks };
    this.pngCache.clear();
    return this.decoded;
  }

  status(): FogStatus {
    const data = this.load();
    const sync = this.db.prepare('SELECT last_success_at, last_change_at, last_error FROM fog_sync WHERE id = 1').get() as
      { last_success_at: string | null; last_change_at: string | null; last_error: string | null } | undefined;
    return {
      tiles: data.tiles.size,
      blocks: data.blocks,
      exploredKm2: Math.round(data.km2 * 100) / 100,
      lastSuccessAt: sync?.last_success_at ?? null,
      lastChangeAt: sync?.last_change_at ?? null,
      lastError: sync?.last_error ?? null,
      unreadable: data.unreadable,
    };
  }

  /** The fog overlay for map tile z/x/y as PNG; null when the tile is out of range. */
  png(z: number, x: number, y: number): Buffer | null {
    if (!Number.isInteger(z) || z < 0 || z > 20) return null;
    const n = 2 ** z;
    if (!Number.isInteger(x) || !Number.isInteger(y) || x < 0 || y < 0 || x >= n || y >= n) return null;
    const data = this.load();
    const key = `${z}/${x}/${y}`;
    const cached = this.pngCache.get(key);
    if (cached) return cached;
    const png = encodePng(renderFogRgba(data.tiles, z, x, y), 256, 256);
    if (this.pngCache.size >= 600) this.pngCache.delete(this.pngCache.keys().next().value!);
    this.pngCache.set(key, png);
    return png;
  }
}
