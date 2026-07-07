import { Hono } from 'hono';
import { serve } from '@hono/node-server';
import { config } from './config.js';
import { getCache, setCache, setCacheError } from './cache.js';
import { fetchBackloggd } from './fetchers/backloggd.js';
import { fetchKitsu } from './fetchers/kitsu.js';
import { fetchStatsfm } from './fetchers/statsfm.js';
import { fetchSimkl } from './fetchers/simkl.js';
import { fetchGoodreads } from './fetchers/goodreads.js';
import { buildBackloggdCard } from './cards/backloggd.js';
import { buildKitsuCard, buildKitsuAnimeCard, buildKitsuMangaCard } from './cards/kitsu.js';
import { buildStatsfmCard, buildStatsfmAlbumsCard, buildStatsfmArtistsCard } from './cards/statsfm.js';
import { buildSimklCard, buildSimklMoviesCard, buildSimklShowsCard } from './cards/simkl.js';
import { buildGoodreadsCard } from './cards/goodreads.js';

const fetchers: Record<string, () => Promise<unknown>> = {
  backloggd: fetchBackloggd,
  kitsu: fetchKitsu,
  statsfm: fetchStatsfm,
  simkl: fetchSimkl,
  goodreads: fetchGoodreads,
};

const cards: Record<string, { source: string; build: (data: never) => Promise<string> }> = {
  backloggd: { source: 'backloggd', build: buildBackloggdCard as never },
  kitsu: { source: 'kitsu', build: buildKitsuCard as never },
  'kitsu-anime': { source: 'kitsu', build: buildKitsuAnimeCard as never },
  'kitsu-manga': { source: 'kitsu', build: buildKitsuMangaCard as never },
  statsfm: { source: 'statsfm', build: buildStatsfmCard as never },
  'statsfm-albums': { source: 'statsfm', build: buildStatsfmAlbumsCard as never },
  'statsfm-artists': { source: 'statsfm', build: buildStatsfmArtistsCard as never },
  simkl: { source: 'simkl', build: buildSimklCard as never },
  'simkl-movies': { source: 'simkl', build: buildSimklMoviesCard as never },
  'simkl-shows': { source: 'simkl', build: buildSimklShowsCard as never },
  goodreads: { source: 'goodreads', build: buildGoodreadsCard as never },
};

async function refreshSource(name: string, isRetry = false): Promise<void> {
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
    if (!isRetry) {
      setTimeout(() => refreshSource(name, true), 2 * 60 * 1000);
    }
  }
}

async function refreshAll(): Promise<void> {
  await Promise.allSettled(Object.keys(fetchers).map((n) => refreshSource(n)));
}

const app = new Hono();

// Platform sections for the home page. Cards in one section sit side by
// side when the viewport is wide enough and stack vertically otherwise.
const sections: { title: string; url: string; cards: string[] }[] = [
  { title: 'Backloggd', url: 'https://backloggd.com/u/skychopath/', cards: ['backloggd'] },
  { title: 'Kitsu', url: 'https://kitsu.app/users/skyhong2002', cards: ['kitsu', 'kitsu-anime', 'kitsu-manga'] },
  { title: 'stats.fm', url: 'https://stats.fm/skyhong2002', cards: ['statsfm', 'statsfm-albums', 'statsfm-artists'] },
  { title: 'Simkl', url: 'https://simkl.com/8074923/', cards: ['simkl', 'simkl-shows', 'simkl-movies'] },
  { title: 'Goodreads', url: 'https://www.goodreads.com/user/show/160195773-skychopath', cards: ['goodreads'] },
];

// Cache-buster: the newest fetch timestamp, appended as ?v= so browsers
// pick up fresh renders without a hard reload.
function version(cardName: string): number {
  const source = cards[cardName]?.source;
  return getCache(`data:${source}`)?.fetchedAt ?? 0;
}

app.get('/', (c) => {
  const body = sections
    .map((s) => {
      const imgs = s.cards
        .map(
          (n) =>
            `<a href="/card/${n}.svg?v=${version(n)}"><img src="/card/${n}.svg?v=${version(n)}" alt="${n}" width="520" loading="lazy"></a>`
        )
        .join('\n');
      const shortUrl = s.url.replace(/^https:\/\//, '').replace(/\/$/, '');
      return `<section><h2><a href="${s.url}">${s.title}</a><a class="profile-link" href="${s.url}">${shortUrl}</a></h2><div class="row">${imgs}</div></section>`;
    })
    .join('\n');
  c.header('Cache-Control', 'no-cache');
  return c.html(`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>status · Sky Hong</title>
<style>
  body { background: #0d0e11; color: #e8eaed; margin: 0 auto; padding: 32px 16px 48px;
         max-width: 1100px; font-family: system-ui, -apple-system, sans-serif; }
  h1 { font-size: 26px; margin: 0 0 4px; }
  p.sub { color: #8a939e; margin: 0 0 28px; font-size: 14px; }
  section { margin-bottom: 36px; }
  h2 { font-size: 15px; color: #8a939e; text-transform: uppercase; letter-spacing: 1.5px;
       margin: 0 0 12px; }
  h2 a { color: inherit; text-decoration: none; }
  h2 a:hover { color: #e8eaed; }
  h2 .profile-link { font-size: 12px; text-transform: none; letter-spacing: 0; margin-left: 12px;
                     color: #5a626b; }
  h2 .profile-link:hover { color: #8a939e; text-decoration: underline; }
  .row { display: flex; flex-wrap: wrap; gap: 16px; align-items: flex-start; }
  .row img { max-width: 100%; height: auto; display: block; }
  footer { color: #5a626b; font-size: 13px; }
  footer a { color: #8a939e; }
</style>
</head>
<body>
<h1>status</h1>
<p class="sub">What Sky Hong is playing, watching, reading and listening to — refreshed every 30 minutes.</p>
${body}
<footer><a href="https://github.com/skyhong2002/status.skyhong.tw">source</a> · <a href="/status">json</a></footer>
</body>
</html>`);
});

app.get('/status', (c) => {
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
  const name = c.req.param('file').replace(/\.svg$/, '');
  const entry = getCache<string>(`svg:${name}`);
  if (!entry?.data) {
    const source = cards[name]?.source;
    return c.text(getCache(`data:${source ?? name}`)?.error ?? 'not found', 404);
  }
  c.header('Content-Type', 'image/svg+xml');
  c.header('Cache-Control', `public, max-age=${config.refreshMinutes * 60}`);
  return c.body(entry.data);
});

app.get('/cards', (c) => c.redirect('/', 301));

app.get('/healthz', (c) => c.text('ok'));

serve({ fetch: app.fetch, port: config.port }, (info) => {
  console.log(`listening on :${info.port}`);
});

refreshAll();
setInterval(refreshAll, config.refreshMinutes * 60 * 1000);
