import { timingSafeEqual } from 'node:crypto';
import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { config } from './config.js';
import { Repository } from './data/database.js';
import { canEnrichPublicEvent, enrichPublicEvent, normalizeEvent, type EventInput } from './sources/events.js';
import { completeYoutubeOAuth, youtubeOAuthAuthorizationUrl } from './youtube/portability.js';
import { parseYoutubeArchive } from './youtube/takeout.js';
import { normalizeYoutubeCapture } from './youtube/capture.js';

function authorized(auth: string | undefined, expectedToken = config.ingestToken): boolean {
  if (!expectedToken || !auth?.startsWith('Bearer ')) return false;
  const provided = Buffer.from(auth.slice(7));
  const expected = Buffer.from(expectedToken);
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
        // Arbitrary public URLs are retained as references, but only the
        // allowlisted event platforms are fetched for metadata enrichment.
        const enriched = input.url && canEnrichPublicEvent(input.url)
          ? await enrichPublicEvent(input.url)
          : {};
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
  app.post('/api/ingest/youtube/takeout', async (c) => {
    if (!config.ingestToken) return c.json({ error: 'YouTube ingestion is not configured' }, 503);
    if (!authorized(c.req.header('authorization'))) return c.json({ error: 'Unauthorized' }, 401);
    if (!config.youtube.privateDataKey) return c.json({ error: 'YOUTUBE_PRIVATE_DATA_KEY is not configured' }, 503);
    const contentType = c.req.header('content-type')?.split(';')[0]?.trim();
    if (!['application/zip', 'application/octet-stream'].includes(contentType ?? '')) {
      return c.json({ error: 'Upload the Takeout ZIP as application/zip' }, 415);
    }
    try {
      const archive = new Uint8Array(await c.req.arrayBuffer());
      const parsed = parseYoutubeArchive(archive, config.youtube.privateDataKey, 'takeout');
      const result = repository.ingestYoutubeArchive(parsed);
      return c.json({ ok: true, ...result, totals: repository.youtubeCounts() }, 201);
    } catch (error) {
      return c.json({ error: error instanceof Error ? error.message : String(error) }, 400);
    }
  });
  app.get('/api/ingest/youtube/capture/status', (c) => {
    if (!config.youtube.captureToken) {
      return c.json({ error: 'YouTube capture is not configured' }, 503);
    }
    if (!authorized(c.req.header('authorization'), config.youtube.captureToken)) {
      return c.json({ error: 'Unauthorized' }, 401);
    }
    return c.json({ status: 'ready', service: 'infovore-youtube-capture' });
  });
  app.post('/api/ingest/youtube/capture', async (c) => {
    if (!config.youtube.captureToken) {
      return c.json({ error: 'YouTube capture is not configured' }, 503);
    }
    if (!authorized(c.req.header('authorization'), config.youtube.captureToken)) {
      return c.json({ error: 'Unauthorized' }, 401);
    }
    try {
      const body = await c.req.text();
      if (Buffer.byteLength(body) > 16 * 1024) {
        return c.json({ error: 'Capture payload exceeds 16 KiB' }, 413);
      }
      const input = normalizeYoutubeCapture(JSON.parse(body));
      const result = repository.upsertYoutubeCapture(input);
      return c.json({ ok: true, ...result }, result.inserted ? 201 : 200);
    } catch (error) {
      return c.json({ error: error instanceof Error ? error.message : String(error) }, 400);
    }
  });
  app.post('/api/ingest/youtube/oauth/start', (c) => {
    if (!authorized(c.req.header('authorization'))) return c.json({ error: 'Unauthorized' }, 401);
    try {
      return c.json({ authorizationUrl: youtubeOAuthAuthorizationUrl(repository) });
    } catch (error) {
      return c.json({ error: error instanceof Error ? error.message : String(error) }, 503);
    }
  });
  app.get('/api/ingest/youtube/oauth/callback', async (c) => {
    const code = c.req.query('code');
    const state = c.req.query('state');
    if (!code || !state) return c.text('Missing OAuth code or state', 400);
    try {
      await completeYoutubeOAuth(repository, code, state);
      return c.redirect('/platforms/youtube?oauth=connected');
    } catch (error) {
      return c.text(error instanceof Error ? error.message : String(error), 400);
    }
  });
  return app;
}

if (process.env.NODE_ENV !== 'test') {
  const repository = new Repository(config.databasePath);
  const app = createIngestApp(repository);
  serve({ fetch: app.fetch, port: config.port }, (info) => console.log(`infovore ingest listening on :${info.port}`));
}
