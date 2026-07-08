import { createHash } from 'node:crypto';
import { Hono } from 'hono';
import { serve } from '@hono/node-server';
import { config } from './config.js';
import { getCache, setCache, setCacheError } from './data/cache.js';
import type { SourceSnapshot } from './data/types.js';
import { fetchBackloggd } from './sources/backloggd.js';
import { fetchKitsu } from './sources/kitsu.js';
import { fetchStatsfm } from './sources/statsfm.js';
import { fetchSimkl } from './sources/simkl.js';
import { fetchGoodreads } from './sources/goodreads.js';
import { rasterize } from './output/render.js';
import { buildBackloggdCard } from './output/backloggd.js';
import { buildKitsuCard, buildKitsuAnimeCard, buildKitsuMangaCard } from './output/kitsu.js';
import { buildStatsfmCard, buildStatsfmAlbumsCard, buildStatsfmArtistsCard } from './output/statsfm.js';
import { buildSimklCard, buildSimklMoviesCard, buildSimklShowsCard } from './output/simkl.js';
import { buildGoodreadsCard } from './output/goodreads.js';

// Registration point: a new source module goes in `src/sources/`, returns a
// `SourceSnapshot`, and gets one entry here. A new output module goes in
// `src/output/`, takes a `SourceSnapshot`, and gets one entry in `cards`
// below (or its own registry, for a non-card output like a feed) — neither
// registration touches any other source or output module.
const fetchers: Record<string, () => Promise<SourceSnapshot<any>>> = {
  backloggd: fetchBackloggd,
  kitsu: fetchKitsu,
  statsfm: fetchStatsfm,
  simkl: fetchSimkl,
  goodreads: fetchGoodreads,
};

