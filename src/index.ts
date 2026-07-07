import { Hono } from 'hono';
import { serve } from '@hono/node-server';
import { config } from './config.js';
import { getCache, setCache, setCacheError } from './cache.js';
import { fetchBackloggd } from './fetchers/backloggd.js';
import { fetchKitsu } from './fetchers/kitsu.js';
import { fetchStatsfm } from './fetchers/statsfm.js';
import { fetchSimkl } from './fetchers/simkl.js';
import { buildBackloggdCard } from './cards/backloggd.js';
import { buildKitsuAnimeCard, buildKitsuMangaCard } from './cards/kitsu.js';
import { buildStatsfmCard } from './cards/statsfm.js';
import { buildSimklMoviesCard, buildSimklShowsCard } from './cards/simkl.js';

const fetchers: Record<string, () => Promise<unknown>> = {
  backloggd: fetchBackloggd,
  kitsu: fetchKitsu,
  statsfm: fetchStatsfm,
  simkl: fetchSimkl,
};

const cards: Record<string, { source: string; build: (data: never) => Promise<string> }> = {
  backloggd: { source: 'backloggd', build: buildBackloggdCard as never },
  'kitsu-anime': { source: 'kitsu', build: buildKitsuAnimeCard as never },
  'kitsu-manga': { source: 'kitsu', build: buildKitsuMangaCard as never },
  statsfm: { source: 'statsfm', build: buildStatsfmCard as never },
  'simkl-movies': { source: 'simkl', build: buildSimklMoviesCard as never },
  'simkl-shows': { source: 'simkl', build: buildSimklShowsCard as never },
};

async function refreshSource(name: string): Promise<void> {
  try {
    const data = await fetchers[name]();
    setCache(`data:${name}`, data);
    for (const [cardName, card] of Object.entries(cards)) {
      if (card.source !== name) continue;
      try {
        setCache(`svg:${cardName}`, await card.build(data as never));
      } catch (err) {
        console.error(`[render] ${cardName} failed:`, err);
      }
    }
    console.log(`[refresh] ${name} ok`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    setCacheError(`data:${name}`, msg);
    console.error(`[refresh] ${name} failed: ${msg}`);
  }
}

async function refreshAll(): Promise<void> {
  await Promise.allSettled(Object.keys(fetchers).map(refreshSource));
}

const app = new Hono();

app.get('/', (c) => {
  const sources = Object.keys(fetchers).map((name) => {
    const entry = getCache(`data:${name}`);
    return {
      source: name,
      lastFetched: entry ? new Date(entry.fetchedAt).toISOString() : null,
      error: entry?.error ?? null,
      json: `/api/${name}.json`,
    };
  });
  return c.json({
    name: 'status.skyhong.tw',
    cards: Object.keys(cards).map((n) => `/card/${n}.svg`),
    sources,
  });
});

app.get('/api/:file{[a-z-]+\\.json}', (c) => {
  const name = c.req.param('file').replace(/\.json$/, '');
  const entry = getCache(`data:${name}`);
  if (!entry || entry.data === null) return c.json({ error: entry?.error ?? 'not found' }, 404);
  return c.json({ fetchedAt: new Date(entry.fetchedAt).toISOString(), data: entry.data });
});

app.get('/card/:file{[a-z-]+\\.svg}', (c) => {
  let name = c.req.param('file').replace(/\.svg$/, '');
  // Old card names from v0.1.
  if (name === 'kitsu') name = 'kitsu-anime';
  if (name === 'simkl') name = 'simkl-shows';
  const entry = getCache<string>(`svg:${name}`);
  if (!entry?.data) {
    const source = cards[name]?.source;
    return c.text(getCache(`data:${source ?? name}`)?.error ?? 'not found', 404);
  }
  c.header('Content-Type', 'image/svg+xml');
  c.header('Cache-Control', `public, max-age=${config.refreshMinutes * 60}`);
  return c.body(entry.data);
});

app.get('/cards', (c) => {
  const imgs = Object.keys(cards)
    .map((n) => `<a href="/card/${n}.svg"><img src="/card/${n}.svg" alt="${n}"></a>`)
    .join('\n');
  return c.html(
    `<!doctype html><meta charset="utf-8"><title>status.skyhong.tw</title>` +
      `<body style="background:#0d0e11;display:flex;flex-wrap:wrap;gap:16px;padding:24px;align-items:flex-start">${imgs}</body>`
  );
});

app.get('/healthz', (c) => c.text('ok'));

serve({ fetch: app.fetch, port: config.port }, (info) => {
  console.log(`listening on :${info.port}`);
});

refreshAll();
setInterval(refreshAll, config.refreshMinutes * 60 * 1000);
