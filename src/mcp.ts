import { IN_PROGRESS_STATUSES, PAUSED_STATUSES, selectCurrent } from './data/status.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import * as z from 'zod/v4';
import type { Repository } from './data/database.js';
import { config } from './config.js';
import {
  createWallpaperSource, findWork, searchWallpapers, view, wallpaperGaps, type WallpaperSource,
} from './wallpapers.js';

const defaultWallpapers = createWallpaperSource(config.wallpapers.catalogUrl);
const EMOTIONS = ['joy', 'sadness', 'anger', 'fear', 'disgust', 'anxiety', 'envy', 'ennui', 'embarrassment'] as const;

function result(value: unknown) {
  const structuredContent = Array.isArray(value)
    ? { data: value }
    : value && typeof value === 'object' ? value as Record<string, unknown> : { value };
  return { content: [{ type: 'text' as const, text: JSON.stringify(value, null, 2) }], structuredContent };
}

function unique(items: ReturnType<Repository['listActivities']>) {
  const seen = new Set<string>();
  return items.filter((item) => {
    const key = `${item.source}:${item.sourceItemId ?? item.title.toLocaleLowerCase('en-US')}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function createMcpServer(repository: Repository, wallpapers: WallpaperSource = defaultWallpapers): McpServer {
  const server = new McpServer({ name: 'infovore', version: '1.0.0' });

  server.registerTool('get_recent_activities', {
    title: 'Recent activities', description: 'Get recent public media and event activities from the infovore lifelog.',
    inputSchema: {
      limit: z.number().int().min(1).max(100).default(20),
      source: z.string().optional(), kind: z.string().optional(),
    },
  }, async ({ limit, source, kind }) => result(repository.queryActivities({ limit, source, kind })));

  server.registerTool('search_lifelog', {
    title: 'Search lifelog', description: 'Search public activity titles and metadata, optionally constrained by dates.',
    inputSchema: {
      query: z.string().min(1), since: z.string().optional(), until: z.string().optional(),
      limit: z.number().int().min(1).max(100).default(20),
    },
  }, async ({ query, since, until, limit }) => result(repository.queryActivities({ query, since, until, limit })));

  server.registerTool('get_current_media', {
    title: 'Current media', description: 'Get items currently being played, watched, or read.', inputSchema: {},
  }, async () => result(selectCurrent([...repository.listActivities(500), ...repository.activitiesByStatus([...IN_PROGRESS_STATUSES, ...PAUSED_STATUSES])], new Date(), 50).current));

  server.registerTool('get_upcoming_events', {
    title: 'Upcoming events', description: 'Get public upcoming events, without ticket, order, seat, or payment data.',
    inputSchema: { limit: z.number().int().min(1).max(100).default(20) },
  }, async ({ limit }) => result({ data: unique(repository.queryActivities({ kind: 'event', since: new Date().toISOString(), limit: 100 }).data).slice(0, limit) }));

  server.registerTool('get_annual_summary', {
    title: 'Annual summary', description: 'Summarize cross-media activity for one year.',
    inputSchema: { year: z.number().int().min(2000).max(2200) },
  }, async ({ year }) => result(repository.wrapped(year)));

  server.registerTool('get_health_summary', {
    title: 'Health summary',
    description: 'Get public-safe Health Connect daily aggregates, recent workout summaries, and data coverage. Raw samples and device identifiers are excluded.',
    inputSchema: {},
  }, async () => result(repository.healthConnectSnapshot(config.ownerName)));

  server.registerTool('get_dayflow_summary', {
    title: 'Dayflow summary', description: 'Public daily computer-time aggregates, category totals and narrative keywords with general and historically distinctive recent pools. Dayflow days start at 4am Taipei time; full activity text and raw app lists are excluded.',
    inputSchema: { days: z.number().int().min(1).max(366).default(30) },
  }, async ({ days }) => {
    if (!config.dayflow.token || !config.sourceEnabled('dayflow')) return result({ error: 'Dayflow is not configured' });
    const snapshot = repository.dayflow.snapshot(config.ownerName);
    return result({ ...snapshot, extra: { ...snapshot.extra, daily: snapshot.extra.daily.slice(0, days) } });
  });

  // Wallpapers live in the separate afterimage collection; these tools only read its public catalog.
  const wallpaperTool = async (run: (catalog: Awaited<ReturnType<WallpaperSource['get']>>) => unknown) => {
    try { return result(run(await wallpapers.get())); }
    catch { return result({ error: 'The wallpaper collection is temporarily unavailable' }); }
  };

  server.registerTool('search_wallpapers', {
    title: 'Search wallpapers',
    description: 'Search the owner\'s wallpaper collection (afterimage) by caption or work title, and filter by work, emotion (Inside Out set) or device. Returns image URLs.',
    inputSchema: {
      query: z.string().optional(), work: z.string().optional(),
      emotion: z.enum(EMOTIONS).optional(), device: z.enum(['desktop', 'phone']).optional(),
      limit: z.number().int().min(1).max(100).default(20),
    },
  }, async (args) => wallpaperTool((catalog) => searchWallpapers(catalog, args)));

  server.registerTool('get_wallpapers_for_work', {
    title: 'Wallpapers for a work',
    description: 'List the wallpapers the owner has for one game, show, anime, movie or other work (matched by title, e.g. "Persona 5"), with a count and per-emotion breakdown.',
    inputSchema: { work: z.string().min(1), limit: z.number().int().min(1).max(100).default(30) },
  }, async ({ work, limit }) => wallpaperTool((catalog) => {
    const found = findWork(catalog, work);
    if (!found) return { work: null, total: 0, items: [], note: `No wallpapers for "${work}".` };
    const own = catalog.wallpapers.filter((w) => w.works.includes(found.id));
    const emotions: Record<string, number> = {};
    for (const w of own) if (w.emotion) emotions[w.emotion] = (emotions[w.emotion] ?? 0) + 1;
    return { work: found.title, kind: found.kind, total: own.length, emotions, items: own.slice(0, limit).map((w) => view(catalog, w)) };
  }));

  server.registerTool('get_wallpaper_gaps', {
    title: 'Wallpaper gaps',
    description: 'Compare recent games, anime, shows, movies and books from the lifelog with the wallpaper collection: which recent works already have wallpapers (with samples) and which have none yet. Use it to decide what wallpapers to look for.',
    inputSchema: { days: z.number().int().min(1).max(365).default(60), limit: z.number().int().min(1).max(100).default(30) },
  }, async ({ days, limit }) => wallpaperTool((catalog) => {
    const since = new Date(Date.now() - days * 86_400_000).toISOString();
    return wallpaperGaps(catalog, repository.activitiesSince(since), days, limit);
  }));
  return server;
}

export async function handleMcpRequest(repository: Repository, request: Request, wallpapers?: WallpaperSource): Promise<Response> {
  const transport = new WebStandardStreamableHTTPServerTransport({ enableJsonResponse: true });
  const server = createMcpServer(repository, wallpapers);
  await server.connect(transport);
  return transport.handleRequest(request);
}
