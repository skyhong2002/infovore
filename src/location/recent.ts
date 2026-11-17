import { distanceBetween } from './store.js';
import { inPrivacyZone, type PrivacyZone } from './zones.js';

// The recency highlights on the public Places map: recorded tracks (Timeline
// and the phone) from the last 7 days, 28 days and year before the public
// cutoff, each its own tile layer so the page can switch them. They stop at
// RECENT_MAX_ZOOM (≈ 1 km a pixel, scaled past that): coarse enough that
// tracks ending at a privacy zone do not outline it. Segments with an end in a
// zone, long gaps and long jumps (flights, lost signal) are left out.

export const RECENT_MAX_ZOOM = 7;
export const RECENT_BANDS = ['week', 'month', 'year'] as const;
export type RecentBand = typeof RECENT_BANDS[number];
export const BAND_DAYS: Record<RecentBand, number> = { week: 7, month: 28, year: 365 };
export const BAND_COLORS: Record<RecentBand, readonly [number, number, number]> = {
  week: [255, 196, 0],
  month: [255, 107, 53],
  year: [146, 112, 255],
};

const DAY_MS = 86_400_000;
const MAX_GAP_MS = 30 * 60_000;
const MAX_JUMP_M = 20_000;
const ACCURACY_LIMIT_M = 200;

export interface RecentLayers {
  /** Per band, segments as normalized Web Mercator x0, y0, x1, y1 (0…1). */
  bands: Record<RecentBand, Float64Array>;
}

const mercator = (lat: number, lng: number) => [
  (lng + 180) / 360,
  (1 - Math.asinh(Math.tan((Math.max(-85, Math.min(85, lat)) * Math.PI) / 180)) / Math.PI) / 2,
];

export function recentLayers(points: ReadonlyArray<{ time: number; lat: number; lng: number; accuracy: number | null }>,
  zones: readonly PrivacyZone[], until: number): RecentLayers {
  const lists: Record<RecentBand, number[]> = { week: [], month: [], year: [] };
  const band = (time: number): RecentBand | null => {
    const age = until - time;
    if (age < 0) return null;
    return age <= 7 * DAY_MS ? 'week' : age <= 28 * DAY_MS ? 'month' : age <= 365 * DAY_MS ? 'year' : null;
  };
  let previous: { time: number; lat: number; lng: number } | null = null;
  for (const point of points) {
    if (point.time < until - 365 * DAY_MS || point.time >= until) continue;
    if (point.accuracy !== null && point.accuracy > ACCURACY_LIMIT_M) continue;
    if (inPrivacyZone(zones, point.lat, point.lng)) { previous = null; continue; }
    const target = band(point.time);
    if (!target) continue;
    const [x1, y1] = mercator(point.lat, point.lng);
    if (previous && point.time - previous.time <= MAX_GAP_MS && distanceBetween(previous, point) <= MAX_JUMP_M) {
      const [x0, y0] = mercator(previous.lat, previous.lng);
      lists[target].push(x0, y0, x1, y1);
    } else {
      lists[target].push(x1, y1, x1, y1);
    }
    previous = point;
  }
  return { bands: { week: Float64Array.from(lists.week), month: Float64Array.from(lists.month), year: Float64Array.from(lists.year) } };
}

/** One 256 × 256 tile of a band: 2-pixel tracks in its colour with a soft halo; transparent elsewhere. */
export function renderRecentRgba(segments: Float64Array, color: readonly [number, number, number], z: number, tx: number, ty: number): Uint8Array {
  const size = 256;
  const world = size * 2 ** z;
  const alpha = new Uint8Array(size * size);
  const stamp = (x: number, y: number) => {
    for (let dy = 0; dy <= 1; dy++) {
      for (let dx = 0; dx <= 1; dx++) {
        const px = x + dx, py = y + dy;
        if (px >= 0 && py >= 0 && px < size && py < size) alpha[py * size + px] = 255;
      }
    }
  };
  for (let i = 0; i < segments.length; i += 4) {
    const ax = segments[i] * world - tx * size, ay = segments[i + 1] * world - ty * size;
    const bx = segments[i + 2] * world - tx * size, by = segments[i + 3] * world - ty * size;
    if (Math.max(ax, bx) < -2 || Math.min(ax, bx) > size + 2 || Math.max(ay, by) < -2 || Math.min(ay, by) > size + 2) continue;
    const steps = Math.max(1, Math.ceil(Math.hypot(bx - ax, by - ay)));
    for (let s = 0; s <= steps; s++) stamp(Math.floor(ax + ((bx - ax) * s) / steps - 0.5), Math.floor(ay + ((by - ay) * s) / steps - 0.5));
  }
  const rgba = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let a = alpha[y * size + x];
      if (!a) {
        for (let dy = -1; dy <= 1 && !a; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            const nx = x + dx, ny = y + dy;
            if (nx >= 0 && ny >= 0 && nx < size && ny < size && alpha[ny * size + nx] === 255) { a = 100; break; }
          }
        }
      }
      if (a) rgba.set([...color, a], (y * size + x) * 4);
    }
  }
  return rgba;
}