const cards: Record<string, { source: string; build: (data: SourceSnapshot<any>) => Promise<string> }> = {
  backloggd: { source: 'backloggd', build: buildBackloggdCard },
  kitsu: { source: 'kitsu', build: buildKitsuCard },
  'kitsu-anime': { source: 'kitsu', build: buildKitsuAnimeCard },
  'kitsu-manga': { source: 'kitsu', build: buildKitsuMangaCard },
  statsfm: { source: 'statsfm', build: buildStatsfmCard },
  'statsfm-albums': { source: 'statsfm', build: buildStatsfmAlbumsCard },
  'statsfm-artists': { source: 'statsfm', build: buildStatsfmArtistsCard },
  simkl: { source: 'simkl', build: buildSimklCard },
  'simkl-movies': { source: 'simkl', build: buildSimklMoviesCard },
  'simkl-shows': { source: 'simkl', build: buildSimklShowsCard },
  goodreads: { source: 'goodreads', build: buildGoodreadsCard },
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

const activeSources = Object.keys(fetchers).filter((n) => config.sourceEnabled(n));

async function refreshAll(): Promise<void> {
  await Promise.allSettled(activeSources.map((n) => refreshSource(n)));
}

const app = new Hono();

// Platform sections for the home page. Cards in one section sit side by
// side when the viewport is wide enough and stack vertically otherwise.
// URLs derive from config so a self-hosted instance links to its own profiles;
// only sections whose source is enabled are shown.
const allSections: { source: string; title: string; url: string; cards: string[] }[] = [
  { source: 'backloggd', title: 'Backloggd', url: `https://backloggd.com/u/${config.backloggd.username}/`, cards: ['backloggd'] },
  { source: 'kitsu', title: 'Kitsu', url: `https://kitsu.app/users/${config.kitsu.slug}`, cards: ['kitsu', 'kitsu-anime', 'kitsu-manga'] },
  { source: 'statsfm', title: 'stats.fm', url: `https://stats.fm/${config.statsfm.username}`, cards: ['statsfm', 'statsfm-albums', 'statsfm-artists'] },
  { source: 'simkl', title: 'Simkl', url: `https://simkl.com/${config.simkl.userId}/`, cards: ['simkl', 'simkl-shows', 'simkl-movies'] },
  { source: 'goodreads', title: 'Goodreads', url: `https://www.goodreads.com/user/show/${config.goodreads.userId}`, cards: ['goodreads'] },
];

const sections = allSections.filter((s) => config.sourceEnabled(s.source));

// Cache-buster: a short hash of the card's SVG content, so the URL only
// changes when the rendered card actually changes. Unchanged data across
// refreshes keeps the same URL → the browser serves it from cache instead of
// re-downloading megabytes of identical images.
function version(cardName: string): string {
  const svg = getCache<string>(`svg:${cardName}`)?.data;
  if (!svg) return '0';
  return createHash('sha1').update(svg).digest('hex').slice(0, 12);
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const GMT8_OFFSET_MS = 8 * 60 * 60 * 1000;

function formatGmt8(ts: number): string {
  const d = new Date(ts + GMT8_OFFSET_MS); // shift to GMT+8 wall time, read via UTC getters
  const hh = String(d.getUTCHours()).padStart(2, '0');
  const mm = String(d.getUTCMinutes()).padStart(2, '0');
  return `${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}, ${hh}:${mm} GMT+8`;
}

// The most recent successful fetch across active sources — refreshes now
// happen twice a day rather than every 30 minutes, so it's worth showing
// how fresh the data actually is instead of implying it's always current.
function lastUpdatedLabel(): string | null {
  const timestamps = activeSources
    .map((name) => getCache(`data:${name}`)?.fetchedAt)
    .filter((t): t is number => typeof t === 'number');
  return timestamps.length ? formatGmt8(Math.max(...timestamps)) : null;
}

app.get('/', (c) => {
  const body = sections
    .map((s) => {
      // Home page uses WebP (≈10× smaller than the SVG for photo-heavy cards,
      // still retina-crisp at 2×); the .svg vector stays available via the link.
      const imgs = s.cards
        .map(
          (n) =>
            `<a href="/card/${n}.svg?v=${version(n)}"><img src="/card/${n}.webp?v=${version(n)}" alt="${n}" width="520" loading="lazy"></a>`
        )
        .join('\n');
      const shortUrl = s.url.replace(/^https:\/\//, '').replace(/\/$/, '');
      return `<section><h2><a href="${s.url}">${s.title}</a><a class="profile-link" href="${s.url}">${shortUrl}</a></h2><div class="row">${imgs}</div></section>`;
    })
    .join('\n');
  const updated = lastUpdatedLabel();
  c.header('Cache-Control', 'no-cache');
  return c.html(`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>status · ${config.ownerName}</title>
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
<p class="sub">What ${config.ownerName} is playing, watching, reading and listening to — refreshed daily at ${config.refreshTimes.join(', ')} (GMT+8)${updated ? ` · last updated ${updated}` : ''}.</p>
${body}
<footer><a href="https://github.com/skyhong2002/status.skyhong.tw">source</a> · <a href="/status">json</a></footer>
</body>
</html>`);
});

app.get('/status', (c) => {
  const sources = activeSources.map((name) => {
    const entry = getCache(`data:${name}`);
    return {
      source: name,
      lastFetched: entry ? new Date(entry.fetchedAt).toISOString() : null,
      error: entry?.error ?? null,
      json: `/api/${name}.json`,
    };
  });
  return c.json({
    owner: config.ownerName,
    cards: sections.flatMap((s) => s.cards).map((n) => `/card/${n}.svg`),
    sources,
  });
});

app.get('/api/:file{[a-z-]+\\.json}', (c) => {
  const name = c.req.param('file').replace(/\.json$/, '');
  const entry = getCache(`data:${name}`);
  if (!entry || entry.data === null) return c.json({ error: entry?.error ?? 'not found' }, 404);
  return c.json({ fetchedAt: new Date(entry.fetchedAt).toISOString(), data: entry.data });
});

const MIME: Record<string, string> = {
  svg: 'image/svg+xml',
  png: 'image/png',
  webp: 'image/webp',
};

// Cache rasterized (png/webp) card bodies keyed by content, so we only encode
// once per unique card render + scale.
const rasterCache = new Map<string, Buffer>();

app.get('/card/:file{[a-z-]+\\.(svg|png|webp)}', async (c) => {
  const file = c.req.param('file');
  const dot = file.lastIndexOf('.');
  const name = file.slice(0, dot);
  const ext = file.slice(dot + 1);

  const svg = getCache<string>(`svg:${name}`)?.data;
  if (!svg) {
    const source = cards[name]?.source;
    return c.text(getCache(`data:${source ?? name}`)?.error ?? 'not found', 404);
  }

  const hash = createHash('sha1').update(svg).digest('hex').slice(0, 16);
  const etag = `"${ext}-${hash}"`;
  if (c.req.header('if-none-match') === etag) return c.body(null, 304);
  c.header('Content-Type', MIME[ext]);
  c.header('ETag', etag);
  // Home-page requests carry a content-hash ?v=, so the URL changes whenever
  // the card does — cache hard. Bare requests revalidate cheaply via ETag.
  c.header('Cache-Control', c.req.query('v') ? 'public, max-age=604800, immutable' : 'public, max-age=300');

  if (ext === 'svg') return c.body(svg);

  const scale = Math.min(3, Math.max(1, Number(c.req.query('scale')) || 2));
  const key = `${name}:${ext}:${scale}:${hash}`;
  let buf = rasterCache.get(key);
  if (!buf) {
    buf = await rasterize(svg, ext as 'png' | 'webp', scale);
    rasterCache.set(key, buf);
  }
  return c.body(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer);
});

app.get('/cards', (c) => c.redirect('/', 301));

app.get('/healthz', (c) => c.text('ok'));

serve({ fetch: app.fetch, port: config.port }, (info) => {
  console.log(`listening on :${info.port}`);
});

// Refresh immediately on startup, then on the fixed daily GMT+8 schedule in
// config.refreshTimes (default 06:00 & 18:00) rather than a fixed interval.
const DAY_MS = 24 * 60 * 60 * 1000;

function nextRunAt(): number {
  const now = Date.now();
  let next = Infinity;
  for (const time of config.refreshTimes) {
    const [hour, minute] = time.split(':').map(Number);
    const d = new Date(now);
    d.setUTCHours(hour, minute, 0, 0);
    let t = d.getTime() - GMT8_OFFSET_MS; // shift UTC HH:MM to GMT+8 HH:MM
    while (t <= now) t += DAY_MS;
    if (t < next) next = t;
  }
  return next;
}

function scheduleNextRefresh(): void {
  setTimeout(() => {
    refreshAll().finally(scheduleNextRefresh);
  }, nextRunAt() - Date.now());
}

refreshAll();
scheduleNextRefresh();
