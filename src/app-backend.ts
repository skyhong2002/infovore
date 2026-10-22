import { app, refreshAll } from './index.js';
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
void refreshAndSchedule(refreshAll, config.refreshIntervalMinutes);
process.on('disconnect', () => { backend.close(); process.exit(0); });
