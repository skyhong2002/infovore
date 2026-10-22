// All data is synthetic and in-memory. Slow I/O is injected inside a real
// SQLite SELECT reached by the real homepage, never against a production DB.
import { startBackend } from '../../src/backend.ts';
process.env.NODE_ENV = 'test';
process.env.DATABASE_PATH = ':memory:';
process.env.SOURCES = 'backloggd';
process.env.DAYFLOW_TOKEN = '';
process.env.COMPUTAI_TOKEN = '';
process.env.HEALTH_CONNECT_TOKEN = '';
const originalFetch = globalThis.fetch;
globalThis.fetch = (url, init) => String(url).startsWith('data:') ? originalFetch(url, init) : Promise.reject(new Error('external network forbidden'));
const { app, repository } = await import('../../src/index.ts');
const { restoreCache } = await import('../../src/data/cache.ts');
restoreCache('data:backloggd', { source: 'backloggd', profile: { id: 'synthetic', name: 'synthetic', avatar: '', url: '' }, stats: {}, entries: [], extra: {} }, Date.now());
const db = repository.db;
let slow = false;
let metadataError = false;
db.function('synthetic_delay', () => {
  process.send?.({ type: 'blocked' });
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 12000);
  return 0;
});
const originalTimeSpent = repository.timeSpent.bind(repository);
repository.timeSpent = (...args) => {
  if (slow) { slow = false; db.prepare('SELECT synthetic_delay()').get(); }
  return originalTimeSpent(...args);
};
process.on('message', (message) => {
  if (message.type === 'slow') { slow = true; process.send?.({ type: 'armed' }); }
  if (message.type === 'metadata-error') metadataError = true;
  if (message.type === 'metadata-recover') metadataError = false;
});
const backend = startBackend({ fetch: app.fetch, request: (path) => {
  if (metadataError) throw new Error('synthetic metadata read failure');
  return app.request(path);
} }, { snapshotIntervalMs: 100 });
process.on('disconnect', () => { backend.close(); process.exit(); });
