import { serve } from '@hono/node-server';
import type { HealthBody } from './gateway.js';

interface App {
  fetch(request: Request): Response | Promise<Response>;
  request(path: string): Response | Promise<Response>;
}

// The only process owning the existing Repository and all application work.
// No reader constructor/migrations, SQL or rendering ever runs in the gateway.
export function startBackend(app: App, options: { snapshotIntervalMs?: number; maxInFlight?: number } = {}) {
  let inFlight = 0;
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const server = serve({ hostname: '127.0.0.1', port: 0, fetch: async (request) => {
    if (inFlight >= (options.maxInFlight ?? 16)) return new Response('Backend busy', { status: 503 });
    inFlight++;
    try { return await app.fetch(request); } finally { inFlight--; }
  } }, ({ port }) => { process.send?.({ type: 'ready', port }); void publish(); });

  async function publish(): Promise<void> {
    // The timestamp is BEFORE the read: a slow read must not publish an old
    // observation as newly healthy merely because its completion is recent.
    const capturedAt = Date.now();
    try {
      const response = await app.request('/healthz');
      const body = await response.json() as HealthBody;
      await send({ type: 'health', snapshot: { capturedAt, body } });
    } catch {
      await send({ type: 'health-error' });
    } finally {
      if (!stopped) timer = setTimeout(() => void publish(), options.snapshotIntervalMs ?? 1000);
    }
  }
  function close(): void {
    stopped = true;
    clearTimeout(timer);
    server.close();
  }
  return { server, close };
}

// Wait for IPC drain; at most one observation can be queued, even if the
// gateway is slow. There is no setInterval overlapping pending SQLite work.
function send(message: unknown): Promise<void> {
  if (!process.connected) return Promise.resolve();
  return new Promise((resolve) => process.send!(message as object, () => resolve()));
}
