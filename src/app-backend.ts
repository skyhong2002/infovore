import { app, refreshAll, repository } from './index.js';
import { config } from './config.js';
import { refreshAndSchedule } from './data/schedule.js';
import { startBackend } from './backend.js';

const backend = startBackend(app);
// Preserve the existing warmup, refresh/retry and route behavior in one owner.
void (async () => {
  // The gateway owns the sole bounded homepage regeneration.
  for (const path of ['/cards', '/now', '/platforms']) {
    try { await (await app.request(path)).arrayBuffer(); }
    catch (error) { console.error(`[warm] ${path} failed:`, error); }
  }
})();
// This process is the only refresh owner, so any run still marked running was
// left behind by a previous one.
const abandoned = repository.abandonRunningSyncs();
if (abandoned) console.warn(`[refresh] marked ${abandoned} unfinished run(s) from a previous process as abandoned`);
refreshAndSchedule(refreshAll, config.refreshIntervalMinutes).catch((error) => {
  console.error(`[refresh] cycle failed: ${error instanceof Error ? error.message : String(error)}`);
});
process.on('disconnect', () => { backend.close(); process.exit(0); });
