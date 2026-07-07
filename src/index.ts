import { Hono } from 'hono';
import { serve } from '@hono/node-server';
import { config } from './config.js';
import { getCache, setCache, setCacheError } from './cache.js';
import { fetchBackloggd } from './fetchers/backloggd.js';
import { fetchKitsu } from './fetchers/kitsu.js';
import { fetchStatsfm } from './fetchers/statsfm.js';
import { fetchSimkl } from './fetchers/simkl.js';
import {
  buildBackloggdCard,
  buildKitsuCard,
  buildStatsfmCard,
  buildSimklCard,
} from './cards/builders.js';

interface Service {
  name: string;
  fetch: () => Promise<unknown>;
  build: (data: never) => Promise<string>;
}

const services: Service[] = [
  { name: 'backloggd', fetch: fetchBackloggd, build: buildBackloggdCard as never },
  { name: 'kitsu', fetch: fetchKitsu, build: buildKitsuCard as never },
  { name: 'statsfm', fetch: fetchStatsfm, build: buildStatsfmCard as never },
  { name: 'simkl', fetch: fetchSimkl, build: buildSimklCard as never },
];

async function refresh(service: Service): Promise<void> {
  try {
    const data = await service.fetch();
    setCache(`data:${service.name}`, data);
    const svg = await service.build(data as never);
    setCache(`svg:${service.name}`, svg);
    console.log(`[refresh] ${service.name} ok`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    setCacheError(`data:${service.name}`, msg);
    console.error(`[refresh] ${service.name} failed: ${msg}`);
  }
}

async function refreshAll(): Promise<void> {
  await Promise.allSettled(services.map(refresh));
}

const app = new Hono();

app.get('/', (c) => {
  const status = services.map((s) => {
    const entry = getCache(`data:${s.name}`);
    return {
      service: s.name,
      lastFetched: entry ? new Date(entry.fetchedAt).toISOString() : null,
      error: entry?.error ?? null,
      card: `/card/${s.name}.svg`,
      json: `/api/${s.name}.json`,
    };
  });
  return c.json({ name: 'status.skyhong.tw', services: status });
});

app.get('/api/:file{[a-z]+\\.json}', (c) => {
  const name = c.req.param('file').replace(/\.json$/, '');
  const entry = getCache(`data:${name}`);
  if (!entry || entry.data === null) return c.json({ error: entry?.error ?? 'not found' }, 404);
  return c.json({ fetchedAt: new Date(entry.fetchedAt).toISOString(), data: entry.data });
});

app.get('/card/:file{[a-z]+\\.svg}', (c) => {
  const name = c.req.param('file').replace(/\.svg$/, '');
  const entry = getCache<string>(`svg:${name}`);
  if (!entry?.data) return c.text(getCache(`data:${name}`)?.error ?? 'not found', 404);
  c.header('Content-Type', 'image/svg+xml');
  c.header('Cache-Control', `public, max-age=${config.refreshMinutes * 60}`);
  return c.body(entry.data);
});

app.get('/cards', (c) => {
  const imgs = services
    .map((s) => `<a href="/card/${s.name}.svg"><img src="/card/${s.name}.svg" alt="${s.name}"></a>`)
    .join('\n');
  return c.html(
    `<!doctype html><meta charset="utf-8"><title>status.skyhong.tw</title>` +
      `<body style="background:#0d0e11;display:flex;flex-wrap:wrap;gap:16px;padding:24px">${imgs}</body>`
  );
});

app.get('/healthz', (c) => c.text('ok'));

serve({ fetch: app.fetch, port: config.port }, (info) => {
  console.log(`listening on :${info.port}`);
});

refreshAll();
setInterval(refreshAll, config.refreshMinutes * 60 * 1000);
