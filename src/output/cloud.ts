import type { Activity, MediaKind } from '../data/types.js';
import { h, logo, renderCard, textFont } from './render.js';
import { sourceLabel } from './pages.js';

// One thing the owner spent attention on inside the window: an artist, a
// game, a channel, a film. `weight` is the share of the busiest term's
// attention time, so a 9-hour game and a 90-play artist land near each
// other while a single film sits well below both.
export interface CloudTerm {
  label: string;
  source: string;
  kind: MediaKind;
  count: number;
  weight: number;
}

const SOURCE_LIMITS: Record<string, number> = { statsfm: 14, backloggd: 10, youtube: 10, dayflow: 10, health: 6 };
const DEFAULT_SOURCE_LIMIT = 8;
const TOTAL_LIMIT = 48;

// Attention seconds assumed per event when the source does not measure time.
const DEFAULT_SECONDS: Record<MediaKind, number> = {
  music: 4 * 60, game: 20 * 60, anime: 24 * 60, manga: 20 * 60, movie: 2 * 3600,
  show: 45 * 60, book: 3600, video: 10 * 60, event: 2 * 3600, fitness: 0, computer: 0,
};

// Health and Dayflow activities in the timeline are daily roll-ups ("12,345
// steps", a day's computer time). The cloud takes those sources through
// `extras` instead: exercise types with measured duration, and Dayflow
// keywords with the time of the activities that mention them.
const EXCLUDED_KINDS = new Set<MediaKind>(['fitness', 'computer']);

// The shape urtube's summary exposes for a channel (see sources/youtube.ts).
export interface CloudChannel {
  name: string;
  watches: number;
  estimatedWatchSeconds: number;
}

// A pre-aggregated thing from a source that does not flow through the
// activity timeline. `seconds` is measured attention time.
export interface CloudEntry {
  source: string;
  kind: MediaKind;
  label: string;
  count: number;
  seconds: number;
}

function playtimeSeconds(value: unknown): number {
  if (typeof value !== 'string') return 0;
  const hours = /(\d+)\s*h/.exec(value);
  const minutes = /(\d+)\s*m/.exec(value);
  return Number(hours?.[1] ?? 0) * 3600 + Number(minutes?.[1] ?? 0) * 60;
}

interface Accumulator { label: string; source: string; kind: MediaKind; count: number; seconds: number }

export function buildCloudTerms(activities: Activity[], channels: CloudChannel[] = [], extras: CloudEntry[] = []): CloudTerm[] {
  const buckets = new Map<string, Accumulator>();
  const bump = (source: string, kind: MediaKind, label: string, seconds: number) => {
    const clean = label.trim();
    if (!clean) return;
    const key = `${source} ${clean.toLocaleLowerCase('en-US')}`;
    const bucket = buckets.get(key) ?? { label: clean, source, kind, count: 0, seconds: 0 };
    bucket.count++;
    bucket.seconds += seconds;
    buckets.set(key, bucket);
  };
  for (const activity of activities) {
    if (activity.visibility !== 'public') continue;
    if (activity.mediaKind === 'video') continue; // YouTube arrives via `channels`
    if (EXCLUDED_KINDS.has(activity.mediaKind)) continue;
    if (activity.mediaKind === 'music') {
      const artists = String(activity.extra.artist ?? '').split(/,\s*/).filter(Boolean);
      const duration = Number(activity.extra.durationMs) > 0 ? Number(activity.extra.durationMs) / 1000 : 0;
      for (const artist of artists) bump(activity.source, 'music', artist, duration);
      continue;
    }
    const seconds = activity.mediaKind === 'game' ? playtimeSeconds(activity.extra.playtime) : 0;
    bump(activity.source, activity.mediaKind, activity.title, seconds);
  }
  for (const channel of channels) {
    if (!channel.watches || /^unknown channel$/i.test(channel.name.trim())) continue;
    const key = `youtube ${channel.name.trim().toLocaleLowerCase('en-US')}`;
    buckets.set(key, {
      label: channel.name.trim(), source: 'youtube', kind: 'video',
      count: channel.watches, seconds: channel.estimatedWatchSeconds,
    });
  }
  for (const entry of extras) {
    const label = entry.label.trim();
    if (!label || entry.count <= 0) continue;
    buckets.set(`${entry.source} ${label.toLocaleLowerCase('en-US')}`, {
      label, source: entry.source, kind: entry.kind, count: entry.count, seconds: Math.max(0, entry.seconds),
    });
  }

  // Measured time when the source records it, otherwise a per-kind estimate.
  const value = (item: Accumulator) => item.seconds > 0 ? item.seconds : item.count * DEFAULT_SECONDS[item.kind];
  const bySource = new Map<string, Accumulator[]>();
  for (const bucket of buckets.values()) {
    bySource.set(bucket.source, [...(bySource.get(bucket.source) ?? []), bucket]);
  }
  const kept: Accumulator[] = [];
  for (const [source, list] of bySource) {
    kept.push(...list
      .sort((a, b) => value(b) - value(a) || b.count - a.count || a.label.localeCompare(b.label))
      .slice(0, SOURCE_LIMITS[source] ?? DEFAULT_SOURCE_LIMIT));
  }
  const max = Math.max(1, ...kept.map(value));
  return kept
    .map((item) => ({
      label: item.label, source: item.source, kind: item.kind, count: item.count,
      weight: Math.round(value(item) / max * 1000) / 1000,
    }))
    .sort((a, b) => b.weight - a.weight || b.count - a.count || a.label.localeCompare(b.label))
    .slice(0, TOTAL_LIMIT);
}

