import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { Hono } from 'hono';
import { serve } from '@hono/node-server';
import { config } from './config.js';
import { getCache, restoreCache, setCache, setCacheError } from './data/cache.js';
import { Repository } from './data/database.js';
import { selectHomepageActivities } from './data/activity.js';
import { nextIntervalAt } from './data/schedule.js';
import type { Activity, SourceSnapshot } from './data/types.js';
import { fetchBackloggd } from './sources/backloggd.js';
import { fetchKitsu } from './sources/kitsu.js';
import { fetchStatsfm } from './sources/statsfm.js';
import { fetchSimkl } from './sources/simkl.js';
import { fetchGoodreads } from './sources/goodreads.js';
import { rasterize } from './output/render.js';
import { activityRss } from './output/feed.js';
import { homePage, html, nowPage, profilePage, shell, wrappedPage } from './output/pages.js';
import { platformIndexPage, platformPage, type PlatformDefinition, type PlatformSummary } from './output/platforms.js';
import { handleMcpRequest } from './mcp.js';
import { buildBackloggdCard } from './output/backloggd.js';
import { buildKitsuCard, buildKitsuAnimeCard, buildKitsuMangaCard } from './output/kitsu.js';
import { buildStatsfmCard, buildStatsfmAlbumsCard, buildStatsfmArtistsCard } from './output/statsfm.js';
import { buildSimklCard, buildSimklMoviesCard, buildSimklShowsCard } from './output/simkl.js';
import { buildGoodreadsCard } from './output/goodreads.js';
import {
  buildYoutubeChannelsCard,
  buildYoutubeOverviewCard,
  buildYoutubeTopicsCard,
  youtubeDashboardPage,
} from './output/youtube.js';
import type { YoutubeRange } from './youtube/types.js';

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
  build?: (data: SourceSnapshot<unknown>) => Promise<string>;
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
  youtube: { source: 'youtube' },
  'youtube-channels': { source: 'youtube' },
  'youtube-topics': { source: 'youtube' },
};

const repository = new Repository(config.databasePath);

async function renderCards(name: string, data: SourceSnapshot<unknown>): Promise<void> {
  for (const [cardName, card] of Object.entries(cards)) {
    if (card.source !== name || !card.build) continue;
    try {
      setCache(`svg:${cardName}`, await card.build(data));
    } catch (err) {
      console.error(`[render] ${cardName} failed:`, err);
    }
  }
}

