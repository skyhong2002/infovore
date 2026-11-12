import { startDayflowQualityWorker } from './dayflow/quality-worker.js';
import { startDayflowPhoneWorker } from './dayflow/phone-worker.js';
import { phoneObservationBatchSchema } from './dayflow/phone-types.js';
import { bodyLimit } from 'hono/body-limit';
import { dayflowBatchSchema } from './dayflow/types.js';
import { computaiReportSchema, computaiSegmentsSchema } from './computai/types.js';
import { timingSafeEqual } from 'node:crypto';
import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { config } from './config.js';
import { Repository } from './data/database.js';
import { canEnrichPublicEvent, enrichPublicEvent, normalizeEvent, type EventInput } from './sources/events.js';
import { HealthReconcileRejected, healthConnectBatchSchema } from './health/types.js';

// A failure after validation (database busy, disk full, lock timeout) is not
// the client's fault: answer 503 so devices keep their batch and retry, and
// keep 400 for requests that will never be accepted. Logs never include the
// submitted content.
class StorageFailure extends Error {}
function store<T>(write: () => T): T {
  try {
    return write();
  } catch (error) {
    if (error instanceof HealthReconcileRejected) throw error;
    console.error(`ingest storage failure: ${error instanceof Error ? error.name : 'unknown'}`);
    throw new StorageFailure('storage unavailable');
  }
}
const storageUnavailable = { error: 'Storage is temporarily unavailable; keep the batch and retry later', retryable: true };

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
  app.use('/api/ingest/dayflow/*', async (c, next) => {
    if (!config.dayflow.token) return c.json({ error: 'Dayflow ingestion is not configured' }, 503);
    if (!authorized(c.req.header('authorization'), config.dayflow.token)) return c.json({ error: 'Unauthorized' }, 401);
    await next();
  });
  app.get('/api/ingest/dayflow/status', (c) => c.json({ status: 'ready', ...repository.dayflow.status() }));
  app.post('/api/ingest/dayflow/days', bodyLimit({ maxSize: 2 * 1024 * 1024 }), async (c) => {
    let batch;
    try {
      batch = dayflowBatchSchema.parse(await c.req.json());
    } catch {
      return c.json({ error: 'Invalid Dayflow day batch' }, 400);
    }
    try {
      return c.json({ ok: true, ...store(() => repository.dayflow.ingest(batch)) });
    } catch {
      return c.json(storageUnavailable, 503);
    }
  });
  // Android screen observations use their own token: a leaked phone token
  // cannot rewrite macOS days, and the Mac token cannot write phone data.
  app.use('/api/ingest/dayflow-phone/*', async (c, next) => {
    if (!config.dayflow.phoneToken) return c.json({ error: 'Phone Dayflow ingestion is not configured' }, 503);
    if (!authorized(c.req.header('authorization'), config.dayflow.phoneToken)) return c.json({ error: 'Unauthorized' }, 401);
    await next();
  });
  app.get('/api/ingest/dayflow-phone/status', (c) => {
    const { lastObservationAt, pending } = repository.dayflow.phone.status();
    return c.json({ status: 'ready', lastObservationAt, pending });
  });
  app.post('/api/ingest/dayflow-phone/observations', async (c) => {
    const body = await c.req.text();
    if (Buffer.byteLength(body) > 8 * 1024 * 1024) return c.json({ error: 'Phone observation payload exceeds 8 MiB' }, 413);
    let batch;
    try {
      batch = phoneObservationBatchSchema.parse(JSON.parse(body));
    } catch (error) {
      // Report what failed validation, never the submitted screen content.
      const message = error instanceof Error && 'issues' in error
        ? (error as { issues: Array<{ path: unknown[]; message: string }> }).issues.slice(0, 3).map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')
        : 'Invalid JSON';
      return c.json({ error: `Invalid phone observation batch: ${message}` }, 400);
    }
    try {
      return c.json({ ok: true, ...store(() => repository.dayflow.phone.ingest(batch)) });
    } catch {
      return c.json(storageUnavailable, 503);
    }
  });
  app.use('/api/ingest/computai/*', async (c, next) => {
    if (!config.computai.token) return c.json({ error: 'ComputAI ingestion is not configured' }, 503);
    if (!authorized(c.req.header('authorization'), config.computai.token)) return c.json({ error: 'Unauthorized' }, 401);
    await next();
  });
  app.get('/api/ingest/computai/status', (c) => c.json({ status: 'ready', ...repository.computai.status() }));
  app.post('/api/ingest/computai/reports', bodyLimit({ maxSize: 64 * 1024 }), async (c) => {
    let report;
    try {
      report = computaiReportSchema.parse(await c.req.json());
    } catch {
      return c.json({ error: 'Invalid ComputAI report' }, 400);
    }
    try {
      return c.json({ ok: true, ...store(() => repository.computai.ingest(report)) });
    } catch {
      return c.json(storageUnavailable, 503);
    }
  });
  app.post('/api/ingest/computai/segments', bodyLimit({ maxSize: 4 * 1024 * 1024 }), async (c) => {
    let batch;
    try {
      batch = computaiSegmentsSchema.parse(await c.req.json());
    } catch {
      return c.json({ error: 'Invalid ComputAI segments' }, 400);
    }
    try {
      return c.json({ ok: true, ...store(() => repository.computai.ingestSegments(batch)) });
    } catch {
      return c.json(storageUnavailable, 503);
    }
  });
  app.post('/api/ingest/events', async (c) => {
    if (!config.ingestToken) return c.json({ error: 'Event ingestion is not configured' }, 503);
    if (!authorized(c.req.header('authorization'))) return c.json({ error: 'Unauthorized' }, 401);
    try {
      const body = await c.req.json<{ events?: EventInput[] } | EventInput>();
      const inputs: EventInput[] | undefined = 'events' in body ? body.events : [body as EventInput];
      if (!inputs?.length || inputs.length > 50) return c.json({ error: 'Provide between 1 and 50 events' }, 400);
      const entries: Array<ReturnType<typeof normalizeEvent>> = [];
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
      const result = store(() => repository.ingestEntries(entries));
      return c.json({ ok: true, ...result, events: entries.map(({ sourceItemId, title, activityAt, status, visibility }) => ({ id: sourceItemId, title, startAt: activityAt, status, visibility })) }, 201);
    } catch (error) {
      if (error instanceof StorageFailure) return c.json(storageUnavailable, 503);
      return c.json({ error: error instanceof Error ? error.message : String(error) }, 400);
    }
  });
  app.get('/api/ingest/health-connect/status', (c) => {
    if (!config.healthConnect.token) return c.json({ error: 'Health Connect ingestion is not configured' }, 503);
    if (!authorized(c.req.header('authorization'), config.healthConnect.token)) return c.json({ error: 'Unauthorized' }, 401);
    return c.json({ status: 'ready', ...repository.healthConnectStatus() });
  });
  app.post('/api/ingest/health-connect', async (c) => {
    if (!config.healthConnect.token) return c.json({ error: 'Health Connect ingestion is not configured' }, 503);
    if (!authorized(c.req.header('authorization'), config.healthConnect.token)) return c.json({ error: 'Unauthorized' }, 401);
    try {
      const body = await c.req.text();
      if (Buffer.byteLength(body) > 1024 * 1024) {
        return c.json({ error: 'Health Connect payload exceeds 1 MiB' }, 413);
      }
      const batch = healthConnectBatchSchema.parse(JSON.parse(body));
      const result = store(() => repository.ingestHealthConnect(batch));
      return c.json({ ok: true, ...result }, result.inserted > 0 ? 201 : 200);
    } catch (error) {
      if (error instanceof HealthReconcileRejected) {
        return c.json({
          error: error.message,
          reconcile: { status: 'rejected', wouldDelete: error.wouldDelete, checked: error.checked },
        }, 409);
      }
      if (error instanceof StorageFailure) return c.json(storageUnavailable, 503);
      return c.json({ error: error instanceof Error ? error.message : String(error) }, 400);
    }
  });
  return app;
}

if (process.env.NODE_ENV !== 'test') {
  const repository = new Repository(config.databasePath, { dayflowQuality: Boolean(config.dayflow.quality) });
  const app = createIngestApp(repository);
  if (config.dayflow.quality && config.dayflow.token && config.sourceEnabled('dayflow')) startDayflowQualityWorker(repository.dayflow, config.dayflow.quality);
  if (config.dayflow.phoneToken && config.sourceEnabled('dayflow')) startDayflowPhoneWorker(repository.dayflow.phone, config.dayflow.quality);
  serve({ fetch: app.fetch, port: config.port }, (info) => console.log(`infovore ingest listening on :${info.port}`));
}
