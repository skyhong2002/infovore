import { createHash } from 'node:crypto';
import { Hono } from 'hono';
import { serve } from '@hono/node-server';
import { config } from './config.js';
import { getCache, restoreCache, setCache, setCacheError } from './data/cache.js';
import { Repository } from './data/database.js';
import type { SourceSnapshot } from './data/types.js';
import { fetchBackloggd } from './sources/backloggd.js';
import { fetchKitsu } from './sources/kitsu.js';
import { fetchStatsfm } from './sources/statsfm.js';
import { fetchSimkl } from './sources/simkl.js';
import { fetchGoodreads } from './sources/goodreads.js';
import { rasterize } from './output/render.js';
import { activityRss } from './output/feed.js';
import { homePage, nowPage, profilePage, wrappedPage } from './output/pages.js';
import { handleMcpRequest } from './mcp.js';
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
const fetchers: Record<string, () => Promise<SourceSnapshot<unknown>>> = {
  backloggd: fetchBackloggd,
  kitsu: fetchKitsu,
  statsfm: fetchStatsfm,
  simkl: fetchSimkl,
  goodreads: fetchGoodreads,
};

interface CardDefinition {
  source: string;
  build: (data: SourceSnapshot<unknown>) => Promise<string>;
}

function defineCard<T>(source: string, build: (data: SourceSnapshot<T>) => Promise<string>): CardDefinition {
  return { source, build: (data) => build(data as SourceSnapshot<T>) };
}

const cards: Record<string, CardDefinition> = {
  backloggd: defineCard('backloggd', buildBackloggdCard),
  kitsu: defineCard('kitsu', buildKitsuCard),
  'kitsu-anime': defineCard('kitsu', buildKitsuAnimeCard),
  'kitsu-manga': defineCard('kitsu', buildKitsuMangaCard),
  statsfm: defineCard('statsfm', buildStatsfmCard),
  'statsfm-albums': defineCard('statsfm', buildStatsfmAlbumsCard),
  'statsfm-artists': defineCard('statsfm', buildStatsfmArtistsCard),
  simkl: defineCard('simkl', buildSimklCard),
  'simkl-movies': defineCard('simkl', buildSimklMoviesCard),
  'simkl-shows': defineCard('simkl', buildSimklShowsCard),
  goodreads: defineCard('goodreads', buildGoodreadsCard),
};

const repository = new Repository(config.databasePath);

async function renderCards(name: string, data: SourceSnapshot<unknown>): Promise<void> {
  for (const [cardName, card] of Object.entries(cards)) {
    if (card.source !== name) continue;
    try {
      setCache(`svg:${cardName}`, await card.build(data));
    } catch (err) {
      console.error(`[render] ${cardName} failed:`, err);
    }
  }
}

// Restore the last-good snapshot before making network requests. A restart
// therefore serves data immediately and an upstream outage cannot blank the
// site.
for (const saved of repository.loadSnapshots()) {
  restoreCache(`data:${saved.snapshot.source}`, saved.snapshot, Date.parse(saved.fetchedAt), saved.error ?? undefined);
  await renderCards(saved.snapshot.source, saved.snapshot);
}

