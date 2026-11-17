import type { DatabaseSync } from 'node:sqlite';
import type { BackloggdArchive, GameListName } from '../sources/backloggd-archive.js';
import { LIST_NAMES } from '../sources/backloggd-archive.js';

// The whole Backloggd account as normalized tables: every list, each game's
// log summary, reviews, user lists and the journal. It is the browsable
// counterpart of the dated activities and per-day ledger that
// archiveToImport() writes, and is replaced wholesale on every sync (the
// archive file is the durable source, so a replace can never lose history).

export function migrateBackloggdLibrary(db: DatabaseSync): void {
  db.exec(`BEGIN;
    CREATE TABLE IF NOT EXISTS backloggd_games (
      list TEXT NOT NULL, slug TEXT NOT NULL, position INTEGER NOT NULL,
      title TEXT NOT NULL, cover TEXT NOT NULL, adult INTEGER NOT NULL, rating REAL, reviewed INTEGER NOT NULL,
      status TEXT NOT NULL, time_minutes INTEGER NOT NULL, first_played TEXT NOT NULL, last_played TEXT NOT NULL,
      platforms_json TEXT NOT NULL, PRIMARY KEY (list, slug)
    ) WITHOUT ROWID;
    CREATE TABLE IF NOT EXISTS backloggd_reviews (
      id TEXT PRIMARY KEY, position INTEGER NOT NULL, slug TEXT NOT NULL, title TEXT NOT NULL, rating REAL,
      status TEXT NOT NULL, platform TEXT NOT NULL, date TEXT NOT NULL, text TEXT NOT NULL, likes INTEGER NOT NULL
    ) WITHOUT ROWID;
    CREATE TABLE IF NOT EXISTS backloggd_lists (slug TEXT PRIMARY KEY, position INTEGER NOT NULL, name TEXT NOT NULL) WITHOUT ROWID;
    CREATE TABLE IF NOT EXISTS backloggd_list_games (
      list_slug TEXT NOT NULL, position INTEGER NOT NULL, slug TEXT NOT NULL, title TEXT NOT NULL,
      PRIMARY KEY (list_slug, position)
    ) WITHOUT ROWID;
    CREATE TABLE IF NOT EXISTS backloggd_journal (
      position INTEGER PRIMARY KEY, day TEXT NOT NULL, slug TEXT NOT NULL, title TEXT NOT NULL, platform TEXT NOT NULL, time TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS backloggd_library_meta (
      id INTEGER PRIMARY KEY CHECK (id = 1), crawled_at TEXT, synced_at TEXT
    );
    INSERT OR IGNORE INTO backloggd_library_meta (id) VALUES (1);
    COMMIT;`);
}

export interface LibraryGame {
  slug: string; title: string; cover: string; adult: boolean; rating: number | null; reviewed: boolean;
  status: string; timeMinutes: number; firstPlayed: string; lastPlayed: string; platforms: string[];
}
export interface BackloggdLibrary {
  crawledAt: string | null;
  syncedAt: string | null;
  games: Record<GameListName, LibraryGame[]>;
  reviews: Array<{ id: string; slug: string; title: string; rating: number | null; status: string; platform: string; date: string; text: string; likes: number }>;
  lists: Array<{ slug: string; name: string; games: Array<{ slug: string; title: string }> }>;
  journal: Array<{ day: string; slug: string; title: string; platform: string; time: string }>;
}

// "118h 45m" / "45m" → minutes.
export function parseDuration(text: string): number {
  const h = text.match(/(\d+)\s*h/);
  const m = text.match(/(\d+)\s*m/);
  return (h ? Number(h[1]) * 60 : 0) + (m ? Number(m[1]) : 0);
}

export class BackloggdLibraryStore {
  constructor(private readonly db: DatabaseSync) {}