async function renderYoutubePresentation(): Promise<void> {
  const data = repository.youtubeDashboard('28d');
  const builders = {
    youtube: buildYoutubeOverviewCard,
    'youtube-channels': buildYoutubeChannelsCard,
    'youtube-topics': buildYoutubeTopicsCard,
  };
  for (const [name, build] of Object.entries(builders)) {
    try {
      setCache(`svg:${name}`, await build(data));
    } catch (error) {
      console.error(`[render] ${name} failed:`, error);
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
if (config.sourceEnabled('youtube')) await renderYoutubePresentation();

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
  if (config.sourceEnabled('youtube')) await renderYoutubePresentation();
}

const app = new Hono();
const ogImage = readFileSync(new URL('../assets/og.png', import.meta.url));

app.get('/og.png', (c) => {
  c.header('Content-Type', 'image/png');
  c.header('Cache-Control', 'public, max-age=604800');
  return c.body(ogImage.buffer.slice(ogImage.byteOffset, ogImage.byteOffset + ogImage.byteLength) as ArrayBuffer);
});

// Platform sections for the optional card gallery and status endpoint.
// URLs derive from config so a self-hosted instance links to its own profiles;
// only sections whose source is enabled are shown.
const allSections: PlatformDefinition[] = [
  { source: 'backloggd', title: 'Backloggd', description: 'Games played, backlog totals, platforms and recent sessions.', accent: '#8dd3a8', url: `https://backloggd.com/u/${config.backloggd.username}/`, cards: ['backloggd'] },
  { source: 'kitsu', title: 'Kitsu', description: 'Anime and manga progress, ratings and library status.', accent: '#f779a1', url: `https://kitsu.app/users/${config.kitsu.slug}`, cards: ['kitsu', 'kitsu-anime', 'kitsu-manga'] },
  { source: 'statsfm', title: 'stats.fm', description: 'Recent listens, weekly totals, top albums and top artists.', accent: '#1ed760', url: `https://stats.fm/${config.statsfm.username}`, cards: ['statsfm', 'statsfm-albums', 'statsfm-artists'] },
  { source: 'simkl', title: 'Simkl', description: 'Movies, TV and anime collected into one watch history.', accent: '#7bb8ff', url: `https://simkl.com/${config.simkl.userId}/`, cards: ['simkl', 'simkl-shows', 'simkl-movies'] },
  { source: 'goodreads', title: 'Goodreads', description: 'Reading shelf, completed books, authors and ratings.', accent: '#d6b98c', url: `https://www.goodreads.com/user/show/${config.goodreads.userId}`, cards: ['goodreads'] },
  { source: 'youtube', title: 'YouTube', description: 'Viewing volume, channels, topics and recently watched videos.', accent: '#ff453a', url: 'https://www.youtube.com/feed/history', cards: ['youtube', 'youtube-channels', 'youtube-topics'] },
];

const sections = allSections.filter((s) => config.sourceEnabled(s.source));
const manualPlatform: PlatformDefinition = {
  source: 'events', title: 'Manual events', description: 'Concerts, performances and real-world activities recorded by hand.',
  accent: '#c39bff',
};

function youtubeSnapshot(): SourceSnapshot {
  const data = repository.youtubeDashboard('28d');
  return {
    source: 'youtube',
    profile: { id: 'youtube', name: config.ownerName, avatar: '', url: 'https://www.youtube.com/feed/history' },
    stats: {
      watchEvents: data.stats.watchEvents,
      uniqueVideos: data.stats.uniqueVideos,
      uniqueChannels: data.stats.uniqueChannels,
      estimatedHours: Math.round(data.stats.estimatedWatchSeconds / 3600),
    },
    entries: data.recent.map((video) => ({
      sourceItemId: video.videoId ?? video.url,
      visibility: 'summary' as const,
      source: 'youtube',
      kind: 'video' as const,
      title: video.title,
      image: video.thumbnailUrl,
      status: 'watched',
      activityAt: video.watchedAt,
      rating: null,
      extra: { channel: video.channelTitle, url: video.url },
    })),
    extra: {},
  };
}

function youtubeRecentActivities(): Activity[] {
  return repository.youtubeDashboard('28d').recent.map((video) => ({
    id: `youtube-home-${video.videoId ?? video.watchedAt}`,
    dedupeKey: `youtube-home-${video.videoId ?? video.watchedAt}`,
    source: 'youtube',
    sourceItemId: video.videoId,
    type: 'video.watched',
    mediaKind: 'video',
    title: video.title,
    image: video.thumbnailUrl,
    status: 'watched',
    occurredAt: video.watchedAt,
    occurredAtPrecision: 'exact',
    rating: null,
    visibility: 'public',
    extra: { channel: video.channelTitle, url: video.url },
    firstSeenAt: video.watchedAt,
    lastSeenAt: video.watchedAt,
  }));
}

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

// The most recent successful fetch across active sources.
function lastUpdatedLabel(): string | null {
  const timestamps = activeSources
    .map((name) => getCache(`data:${name}`)?.fetchedAt)
    .filter((t): t is number => typeof t === 'number');
  return timestamps.length ? formatGmt8(Math.max(...timestamps)) : null;
}

app.get('/', (c) => {
  const now = Date.now();
  const all = repository.listActivities(500);
  const eligible = all
    .filter((activity) => {
      if (!activity.occurredAt || !['exact', 'day'].includes(activity.occurredAtPrecision)) return true;
      return Date.parse(activity.occurredAt) <= now;
    });
  const youtubeActivities = config.sourceEnabled('youtube') ? youtubeRecentActivities() : [];
  const combined = [...youtubeActivities, ...eligible]
    .sort((a, b) => Date.parse(b.occurredAt ?? '') - Date.parse(a.occurredAt ?? ''));
  const recent = selectHomepageActivities(combined, 24);
  const youtubeWatchCount = config.sourceEnabled('youtube') ? repository.youtubeCounts().videoWatches : 0;
  c.header('Cache-Control', 'no-cache');
  return c.html(homePage(
    config.ownerName,
    recent,
    repository.countPublicActivities() + youtubeWatchCount,
    lastUpdatedLabel(),
    sections.length + 1,
    currentActivities(all, 4),
    upcomingActivities(new Date(now).toISOString(), 4),
    latestSourceActivities(combined),
  ));
});

function manualEventsSnapshot(): SourceSnapshot {
  const page = repository.queryActivities({ source: 'events', limit: 500 });
  const entries = page.data.map((activity) => ({
    sourceItemId: activity.sourceItemId ?? activity.id,
    source: 'events',
    kind: 'event' as const,
    title: activity.title,
    image: activity.image,
    status: activity.status ?? undefined,
    activityAt: activity.occurredAt ?? activity.firstSeenAt,
    rating: activity.rating,
    extra: activity.extra,
  }));
  return {
    source: 'events',
    profile: { id: 'manual', name: config.ownerName, avatar: '', url: '' },
    stats: {
      events: page.total,
      attended: entries.filter((entry) => entry.status === 'attended').length,
      upcoming: entries.filter((entry) => ['upcoming', 'ticketed'].includes(entry.status ?? '')).length,
    },
    entries,
    extra: {},
  };
}

app.get('/platforms', (c) => {
  const connected: PlatformSummary[] = sections.map((definition) => {
    if (definition.source === 'youtube') {
      return { definition, snapshot: youtubeSnapshot(), fetchedAt: null };
    }
    const cached = getCache<SourceSnapshot<unknown>>(`data:${definition.source}`);
    return {
      definition,
      snapshot: cached?.data ?? null,
      fetchedAt: cached ? new Date(cached.fetchedAt).toISOString() : null,
    };
  });
  connected.push({ definition: manualPlatform, snapshot: manualEventsSnapshot(), fetchedAt: null });
  c.header('Cache-Control', 'no-cache');
  return c.html(platformIndexPage(config.ownerName, connected));
});

app.get('/platforms/:source', (c) => {
  const source = c.req.param('source');
  const definition = source === 'events' ? manualPlatform : sections.find((section) => section.source === source);
  if (!definition) return c.text('Platform not found', 404);
  if (source === 'youtube') {
    const requestedRange = c.req.query('range') ?? '28d';
    const range: YoutubeRange = ['7d', '28d', '90d', 'all'].includes(requestedRange)
      ? requestedRange as YoutubeRange
      : '28d';
    const sort = c.req.query('sort') === 'watches' ? 'watches' : 'duration';
    c.header('Cache-Control', 'no-cache');
    return c.html(youtubeDashboardPage(config.ownerName, repository.youtubeDashboard(range), sort));
  }
  if (source === 'events') {
    c.header('Cache-Control', 'no-cache');
    return c.html(platformPage(config.ownerName, definition, manualEventsSnapshot(), null));
  }
  const cached = getCache<SourceSnapshot<unknown>>(`data:${source}`);
  if (!cached?.data) return c.text('Platform has not completed its first sync yet', 503);
  c.header('Cache-Control', 'no-cache');
  const cardVersions = Object.fromEntries((definition.cards ?? []).map((name) => [name, version(name)]));
  return c.html(platformPage(config.ownerName, definition, cached.data, new Date(cached.fetchedAt).toISOString(), cardVersions));
});

app.get('/cards', (c) => {
  const body = sections
    .map((s) => {
      const externalUrl = s.url ?? '#';
      // Card gallery uses WebP (≈10× smaller than the SVG for photo-heavy cards,
      // still retina-crisp at 2×); the .svg vector stays available via the link.
      const imgs = (s.cards ?? [])
        .map(
          (n) =>
            `<a href="/card/${html(n)}.svg?v=${version(n)}"><img src="/card/${html(n)}.webp?v=${version(n)}" alt="${html(s.title)} ${html(n)} card" width="520" loading="lazy"></a>`
        )
        .join('\n');
      const shortUrl = externalUrl.replace(/^https:\/\//, '').replace(/\/$/, '');
      return `<section class="card-gallery-section"><div class="card-gallery-title"><h2><a href="/platforms/${html(s.source)}">${html(s.title)}</a></h2><a class="profile-link" href="${html(externalUrl)}">${html(shortUrl)} ↗</a></div><div class="card-gallery-row">${imgs}</div></section>`;
    })
    .join('\n');
  const updated = lastUpdatedLabel();
  c.header('Cache-Control', 'no-cache');
  const intro = `<section class="page-intro"><div><div class="eyebrow">Shareable view</div><h1>Cards</h1>
    <p>Compact visual snapshots generated from the same platform data. Use this gallery when the timeline is too detailed and the platform mirrors are too broad.</p></div>
    <div class="page-intro-aside">${updated ? `Last synced ${html(updated)}.` : ''} Click any card for its SVG original.</div></section>
    <div class="context-line"><a href="/">Home</a><span>→</span><a href="/platforms">Platforms</a><span>→</span><strong>Cards</strong></div>`;
  return c.html(shell(`${config.ownerName} · cards`, `${intro}<div class="card-gallery">${body}</div>`, 'cards'));
});

app.get('/status', (c) => {
  const sources: Array<Record<string, unknown>> = activeSources.map((name) => {
    const entry = getCache(`data:${name}`);
    return {
      source: name,
      lastFetched: entry ? new Date(entry.fetchedAt).toISOString() : null,
      error: entry?.error ?? null,
      json: `/api/${name}.json`,
    };
  });
  if (config.sourceEnabled('youtube')) {
    sources.push({
      source: 'youtube',
      counts: repository.youtubeCounts(),
      oauthAuthorized: Boolean(repository.youtubeOAuthCredential()),
      sync: {
        checkpoint: repository.youtubeSyncState('checkpoint'),
        activeJob: Boolean(repository.youtubeSyncState('active_job')),
        lastResult: repository.youtubeSyncState('last_result'),
        lastError: repository.youtubeSyncState('last_error'),
      },
      summary: '/api/youtube/summary.json',
    });
  }
  return c.json({
    owner: config.ownerName,
    refresh: {
      intervalMinutes: config.refreshIntervalMinutes,
      nextScheduledAt: new Date(nextRunAt()).toISOString(),
    },
    database: { activities: repository.countPublicActivities(), latestRuns: repository.latestRuns() },
    cards: sections.flatMap((s) => s.cards ?? []).map((n) => `/card/${n}.svg`),
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

app.get('/api/youtube/summary.json', (c) => {
  const requested = c.req.query('range') ?? '28d';
  const range: YoutubeRange = ['7d', '28d', '90d', 'all'].includes(requested)
    ? requested as YoutubeRange
    : '28d';
  const data = repository.youtubeDashboard(range);
  return c.json({ ...data, recent: undefined });
});

app.get('/api/youtube/recent.json', (c) => {
  const data = repository.youtubeDashboard('28d');
  return c.json({
    range: data.range,
    generatedAt: data.generatedAt,
    data: data.recent.map(({
      watchedAt: _watchedAt,
      actualWatchedSeconds: _actualWatchedSeconds,
      ...video
    }) => video),
  });
});

app.get('/feed.json', (c) => c.json(repository.queryActivities({ limit: Number(c.req.query('limit') ?? 100) })));

app.get('/feed.xml', (c) => {
  c.header('Content-Type', 'application/rss+xml; charset=UTF-8');
  return c.body(activityRss(repository.listActivities(100), config.publicBaseUrl, config.ownerName));
});

app.get('/profile', (c) => c.html(profilePage(
  config.ownerName,
  repository.countPublicActivities() + (config.sourceEnabled('youtube') ? repository.youtubeCounts().videoWatches : 0),
  {
    ...repository.countBySource(),
    ...(config.sourceEnabled('youtube') ? { youtube: repository.youtubeCounts().videoWatches } : {}),
  },
  repository.listActivities(12)
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

function currentActivities(items: ReturnType<Repository['listActivities']>, limit = 12) {
  return uniqueItems(items).filter((item) =>
    ['current', 'reading', 'watching', 'playing'].includes(item.status ?? '')
  ).slice(0, limit);
}

function upcomingActivities(now: string, limit = 12) {
  return uniqueItems(repository.queryActivities({ kind: 'event', since: now, limit: 100 }).data)
    .sort((a, b) => Date.parse(a.occurredAt ?? '') - Date.parse(b.occurredAt ?? ''))
    .slice(0, limit);
}

function latestSourceActivities(items: ReturnType<Repository['listActivities']>) {
  const seen = new Set<string>();
  return uniqueItems(items).filter((item) => {
    if (seen.has(item.source)) return false;
    seen.add(item.source);
    return true;
  }).slice(0, sections.length + 1);
}

app.get('/now', (c) => {
  const now = new Date().toISOString();
  const current = currentActivities(repository.listActivities(500));
  const upcoming = upcomingActivities(now);
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
  const sources: Array<{
    source: string;
    fresh: boolean;
    ageMs: number | null;
    error: string | null;
  }> = activeSources.map((name) => {
    const entry = getCache(`data:${name}`);
    const ageMs = entry ? now - entry.fetchedAt : null;
    return { source: name, fresh: ageMs !== null && ageMs <= maxAgeMs, ageMs, error: entry?.error ?? null };
  });
  if (config.sourceEnabled('youtube')) {
    const counts = repository.youtubeCounts();
    sources.push({
      source: 'youtube',
      fresh: counts.videoWatches > 0,
      ageMs: null,
      error: repository.youtubeSyncState('last_error') || null,
    });
  }
  const freshCount = sources.filter((source) => source.fresh).length;
  const status = freshCount === 0 ? 'unhealthy' : sources.every((source) => source.fresh && !source.error) ? 'healthy' : 'degraded';
  return c.json({ status, maxSourceAgeHours: config.maxSourceAgeHours, sources }, status === 'unhealthy' ? 503 : 200);
});

if (process.env.NODE_ENV !== 'test') {
  serve({ fetch: app.fetch, port: config.port }, (info) => {
    console.log(`listening on :${info.port}`);
  });
}

// Refresh immediately on startup, then at the next interval boundary. The
// recursive timeout is scheduled after the current refresh finishes so slow
// upstreams can never cause overlapping cycles.
function nextRunAt(): number {
  return nextIntervalAt(Date.now(), config.refreshIntervalMinutes);
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
