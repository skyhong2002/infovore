import { z } from 'zod';
import { config } from '../config.js';
import type { MediaEntry, SourceSnapshot } from '../data/types.js';
import type { YoutubeWatchInterval } from '../data/database.js';

// YouTube tracking lives in urtube (https://urtube.observe.tw), which keeps
// the private watch history and exposes public-safe aggregates per handle at
// /u/<handle>/summary.json. infovore mirrors two windows of that summary:
// the last 28 days for the platform page and cards, and the lifetime series
// for the time ledger. Exact watch timestamps are not on the public summary,
// so mirrored videos carry plays and time rather than a date. With a dashboard
// token, the private intervals feed additionally supplies each watch's clock
// time and seconds for coverage (see syncYoutubeIntervals).

const count = z.coerce.number().finite().catch(0);
const optionalString = z.string().catch('');

const summarySchema = z.object({
  range: z.string(),
  generatedAt: z.string().catch(() => new Date().toISOString()),
  stats: z.object({
    watchEvents: count,
    uniqueVideos: count,
    uniqueChannels: count,
    estimatedWatchSeconds: count,
    contentCoveredSeconds: count,
    actualWatchedSeconds: z.coerce.number().finite().nullable().catch(null),
    metadataCoverage: count,
    topicCoverage: count,
  }),
  daily: z.array(z.object({
    day: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    watches: count,
    estimatedWatchSeconds: count,
  })).catch([]),
  topChannels: z.array(z.object({
    channelId: z.string().nullable().catch(null),
    name: z.string(),
    thumbnailUrl: optionalString,
    watches: count,
    estimatedWatchSeconds: count,
  })).catch([]),
  topVideos: z.array(z.object({
    videoId: z.string(),
    title: z.string(),
    url: z.string(),
    channelTitle: optionalString,
    thumbnailUrl: optionalString,
    durationSeconds: z.coerce.number().finite().nullable().catch(null),
    watches: count,
    estimatedWatchSeconds: count,
  })).catch([]),
  topics: z.array(z.object({
    slug: z.string(),
    name: z.string(),
    watches: count,
    estimatedWatchSeconds: count,
  })).catch([]),
  keywords: z.array(z.object({ term: z.string(), videos: count, score: count })).catch([]),
});

export type YoutubeSummary = z.infer<typeof summarySchema>;
export type YoutubeWindowStats = YoutubeSummary['stats'] & { range: string };
export type YoutubeChannel = YoutubeSummary['topChannels'][number];
export type YoutubeVideo = YoutubeSummary['topVideos'][number];
export type YoutubeTopic = YoutubeSummary['topics'][number];
export type YoutubeKeyword = YoutubeSummary['keywords'][number];
export type YoutubeDay = YoutubeSummary['daily'][number];

export interface YoutubeExtra {
  dashboardUrl: string;
  generatedAt: string;
  // Last 28 days: what the platform page and cards show.
  recent: YoutubeWindowStats;
  lifetime: YoutubeWindowStats;
  topChannels: YoutubeChannel[];
  topVideos: YoutubeVideo[];
  topics: YoutubeTopic[];
  keywords: YoutubeKeyword[];
  // Lifetime per-day estimates (Taipei calendar days) for the time ledger.
  daily: YoutubeDay[];
}

export interface YoutubeMirrorOptions {
  baseUrl: string;
  handle: string;
  ownerName: string;
}

function timeLabel(seconds: number): string {
  if (seconds < 3600) return `${Math.max(1, Math.round(seconds / 60))}m`;
  return `${Math.round(seconds / 360) / 10}h`;
}

function windowStats(summary: YoutubeSummary): YoutubeWindowStats {
  return { ...summary.stats, range: summary.range };
}

export function normalizeYoutube(
  recentDoc: unknown,
  lifetimeDoc: unknown,
  options: YoutubeMirrorOptions,
): SourceSnapshot<YoutubeExtra> {
  const recent = summarySchema.parse(recentDoc);
  const lifetime = summarySchema.parse(lifetimeDoc);
  const dashboardUrl = `${options.baseUrl}/${options.handle}`;
  // Aggregates only: the mirrored videos never enter the public timeline or
  // feeds, they exist for the platform page and cards.
  const entries: MediaEntry[] = recent.topVideos.map((video) => ({
    sourceItemId: video.videoId,
    visibility: 'summary',
    source: 'youtube',
    kind: 'video',
    title: video.title,
    image: video.thumbnailUrl,
    status: 'watched',
    activityAt: '',
    rating: null,
    extra: {
      channel: video.channelTitle,
      url: video.url,
      plays: video.watches,
      playtime: timeLabel(video.estimatedWatchSeconds),
    },
  }));
  return {
    source: 'youtube',
    profile: { id: options.handle, name: options.ownerName, avatar: '', url: dashboardUrl },
    stats: {
      watchEvents: recent.stats.watchEvents,
      uniqueVideos: recent.stats.uniqueVideos,
      uniqueChannels: recent.stats.uniqueChannels,
      estimatedHours: Math.round(recent.stats.estimatedWatchSeconds / 3600),
      lifetimeWatches: lifetime.stats.watchEvents,
      lifetimeHours: Math.round(lifetime.stats.estimatedWatchSeconds / 3600),
    },
    entries,
    extra: {
      dashboardUrl,
      generatedAt: recent.generatedAt,
      recent: windowStats(recent),
      lifetime: windowStats(lifetime),
      topChannels: recent.topChannels,
      topVideos: recent.topVideos,
      topics: recent.topics,
      keywords: recent.keywords,
      daily: lifetime.daily,
    },
  };
}