async function refreshSource(name: string, isRetry = false): Promise<void> {
  const syncId = repository.startSync(name);
  try {
    const data = await fetchers[name]();
    const persisted = repository.finishSync(syncId, data);
    setCache(`data:${name}`, data);
    await renderCards(name, data);
    console.log(`[refresh] ${name} ok (${persisted.inserted} new, ${persisted.updated} seen)`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    repository.failSync(syncId, name, msg);
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

// Platform sections for the optional card gallery and status endpoint.
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
  const now = Date.now();
  const recent = repository.listActivities(500)
    .filter((activity) => {
      if (!activity.occurredAt || !['exact', 'day'].includes(activity.occurredAtPrecision)) return true;
      return Date.parse(activity.occurredAt) <= now;
    })
    .slice(0, 100);
  c.header('Cache-Control', 'no-cache');
  return c.html(homePage(
    config.ownerName,
    recent,
    repository.countPublicActivities(),
    lastUpdatedLabel(),
  ));
});

app.get('/cards', (c) => {
  const body = sections
    .map((s) => {
      // Card gallery uses WebP (≈10× smaller than the SVG for photo-heavy cards,
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
<link rel="alternate" type="application/rss+xml" title="${config.ownerName} · infovore" href="/feed.xml">
<title>cards · infovore · ${config.ownerName}</title>
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
<h1>infovore cards</h1>
<p class="sub"><a href="/">recent activity</a> · What ${config.ownerName} is playing, watching, reading and listening to — refreshed daily at ${config.refreshTimes.join(', ')} (GMT+8)${updated ? ` · last updated ${updated}` : ''}.</p>
${body}
<footer><a href="/profile">profile</a> · <a href="/now">now</a> · <a href="/wrapped">wrapped</a> · <a href="/feed.xml">rss</a> · <a href="/status">status</a> · <a href="https://github.com/skyhong2002/infovore">source</a></footer>
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
    database: { activities: repository.countPublicActivities(), latestRuns: repository.latestRuns() },
    cards: sections.flatMap((s) => s.cards).map((n) => `/card/${n}.svg`),
    sources,
  });
});

app.get('/api/activities.json', (c) => {
  const page = repository.queryActivities({
    limit: Number(c.req.query('limit') ?? 100), offset: Number(c.req.query('offset') ?? 0),
    source: c.req.query('source'), kind: c.req.query('kind'), status: c.req.query('status'),
    query: c.req.query('q'), since: c.req.query('since'), until: c.req.query('until'),
  });
  return c.json(page);
});

app.get('/feed.json', (c) => c.json(repository.queryActivities({ limit: Number(c.req.query('limit') ?? 100) })));

app.get('/feed.xml', (c) => {
  c.header('Content-Type', 'application/rss+xml; charset=UTF-8');
  return c.body(activityRss(repository.listActivities(100), config.publicBaseUrl, config.ownerName));
});

app.get('/profile', (c) => c.html(profilePage(
  config.ownerName, repository.countPublicActivities(), repository.countBySource(), repository.listActivities(12)
)));

function uniqueItems<T extends { source: string; sourceItemId: string | null; title: string }>(items: T[]): T[] {
  const seen = new Set<string>();
  return items.filter((item) => {
    const key = `${item.source}:${item.sourceItemId ?? item.title.toLocaleLowerCase('en-US')}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

app.get('/now', (c) => {
  const now = new Date().toISOString();
  const current = uniqueItems(repository.listActivities(500).filter((item) => ['current', 'reading', 'watching', 'playing'].includes(item.status ?? ''))).slice(0, 12);
  const upcoming = uniqueItems(repository.queryActivities({ kind: 'event', since: now, limit: 100 }).data).slice(0, 12);
  const recent = repository.queryActivities({ until: now, limit: 24 }).data;
  return c.html(nowPage(config.ownerName, current, upcoming, recent));
});

function requestedYear(value: string | undefined): number {
  const year = Number(value ?? new Date().getUTCFullYear());
  if (!Number.isInteger(year) || year < 2000 || year > 2200) throw new Error('year must be between 2000 and 2200');
  return year;
}

app.get('/api/wrapped/:file{[0-9]{4}\\.json}', (c) => {
  try { return c.json(repository.wrapped(requestedYear(c.req.param('file').replace(/\.json$/, '')))); }
  catch (error) { return c.json({ error: error instanceof Error ? error.message : String(error) }, 400); }
});

app.get('/wrapped', (c) => c.redirect(`/wrapped/${new Date().getUTCFullYear()}`));
app.get('/wrapped/:year', (c) => {
  try { return c.html(wrappedPage(config.ownerName, repository.wrapped(requestedYear(c.req.param('year'))))); }
  catch (error) { return c.text(error instanceof Error ? error.message : String(error), 400); }
});

app.options('/mcp', (c) => {
  c.header('Access-Control-Allow-Origin', '*');
  c.header('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  c.header('Access-Control-Allow-Headers', 'Content-Type, Accept, MCP-Protocol-Version, MCP-Session-Id, Last-Event-ID');
  c.header('Access-Control-Expose-Headers', 'MCP-Session-Id, MCP-Protocol-Version');
  return c.body(null, 204);
});

app.all('/mcp', async (c) => {
  const expectedHost = new URL(config.publicBaseUrl).host;
  const host = c.req.header('host') ?? '';
  if (host !== expectedHost && !/^localhost:\d+$/.test(host) && !/^127\.0\.0\.1:\d+$/.test(host)) {
    return c.json({ error: 'Invalid Host header' }, 421);
  }
  const response = await handleMcpRequest(repository, c.req.raw);
  const headers = new Headers(response.headers);
  headers.set('Access-Control-Allow-Origin', '*');
  headers.set('Access-Control-Expose-Headers', 'MCP-Session-Id, MCP-Protocol-Version');
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
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

app.get('/healthz', (c) => {
  const now = Date.now();
  const maxAgeMs = config.maxSourceAgeHours * 60 * 60 * 1000;
  const sources = activeSources.map((name) => {
    const entry = getCache(`data:${name}`);
    const ageMs = entry ? now - entry.fetchedAt : null;
    return { source: name, fresh: ageMs !== null && ageMs <= maxAgeMs, ageMs, error: entry?.error ?? null };
  });
  const freshCount = sources.filter((source) => source.fresh).length;
  const status = freshCount === 0 ? 'unhealthy' : sources.every((source) => source.fresh && !source.error) ? 'healthy' : 'degraded';
  return c.json({ status, maxSourceAgeHours: config.maxSourceAgeHours, sources }, status === 'unhealthy' ? 503 : 200);
});

if (process.env.NODE_ENV !== 'test') {
  serve({ fetch: app.fetch, port: config.port }, (info) => {
    console.log(`listening on :${info.port}`);
  });
}

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

if (process.env.NODE_ENV !== 'test') {
  refreshAll();
  scheduleNextRefresh();
}

export { app, repository };
