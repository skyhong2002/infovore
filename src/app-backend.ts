import { config } from './config.js';
import { refreshAndSchedule } from './data/schedule.js';
import { startBackend } from './backend.js';
import { prewarmFiles } from './prewarm.js';
import { startRefreshOwner } from './refresh-owner.js';

let backend: ReturnType<typeof startBackend> | undefined;
process.on('disconnect', () => { backend?.close(); process.exit(0); });
// Before index.js opens SQLite and runs its startup aggregates.
if (config.databasePath !== ':memory:') {
  const warm = await prewarmFiles([config.databasePath, `${config.databasePath}-wal`]);
  console.log(`[prewarm] read ${Math.round(warm.bytes / 1048576)} MiB in ${warm.ms} ms${warm.complete ? '' : ' (stopped early)'}`);
}
const { app, refreshAll, repository } = await import('./index.js');

backend = startBackend(app);
// Preserve the existing warmup, refresh/retry and route behavior in one owner.
void (async () => {
  // The gateway owns the sole bounded homepage regeneration.
  for (const path of ['/cards', '/now', '/platforms']) {
    try { await (await app.request(path)).arrayBuffer(); }
    catch (error) { console.error(`[warm] ${path} failed:`, error); }
  }
})();
startRefreshOwner(process.env.INFOVORE_ROLE, repository, () => refreshAndSchedule(refreshAll, config.refreshIntervalMinutes));
