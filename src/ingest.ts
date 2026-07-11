import { timingSafeEqual } from 'node:crypto';
import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { config } from './config.js';
import { Repository } from './data/database.js';
import { enrichPublicEvent, normalizeEvent, type EventInput } from './sources/events.js';

function authorized(auth: string | undefined): boolean {
  if (!config.ingestToken || !auth?.startsWith('Bearer ')) return false;
  const provided = Buffer.from(auth.slice(7));
  const expected = Buffer.from(config.ingestToken);
  return provided.length === expected.length && timingSafeEqual(provided, expected);
}

export function createIngestApp(repository: Repository): Hono {
  const app = new Hono();
  app.get('/healthz', (c) => c.json(
    { status: config.ingestToken ? 'healthy' : 'unhealthy', service: 'infovore-ingest' },
    config.ingestToken ? 200 : 503
  ));
  app.post('/api/ingest/events', async (c) => {
    if (!config.ingestToken) return c.json({ error: 'Event ingestion is not configured' }, 503);
    if (!authorized(c.req.header('authorization'))) return c.json({ error: 'Unauthorized' }, 401);
    try {
      const body = await c.req.json<{ events?: EventInput[] } | EventInput>();
      const inputs: EventInput[] | undefined = 'events' in body ? body.events : [body as EventInput];
      if (!inputs?.length || inputs.length > 50) return c.json({ error: 'Provide between 1 and 50 events' }, 400);
      const entries = [];
      for (const input of inputs) {
        const enriched = input.url ? await enrichPublicEvent(input.url) : {};
        const merged = Object.fromEntries(
          Object.entries({ ...enriched, ...input }).filter(([, value]) => value !== undefined && value !== '')
        ) as EventInput;
        entries.push(normalizeEvent(merged));
      }
      const result = repository.ingestEntries(entries);
      return c.json({ ok: true, ...result, events: entries.map(({ sourceItemId, title, activityAt, status, visibility }) => ({ id: sourceItemId, title, startAt: activityAt, status, visibility })) }, 201);
    } catch (error) {
      return c.json({ error: error instanceof Error ? error.message : String(error) }, 400);
    }
  });
  return app;
}

if (process.env.NODE_ENV !== 'test') {
  const repository = new Repository(config.databasePath);
  const app = createIngestApp(repository);
  serve({ fetch: app.fetch, port: config.port }, (info) => console.log(`infovore ingest listening on :${info.port}`));
}
