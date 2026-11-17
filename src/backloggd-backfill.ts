// One-time Backloggd history backfill.
//
//   crawl  <archive.json> [--delay=ms] [--fresh]   walk the whole account into a JSON archive (read-only, resumable)
//   import <archive.json> [--dry-run]              write played games + per-day playtime into the database
//   sync   <archive.json>                          run the daily incremental update now (what the hourly refresh does once a day)
//   summary <archive.json>                         print what an archive holds
//
// Crawling only needs network access to backloggd.com. Importing opens the
// database at DATABASE_PATH directly (run it where that file lives, e.g. inside
// the container) and never touches the cached source snapshot, so the
// Backloggd cards keep rendering from the hourly refresh. The import is
// idempotent: activities upsert on the same identity the hourly source uses,
// and the time ledger keeps a per-(game, day) watermark.
import { existsSync } from 'node:fs';
import { config } from './config.js';
import { Repository } from './data/database.js';
import { importArchive, readArchive, syncBackloggdLibrary, writeArchive } from './backloggd/sync.js';
import {
  LIST_NAMES, archiveToImport, crawlBackloggd, type BackloggdArchive,
} from './sources/backloggd-archive.js';

function summarize(archive: BackloggdArchive): string[] {
  const logs = Object.values(archive.logs);
  const sessions = logs.flatMap((log) => log?.sessions ?? []);
  const minutes = sessions.reduce((sum, s) => sum + s.minutes, 0);
  const days = sessions.map((s) => s.day).sort();
  return [
    `account:  ${archive.username} (crawled ${archive.crawledAt})`,
    ...LIST_NAMES.map((name) => `${name.padEnd(9)} ${archive.games[name].length} games`),
    `logs:     ${logs.filter(Boolean).length} fetched, ${logs.filter((l) => l === null).length} without a log page`,
    `playtime: ${sessions.length} per-day sessions, ${(minutes / 60).toFixed(1)}h, ${days[0] ?? '-'} → ${days.at(-1) ?? '-'}`,
    `reviews:  ${archive.reviews.length}`,
    `lists:    ${archive.lists.length} (${archive.lists.reduce((n, l) => n + l.games.length, 0)} games)`,
    `journal:  ${archive.journal.length} entries`,
  ];
}

// The profile's headline totals count main games only, while the list pages
// also include extras (DLC, updates, expansions), so the crawl must find at
// least as many games as the profile reports.
function reconcile(archive: BackloggdArchive): string[] {
  const problems: string[] = [];
  const check = (label: string, got: number, key: string) => {
    const want = archive.stats[key];
    if (want !== undefined && got < want) problems.push(`${label}: crawled ${got}, profile says at least ${want}`);
  };
  check('played', archive.games.played.length, 'games played');
  check('backlog', archive.games.backlog.length, 'games backloggd');
  const missing = [...archive.games.played, ...archive.games.playing].filter((g) => !(g.slug in archive.logs)).length;
  if (missing) problems.push(`${missing} played games have no log fetched yet`);
  return problems;
}

async function main(): Promise<void> {
  const [command, file, ...flags] = process.argv.slice(2);
  if (!command || !file) {
    console.error('usage: backloggd-backfill <crawl|import|summary> <archive.json> [--delay=ms] [--fresh] [--dry-run]');
    process.exit(2);
  }

  if (command === 'crawl') {
    const delay = Number(flags.find((f) => f.startsWith('--delay='))?.slice(8) ?? 600);
    const existing = !flags.includes('--fresh') && existsSync(file) ? readArchive(file) : null;
    if (existing && existing.username !== config.backloggd.username) {
      throw new Error(`${file} belongs to ${existing.username}, not ${config.backloggd.username}; pass --fresh`);
    }
    const archive = await crawlBackloggd({
      username: config.backloggd.username,
      delayMs: delay,
      existing,
      log: (message) => console.log(`[crawl] ${message}`),
      save: (a) => writeArchive(file, a),
    });
    console.log(summarize(archive).join('\n'));
    const problems = reconcile(archive);
    if (problems.length) {
      console.error(`\nDoes not reconcile with the profile:\n  ${problems.join('\n  ')}`);
      process.exit(1);
    }
    console.log('\nReconciles with the profile totals.');
    return;
  }

  const archive = readArchive(file);
  if (command === 'summary') {
    console.log(summarize(archive).join('\n'));
    return;
  }

  if (command === 'import') {
    const problems = reconcile(archive);
    if (problems.length) throw new Error(`refusing to import an incomplete archive:\n  ${problems.join('\n  ')}`);
    const { entries, sessions, undated } = archiveToImport(archive);    console.log(`${entries.length} dated games, ${sessions.length} per-day sessions, ${undated.length} played games without a date (skipped)`);
    if (flags.includes('--dry-run')) return;

    const repository = new Repository(config.databasePath);
    try {
      const allTime = () => repository.timeSpent().sources.find((s) => s.source === 'backloggd')?.windows.allTime ?? 0;
      const before = { activities: repository.countActivities(), seconds: allTime() };
      const persisted = importArchive(repository, archive);
      const after = { activities: repository.countActivities(), seconds: allTime() };
      console.log(`activities: ${persisted.inserted} new, ${persisted.updated} already present (${before.activities} → ${after.activities})`);
      console.log(`playtime ledger: ${(before.seconds / 3600).toFixed(1)}h → ${(after.seconds / 3600).toFixed(1)}h`);
      const library = repository.backloggdLibrary.read();
      console.log(`library: ${LIST_NAMES.map((n) => `${library?.games[n].length ?? 0} ${n}`).join(', ')}; ${library?.reviews.length ?? 0} reviews, ${library?.lists.length ?? 0} lists, ${library?.journal.length ?? 0} journal entries`);
    } finally {
      repository.close();
    }
    return;
  }

  if (command === 'sync') {
    const repository = new Repository(config.databasePath);
    try {
      const before = repository.countActivities();
      const result = await syncBackloggdLibrary(repository, {
        archivePath: file, username: config.backloggd.username, force: true, log: (message) => console.log(`[sync] ${message}`),
      });
      console.log(result ? `synced: ${result.datedGames} dated games, ${result.sessions} sessions, activities ${before} → ${repository.countActivities()} (${result.inserted} new)` : 'nothing to do (no archive)');
    } finally {
      repository.close();
    }
    return;
  }

  throw new Error(`unknown command ${command}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
