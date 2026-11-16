import type { DatabaseSync } from 'node:sqlite';
import { encodePng, exploredKm2, parseTile, renderFogRgba, type FogTile } from './tiles.js';

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

  constructor(private readonly db: DatabaseSync) {}

  revisions(): Map<string, string> {
    const rows = this.db.prepare('SELECT name, rev FROM fog_tiles').all() as Array<{ name: string; rev: string }>;
    return new Map(rows.map((row) => [row.name, row.rev]));
  }

  put(name: string, rev: string, data: Uint8Array, at = new Date().toISOString()): void {
    this.db.prepare(`INSERT INTO fog_tiles (name, rev, data, synced_at) VALUES (?,?,?,?)
      ON CONFLICT(name) DO UPDATE SET rev=excluded.rev, data=excluded.data, synced_at=excluded.synced_at`).run(name, rev, data, at);
  }

  remove(name: string): void {
    this.db.prepare('DELETE FROM fog_tiles WHERE name = ?').run(name);
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