  replaceAll(archive: BackloggdArchive, now = new Date()): void {
    const db = this.db;
    db.exec('BEGIN IMMEDIATE');
    try {
      for (const table of ['backloggd_games', 'backloggd_reviews', 'backloggd_lists', 'backloggd_list_games', 'backloggd_journal']) {
        db.exec(`DELETE FROM ${table}`);
      }
      const game = db.prepare('INSERT OR REPLACE INTO backloggd_games VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)');
      for (const list of LIST_NAMES) {
        archive.games[list].forEach((g, position) => {
          const log = archive.logs[g.slug] ?? null;
          game.run(
            list, g.slug, position, g.title, g.cover, g.adult ? 1 : 0, log?.rating ?? g.rating, g.reviewed ? 1 : 0,
            log?.status ?? '', log ? parseDuration(log.timePlayed) : 0, log?.firstPlayed ?? '', log?.lastPlayed ?? '',
            JSON.stringify(log?.platforms ?? []),
          );
        });
      }
      const review = db.prepare('INSERT OR REPLACE INTO backloggd_reviews VALUES (?,?,?,?,?,?,?,?,?,?)');
      archive.reviews.forEach((r, i) => review.run(r.id, i, r.slug, r.title, r.rating, r.status, r.platform, r.date, r.text, r.likes));
      const list = db.prepare('INSERT OR REPLACE INTO backloggd_lists VALUES (?,?,?)');
      const listGame = db.prepare('INSERT OR REPLACE INTO backloggd_list_games VALUES (?,?,?,?)');
      archive.lists.forEach((l, i) => {
        list.run(l.slug, i, l.name);
        l.games.forEach((g, position) => listGame.run(l.slug, position, g.slug, g.title));
      });
      const journal = db.prepare('INSERT INTO backloggd_journal VALUES (?,?,?,?,?,?)');
      archive.journal.forEach((e, i) => journal.run(i, e.day, e.slug, e.title, e.platform, e.time));
      db.prepare('UPDATE backloggd_library_meta SET crawled_at=?, synced_at=? WHERE id=1')
        .run(archive.crawledAt, now.toISOString());
      db.exec('COMMIT');
    } catch (error) {
      try { db.exec('ROLLBACK'); } catch { /* keep the original error */ }
      throw error;
    }
  }

  syncedAt(): string | null {
    const row = this.db.prepare('SELECT synced_at FROM backloggd_library_meta WHERE id=1').get() as { synced_at: string | null } | undefined;
    return row?.synced_at ?? null;
  }

  read(): BackloggdLibrary | null {
    const meta = this.db.prepare('SELECT crawled_at, synced_at FROM backloggd_library_meta WHERE id=1').get() as
      { crawled_at: string | null; synced_at: string | null } | undefined;
    if (!meta?.synced_at) return null;
    const games = { played: [], playing: [], backlog: [], wishlist: [] } as Record<GameListName, LibraryGame[]>;
    const rows = this.db.prepare('SELECT * FROM backloggd_games ORDER BY list, position').all() as Array<Record<string, unknown>>;
    for (const r of rows) {
      games[r.list as GameListName].push({
        slug: String(r.slug), title: String(r.title), cover: String(r.cover), adult: Boolean(r.adult),
        rating: r.rating === null ? null : Number(r.rating), reviewed: Boolean(r.reviewed), status: String(r.status),
        timeMinutes: Number(r.time_minutes), firstPlayed: String(r.first_played), lastPlayed: String(r.last_played),
        platforms: JSON.parse(String(r.platforms_json)) as string[],
      });
    }
    const reviews = (this.db.prepare('SELECT * FROM backloggd_reviews ORDER BY position').all() as Array<Record<string, unknown>>).map((r) => ({
      id: String(r.id), slug: String(r.slug), title: String(r.title), rating: r.rating === null ? null : Number(r.rating),
      status: String(r.status), platform: String(r.platform), date: String(r.date), text: String(r.text), likes: Number(r.likes),
    }));
    const listRows = this.db.prepare('SELECT slug, name FROM backloggd_lists ORDER BY position').all() as Array<{ slug: string; name: string }>;
    const itemRows = this.db.prepare('SELECT list_slug, slug, title FROM backloggd_list_games ORDER BY list_slug, position').all() as
      Array<{ list_slug: string; slug: string; title: string }>;
    const lists = listRows.map((l) => ({
      ...l, games: itemRows.filter((g) => g.list_slug === l.slug).map(({ slug, title }) => ({ slug, title })),
    }));
    const journal = (this.db.prepare('SELECT day, slug, title, platform, time FROM backloggd_journal ORDER BY position').all() as
      BackloggdLibrary['journal']).map((e) => ({ ...e }));
    return { crawledAt: meta.crawled_at, syncedAt: meta.synced_at, games, reviews, lists, journal };
  }
}
