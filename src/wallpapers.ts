// Read-only view of the afterimage wallpaper catalog, used by the MCP tools.
//
// Wallpapers are deliberately NOT a lifelog source: they are a collection, not
// something that happened, so they never enter the activities table, the
// timeline, the RSS feed or the cards. This module only fetches the public
// catalog, caches it, and answers questions about it.

import * as z from 'zod/v4';
import type { Activity, MediaKind } from './data/types.js';

const CatalogSchema = z.object({
  works: z.array(z.object({
    id: z.string(), title: z.string(), kind: z.string(), count: z.number().int().nonnegative().default(0),
  })),
  wallpapers: z.array(z.object({
    id: z.string(), caption: z.string(), device: z.enum(['desktop', 'phone']),
    width: z.number(), height: z.number(),
    works: z.array(z.string()), emotion: z.string().nullable().optional(),
    palette: z.array(z.string()).default([]), reviewed: z.boolean().default(false),
  })),
});

export type WallpaperCatalog = z.infer<typeof CatalogSchema> & { baseUrl: string };
export type Wallpaper = WallpaperCatalog['wallpapers'][number];
export type Work = WallpaperCatalog['works'][number];

export interface WallpaperSource {
  get(): Promise<WallpaperCatalog>;
}

export function parseCatalog(doc: unknown, baseUrl: string): WallpaperCatalog {
  return { ...CatalogSchema.parse(doc), baseUrl: baseUrl.replace(/\/$/, '') };
}

// Fetches the catalog, keeps it for `ttlMs`, and serves the last good copy if a
// refresh fails (the catalog changes rarely; an outage must not break the tools).
export function createWallpaperSource(
  url: string,
  options: { ttlMs?: number; fetchImpl?: typeof fetch; now?: () => number } = {},
): WallpaperSource {
  const { ttlMs = 10 * 60_000, fetchImpl = fetch, now = Date.now } = options;
  const baseUrl = new URL(url).origin;
  let cached: { at: number; catalog: WallpaperCatalog } | null = null;
  let inflight: Promise<WallpaperCatalog> | null = null;

  async function refresh(): Promise<WallpaperCatalog> {
    const res = await fetchImpl(url, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(10_000) });
    if (!res.ok) throw new Error(`wallpaper catalog: HTTP ${res.status}`);
    const catalog = parseCatalog(await res.json(), baseUrl);
    cached = { at: now(), catalog };
    return catalog;
  }

  return {
    async get() {
      if (cached && now() - cached.at < ttlMs) return cached.catalog;
      inflight ??= refresh().finally(() => { inflight = null; });
      try { return await inflight; }
      catch (error) {
        if (cached) return cached.catalog;
        throw error;
      }
    },
  };
}

// ---- text matching -------------------------------------------------------

export function normalize(text: string): string {
  return text.toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
}

// A short title ("Up", "V", "140") only matches exactly, otherwise it would match
// inside half the library; longer ones match as a whole-word phrase.
const MIN_PHRASE = 5;

function matchScore(a: string, b: string): number {
  if (!a || !b) return 0;
  if (a === b) return 1000 + a.length;
  const [long, short] = a.length >= b.length ? [a, b] : [b, a];
  if (short.length < MIN_PHRASE) return 0;
  return ` ${long} `.includes(` ${short} `) ? short.length : 0;
}

export function findWork(catalog: WallpaperCatalog, text: string): Work | undefined {
  const q = normalize(text);
  let best: { work: Work; score: number } | undefined;
  for (const work of catalog.works) {
    const score = matchScore(normalize(work.title), q);
    if (score > 0 && (!best || score > best.score)) best = { work, score };
  }
  return best?.work;
}

// ---- views ---------------------------------------------------------------

export function view(catalog: WallpaperCatalog, w: Wallpaper) {
  const titles = new Map(catalog.works.map((work) => [work.id, work.title]));
  return {
    id: w.id,
    caption: w.caption,
    device: w.device,
    size: `${w.width}x${w.height}`,
    works: w.works.map((id) => titles.get(id) ?? id),
    emotion: w.emotion ?? null,
    palette: w.palette,
    reviewed: w.reviewed,
    thumbnailUrl: `${catalog.baseUrl}/thumbs/${w.id}.avif`,
    previewUrl: `${catalog.baseUrl}/view/${w.id}.avif`,
    pageUrl: `${catalog.baseUrl}/#${w.id}`,
  };
}