// ---- layout ---------------------------------------------------------------

export interface PlacedTerm extends CloudTerm {
  x: number;
  y: number;
  width: number;
  height: number;
  fontSize: number;
}

const CJK = /[⺀-鿿豈-﫿＀-￯　-〿가-힯]/;

// Approximate Inter Bold advance widths as a fraction of the font size.
function glyphWidth(ch: string): number {
  if (CJK.test(ch)) return 1;
  if (ch === ' ') return 0.28;
  if (/[iljtfr'.,:;!|I]/.test(ch)) return 0.32;
  if (/[mwMW@]/.test(ch)) return 0.92;
  if (/[A-Z]/.test(ch)) return 0.7;
  if (/[0-9]/.test(ch)) return 0.62;
  if (/[a-z]/.test(ch)) return 0.58;
  return 0.6;
}

export function textWidth(label: string, fontSize: number): number {
  let units = 0;
  for (const ch of label) units += glyphWidth(ch);
  return units * fontSize * 1.04 + 2;
}

export const MIN_FONT = 11;
export const MAX_FONT = 34;

// Square-root scaling keeps the long tail legible without letting the top
// term swallow the card.
export function cloudFontSize(weight: number, min = MIN_FONT, max = MAX_FONT): number {
  return Math.round(min + (max - min) * Math.sqrt(Math.max(0, Math.min(1, weight))));
}

const LINE = 1.15;
const GAP = 3;

function overlaps(a: PlacedTerm, b: PlacedTerm): boolean {
  return a.x < b.x + b.width + GAP && a.x + a.width + GAP > b.x
    && a.y < b.y + b.height + GAP && a.y + a.height + GAP > b.y;
}

// Archimedean spiral placement from the centre outward, the classic
// word-cloud packing. Terms that find no room are dropped rather than
// squeezed, so the card never renders overlapping text.
// A term that finds no room at its natural size is retried smaller
// before being dropped, so long titles still appear.
export function layoutCloud(terms: CloudTerm[], width: number, height: number): PlacedTerm[] {
  const placed: PlacedTerm[] = [];
  const ratio = height / width;
  const place = (term: CloudTerm, fontSize: number): PlacedTerm | null => {
    const w = textWidth(term.label, fontSize);
    const hgt = fontSize * LINE;
    if (w > width * 0.7 || hgt > height) return null;
    for (let step = 0; step < 6000; step++) {
      const angle = step * 0.18;
      const radius = angle * 1.1;
      if (radius > width) return null;
      const candidate: PlacedTerm = {
        ...term, fontSize, width: w, height: hgt,
        x: Math.round(width / 2 + radius * Math.cos(angle) - w / 2),
        y: Math.round(height / 2 + radius * Math.sin(angle) * ratio - hgt / 2),
      };
      if (candidate.x < 0 || candidate.y < 0 || candidate.x + w > width || candidate.y + hgt > height) continue;
      if (placed.some((other) => overlaps(candidate, other))) continue;
      return candidate;
    }
    return null;
  };
  for (const term of terms) {
    const natural = cloudFontSize(term.weight);
    for (let fontSize = natural; fontSize >= MIN_FONT; fontSize -= 2) {
      const candidate = place(term, fontSize);
      if (candidate) { placed.push(candidate); break; }
    }
  }
  return placed;
}

// ---- card -----------------------------------------------------------------

const C = {
  bg: '#101114',
  line: '#2a2d34',
  text: '#f7f7f7',
  dim: '#9ca0aa',
  quiet: '#5f646e',
};

const SOURCE_COLORS: Record<string, string> = {
  statsfm: '#1ed760',
  backloggd: '#f2c14e',
  youtube: '#ff5a4f',
  simkl: '#7bb8ff',
  kitsu: '#f779a1',
  goodreads: '#d6b98c',
  events: '#c39bff',
  dayflow: '#b5adff',
  health: '#5fd4c4',
};

export function sourceColor(source: string): string {
  return SOURCE_COLORS[source] ?? '#e2e5ea';
}

const WIDTH = 520;
const PAD = 22;
const CLOUD_WIDTH = WIDTH - PAD * 2;
const CLOUD_HEIGHT = 300;

export interface WordCloudCardOptions {
  days?: number;
  ownerName?: string;
}

export function wordCloudNode(terms: CloudTerm[], options: WordCloudCardOptions = {}): Record<string, unknown> {
  const days = options.days ?? 28;
  const placed = layoutCloud(terms, CLOUD_WIDTH, CLOUD_HEIGHT);
  const sources = [...new Set(placed.map((term) => term.source))];
  const words = placed.map((term) => h('div', {
    style: {
      color: sourceColor(term.source), display: 'flex', fontFamily: textFont(term.label, 'Inter'),
      fontSize: term.fontSize, fontWeight: 700, left: term.x, lineHeight: 1, position: 'absolute',
      top: term.y, whiteSpace: 'nowrap',
    },
  }, term.label));
  const cloud = placed.length
    ? h('div', { style: { display: 'flex', height: CLOUD_HEIGHT, position: 'relative', width: CLOUD_WIDTH } }, ...words)
    : h('div', {
      style: {
        alignItems: 'center', border: `1px dashed ${C.line}`, borderRadius: 6, color: C.quiet, display: 'flex',
        fontSize: 12, height: 120, justifyContent: 'center', width: CLOUD_WIDTH,
      },
    }, `Nothing recorded in the last ${days} days yet.`);
  const legend = h('div', { style: { display: 'flex', flexWrap: 'wrap', marginTop: 18 } }, ...sources.map((source) =>
    h('div', { style: { alignItems: 'center', display: 'flex', marginRight: 14 } },
      h('div', { style: { backgroundColor: sourceColor(source), borderRadius: 3, display: 'flex', height: 8, marginRight: 5, width: 8 } }),
      h('span', { style: { color: C.dim, fontSize: 10 } }, sourceLabel(source)))));
  const subtitle = placed.length
    ? `${placed.length} things across ${sources.length} ${sources.length === 1 ? 'platform' : 'platforms'}`
    : 'Waiting for activity';
  return h('div', {
    style: {
      backgroundColor: C.bg, border: `1px solid ${C.line}`, borderRadius: 8, color: C.text, display: 'flex',
      flexDirection: 'column', fontFamily: 'Inter', height: '100%', padding: `20px ${PAD}px`, width: '100%',
    },
  },
  h('div', { style: { alignItems: 'center', display: 'flex', marginBottom: 18 } },
    h('img', { src: logo('infovore'), width: 32, height: 32, style: { marginRight: 9 } }),
    h('span', { style: { fontSize: 18, fontWeight: 700 } }, 'Word cloud'),
    h('span', { style: { color: C.dim, fontSize: 11, marginLeft: 'auto' } }, `last ${days} days`)),
  h('span', { style: { color: C.dim, fontSize: 11, marginBottom: 4, textTransform: 'uppercase' } }, options.ownerName ? `What ${options.ownerName} has been into` : 'What I have been into'),
  h('span', { style: { color: C.text, fontSize: 22, fontWeight: 700, marginBottom: 16 } }, subtitle),
  cloud,
  legend,
  h('span', { style: { color: C.quiet, fontSize: 9, marginTop: 8 } }, 'Sized by attention time: measured where the platform records it, estimated per play otherwise. Dayflow shows topic keywords, Health shows workout types.'));
}

export async function buildWordCloudCard(terms: CloudTerm[], options: WordCloudCardOptions = {}): Promise<string> {
  return renderCard(wordCloudNode(terms, options), WIDTH, CLOUD_HEIGHT + 190);
}
