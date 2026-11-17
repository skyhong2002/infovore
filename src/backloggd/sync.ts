import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import type { Repository } from '../data/database.js';
import { archiveToImport, crawlBackloggd, type BackloggdArchive, type PageLoader } from '../sources/backloggd-archive.js';

export function readArchive(path: string): BackloggdArchive {
  const archive = JSON.parse(readFileSync(path, 'utf8')) as BackloggdArchive;
  if (archive.version !== 1 || !archive.games || !archive.logs) throw new Error(`${path} is not a version-1 Backloggd archive`);
  return archive;
}

export function writeArchive(path: string, archive: BackloggdArchive): void {
  // A per-process temp name keeps two writers (a CLI run and the daily sync) from interleaving.
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(archive), { mode: 0o600 });
  renameSync(tmp, path);
}

export interface ImportResult {
  datedGames: number; sessions: number; undated: number; inserted: number; updated: number;
}

// Everything an archive contributes to infovore: dated game activities, the
// per-day playtime ledger and the browsable library. Idempotent.
export function importArchive(repository: Repository, archive: BackloggdArchive): ImportResult {
  const { entries, sessions, undated } = archiveToImport(archive);
  const persisted = repository.ingestEntries(entries);
  repository.recordTimeLedger({
    source: 'backloggd',
    profile: { id: archive.username, name: archive.username, avatar: '', url: '' },
    stats: {},
    entries: [],
    extra: { yearExtras: '', sessions },
  });
  repository.backloggdLibrary.replaceAll(archive);
  return { datedGames: entries.length, sessions: sessions.length, undated: undated.length, ...persisted };
}

export const LIBRARY_SYNC_INTERVAL_MS = 20 * 3600_000;

// Daily incremental update: re-walk the lists, reviews, lists and journal
// (a few dozen small pages), refetch only the logs of recently played games
// and any game not seen before, then re-import. Needs the archive file left
// by the initial `backloggd-backfill crawl`; without one it does nothing,
// because a first full crawl is far too long for a refresh.
export async function syncBackloggdLibrary(
  repository: Repository,
  options: { archivePath: string; username: string; load?: PageLoader; delayMs?: number; now?: Date; force?: boolean; log?: (message: string) => void },
): Promise<ImportResult | null> {
  const now = options.now ?? new Date();
  if (!existsSync(options.archivePath)) return null;
  const last = repository.backloggdLibrary.syncedAt();
  if (!options.force && last && now.getTime() - new Date(last).getTime() < LIBRARY_SYNC_INTERVAL_MS) return null;
  const existing = readArchive(options.archivePath);
  if (existing.username !== options.username) throw new Error(`archive belongs to ${existing.username}, not ${options.username}`);
  const archive = await crawlBackloggd({
    username: options.username, existing, load: options.load, delayMs: options.delayMs ?? 600, refreshRecent: true, log: options.log,
  });
  writeArchive(options.archivePath, archive);
  return importArchive(repository, archive);
}