export interface WallpaperQuery {
  query?: string; work?: string; emotion?: string; device?: 'desktop' | 'phone'; limit?: number;
}

export function searchWallpapers(catalog: WallpaperCatalog, q: WallpaperQuery) {
  const limit = Math.max(1, Math.min(100, q.limit ?? 20));
  const work = q.work ? findWork(catalog, q.work) : undefined;
  if (q.work && !work) return { total: 0, items: [], note: `No work matching "${q.work}" in the wallpaper collection.` };
  const term = q.query ? normalize(q.query) : '';
  const titles = new Map(catalog.works.map((w) => [w.id, normalize(w.title)]));
  const hits = catalog.wallpapers.filter((w) =>
    (!work || w.works.includes(work.id)) &&
    (!q.emotion || w.emotion === q.emotion) &&
    (!q.device || w.device === q.device) &&
    (!term || normalize([w.caption, ...w.works.map((id) => titles.get(id) ?? '')].join(' ')).includes(term)));
  return { total: hits.length, items: hits.slice(0, limit).map((w) => view(catalog, w)) };
}

// ---- gaps: what I played or watched lately that has no wallpaper yet -----

const GAP_KINDS: ReadonlySet<MediaKind> = new Set(['game', 'anime', 'manga', 'movie', 'show', 'book']);

export function wallpaperGaps(catalog: WallpaperCatalog, activities: Activity[], windowDays: number, limit: number) {
  const byWork = new Map<string, Wallpaper[]>();
  for (const w of catalog.wallpapers) for (const id of w.works) byWork.set(id, [...(byWork.get(id) ?? []), w]);

  const covered = new Map<string, { work: Work; lastActivityAt: string | null; titles: Set<string> }>();
  const gaps = new Map<string, { title: string; kind: MediaKind; source: string; status: string | null; lastActivityAt: string | null; rating: Activity['rating'] }>();

  for (const a of activities) {
    // music: the track title says nothing about the work, the artist does
    const names = a.mediaKind === 'music' ? [String(a.extra.artist ?? '')] : GAP_KINDS.has(a.mediaKind) ? [a.title] : [];
    if (!names.some(Boolean)) continue;
    const work = names.map((n) => findWork(catalog, n)).find(Boolean);
    if (work) {
      const entry = covered.get(work.id) ?? { work, lastActivityAt: a.occurredAt, titles: new Set<string>() };
      entry.titles.add(a.title);
      if (a.occurredAt && (!entry.lastActivityAt || a.occurredAt > entry.lastActivityAt)) entry.lastActivityAt = a.occurredAt;
      covered.set(work.id, entry);
    } else if (GAP_KINDS.has(a.mediaKind)) {
      const key = normalize(a.title);
      const prev = gaps.get(key);
      if (!prev || (a.occurredAt ?? '') > (prev.lastActivityAt ?? '')) {
        gaps.set(key, { title: a.title, kind: a.mediaKind, source: a.source, status: a.status, lastActivityAt: a.occurredAt, rating: a.rating });
      }
    }
  }

  const recent = (x: { lastActivityAt: string | null }) => x.lastActivityAt ?? '';
  return {
    windowDays,
    covered: [...covered.values()].sort((a, b) => recent(b).localeCompare(recent(a))).slice(0, limit).map((c) => ({
      work: c.work.title, kind: c.work.kind, wallpaperCount: byWork.get(c.work.id)?.length ?? 0,
      lastActivityAt: c.lastActivityAt, activityTitles: [...c.titles].slice(0, 5),
      samples: (byWork.get(c.work.id) ?? []).slice(0, 3).map((w) => view(catalog, w).thumbnailUrl),
    })),
    gaps: [...gaps.values()].sort((a, b) => recent(b).localeCompare(recent(a))).slice(0, limit),
  };
}