async function getSummary(range: '28d' | 'all'): Promise<unknown> {
  const { baseUrl, handle } = config.urtube;
  const url = `${baseUrl}/u/${encodeURIComponent(handle)}/summary.json?range=${range}`;
  const res = await fetch(url, {
    headers: { Accept: 'application/json', 'User-Agent': config.userAgent },
    signal: AbortSignal.timeout(20000),
  });
  if (res.status === 404) throw new Error(`youtube: urtube has no public dashboard for "${handle}" (${url})`);
  if (!res.ok) throw new Error(`youtube: HTTP ${res.status} for ${url}`);
  return res.json();
}

export async function fetchYoutube(): Promise<SourceSnapshot<YoutubeExtra>> {
  const [recent, lifetime] = await Promise.all([getSummary('28d'), getSummary('all')]);
  return normalizeYoutube(recent, lifetime, { ...config.urtube, ownerName: config.ownerName });
}

const intervalsSchema = z.object({
  nextSince: z.string().nullable().catch(null),
  intervals: z.array(z.object({
    eventId: z.string().min(1),
    watchedAt: z.string().datetime({ offset: true }),
    precision: z.enum(['exact', 'day']).catch('day'),
    actualWatchedSeconds: z.coerce.number().finite().nullable().catch(null),
    estimatedWatchSeconds: z.coerce.number().finite().nullable().catch(null),
  })),
});

export interface YoutubeIntervalStore {
  youtubeIntervalCheckpoint(): string | null;
  upsertYoutubeWatchIntervals(rows: YoutubeWatchInterval[]): number;
}

const INTERVAL_PAGE = 5000;
const INTERVAL_MAX_PAGES = 50;
// urtube revises the newest estimates as later events arrive, so each sync
// re-reads the day before the checkpoint.
const INTERVAL_OVERLAP_MS = 86_400_000;

async function getIntervalPage(since: string): Promise<z.infer<typeof intervalsSchema>> {
  const { baseUrl, handle, dashboardToken } = config.urtube;
  const url = `${baseUrl}/u/${encodeURIComponent(handle)}/intervals.json?since=${encodeURIComponent(since)}&limit=${INTERVAL_PAGE}`;
  const res = await fetch(url, {
    headers: { Accept: 'application/json', Authorization: `Bearer ${dashboardToken}`, 'User-Agent': config.userAgent },
    signal: AbortSignal.timeout(30000),
  });
  if (!res.ok) throw new Error(`youtube: HTTP ${res.status} for ${url.replace(/since=[^&]*/, 'since=…')}`);
  return intervalsSchema.parse(await res.json());
}

// Pull every watch interval since the stored checkpoint (all history on the
// first run) and keep only its clock time and seconds. Returns rows stored,
// or null when no dashboard token is configured.
export async function syncYoutubeIntervals(store: YoutubeIntervalStore): Promise<number | null> {
  if (!config.urtube.dashboardToken) return null;
  const checkpoint = store.youtubeIntervalCheckpoint();
  let since = checkpoint ? new Date(Date.parse(checkpoint) - INTERVAL_OVERLAP_MS).toISOString() : '2000-01-01T00:00:00.000Z';
  let stored = 0;
  for (let page = 0; page < INTERVAL_MAX_PAGES; page++) {
    const { intervals, nextSince } = await getIntervalPage(since);
    stored += store.upsertYoutubeWatchIntervals(intervals.map((entry) => ({
      eventId: entry.eventId,
      watchedAt: new Date(entry.watchedAt).toISOString(),
      precision: entry.precision,
      seconds: entry.actualWatchedSeconds ?? entry.estimatedWatchSeconds ?? 0,
      method: entry.actualWatchedSeconds === null ? 'estimated' : 'measured',
    })));
    if (!nextSince || nextSince <= since || intervals.length === 0) break;
    since = nextSince;
  }
  return stored;
}
