import type { FogStore } from '../fog/store.js';
import { BLOCK_PIXELS, TILE_BLOCKS, WORLD_PIXELS } from '../fog/tiles.js';
import type { SourceSnapshot } from '../data/types.js';
import { TAIPEI_OFFSET_MS, taipeiDay } from '../data/time.js';
import { regionOf, type Region } from './regions.js';
import { distanceBetween, type LocationStore } from './store.js';
import { inPrivacyZone, type PlacesConfig } from './zones.js';

// The public Places projection: what the location history and Fog of World
// say at the scale of regions and kilometres, never where. Rules:
// - everything lags config.delayHours (the Now line config.nowDelayHours);
// - nothing is derived from a point inside a privacy zone, and the fog map
//   draws zones as plain explored ground (FogStore.publicPng);
// - regions are first-level divisions (counties and cities in Taiwan), and
//   count only where there was a stay, not a pass-through;
// - distances and trip modes are daily or all-time totals;
// - the fog map stops at zoom PUBLIC_MAX_ZOOM (≈ 300 m a pixel).
// No coordinate, place name, visit or time of day is published.

export const PUBLIC_MAX_ZOOM = 9;
const DAY_MS = 86_400_000;
// Fixes vaguer than this say nothing about the region.
const REGION_ACCURACY_LIMIT_M = 2_000;
const DISTANCE_ACCURACY_LIMIT_M = 100;

/**
 * A region and the evidence for it: stays on dated days (Timeline and the
 * phone), ground explored in Fog of World (undated), or an entry added by hand.
 */
export interface PlacesRegion {
  region: string;
  country: string;
  /** The name in the country's own language when it differs (臺南市); else ''. */
  local: string;
  code: string;
  days: number;
  firstDay: string | null;
  lastDay: string | null;
  exploredKm2: number | null;
  manual: boolean;
}
export interface PlacesMap { label: string; code: string; z: number; x: number; y: number; cols: number; rows: number; km2: number }
export interface PlacesExtra {
  asOf: string;
  delayHours: number;
  explored: { km2: number; tiles: number; last30DaysKm2: number | null };
  regions: PlacesRegion[];
  countries: Array<{ country: string; code: string; regions: number; days: number; exploredKm2: number }>;
  travel: {
    since: string | null;
    allTimeKm: number;
    last30Km: number;
    days: Array<{ day: string; km: number }>;
    modes: Array<{ mode: string; label: string; km: number; trips: number }>;
  };
  maps: PlacesMap[];
}
export type PlacesSnapshot = SourceSnapshot<PlacesExtra>;

const MODE_LABELS: Record<string, string> = {
  WALKING: 'Walking', RUNNING: 'Running', CYCLING: 'Cycling', MOTORCYCLING: 'Scooter', IN_PASSENGER_VEHICLE: 'Car',
  IN_VEHICLE: 'Car', IN_BUS: 'Bus', IN_SUBWAY: 'Metro', IN_TRAIN: 'Train', IN_TRAM: 'Tram', FLYING: 'Flight',
  IN_FERRY: 'Ferry', SAILING: 'Boat', SKIING: 'Skiing',
};

const dayOf = (ms: number) => new Date(ms + TAIPEI_OFFSET_MS).toISOString().slice(0, 10);
const dayStart = (day: string) => Date.parse(`${day}T00:00:00.000Z`) - TAIPEI_OFFSET_MS;
const km = (metres: number) => Math.round(metres / 100) / 10;

/** The moment public data is shown as of: whole Taipei days, [delayHours] behind. */
export function publicCutoff(places: PlacesConfig, now: Date): number {
  return dayStart(dayOf(+now - places.delayHours * 3_600_000));
}

function regionCache() {
  const cache = new Map<string, Region | null>();
  return (lat: number, lng: number) => {
    const key = `${lat.toFixed(2)},${lng.toFixed(2)}`;
    if (!cache.has(key)) cache.set(key, regionOf(lat, lng));
    return cache.get(key)!;
  };
}

type Point = ReturnType<LocationStore['pointsBefore']>[number];

type Visit = ReturnType<LocationStore['visitsBefore']>[number];

// A region counts as visited on a day only after a real stay there, so a
// train or a drive through it does not: at least STAY_MS between consecutive
// fixes in that region (gaps up to MAX_GAP_MS), or a Timeline visit of at
// least VISIT_MS.
const STAY_MS = 60 * 60_000;
const MAX_GAP_MS = 3 * 60 * 60_000;
const VISIT_MS = 30 * 60_000;

function regionsVisited(points: readonly Point[], visits: readonly Visit[], places: PlacesConfig) {
  const lookup = regionCache();
  const regionAt = (lat: number, lng: number) => (inPrivacyZone(places.zones, lat, lng) ? null : lookup(lat, lng));
  const keyOf = (region: Region) => `${region.region}\u001f${region.country}`;
  const dwell = new Map<string, number>(); // key \u001e day → ms
  const regionByKey = new Map<string, Region>();
  const stayed = new Map<string, { region: Region; days: Set<string> }>();
  const stay = (region: Region, day: string) => {
    const key = keyOf(region);
    const entry = stayed.get(key) ?? { region, days: new Set<string>() };
    entry.days.add(day);
    stayed.set(key, entry);
  };
  let first: number | null = null;
  let previous: { time: number; region: Region | null } | null = null;
  for (const point of points) {
    first ??= point.time;
    if (point.accuracy !== null && point.accuracy > REGION_ACCURACY_LIMIT_M) continue;
    const region = regionAt(point.lat, point.lng);
    if (previous?.region && region && keyOf(previous.region) === keyOf(region) && point.time - previous.time <= MAX_GAP_MS) {
      const slot = `${keyOf(region)}\u001e${dayOf(previous.time)}`;
      dwell.set(slot, (dwell.get(slot) ?? 0) + point.time - previous.time);
      regionByKey.set(keyOf(region), region);
    }
    previous = { time: point.time, region };
  }
  for (const [slot, ms] of dwell) {
    if (ms < STAY_MS) continue;
    const [key, day] = slot.split('\u001e');
    stay(regionByKey.get(key)!, day);
  }
  for (const visit of visits) {
    if (visit.end - visit.start < VISIT_MS) continue;
    const region = regionAt(visit.lat, visit.lng);
    if (region) stay(region, dayOf(visit.start));
  }
  return { stayed, since: first === null ? null : dayOf(first) };
}

// Fog of World regions below this explored area are too thin to call visited.
const FOG_REGION_MIN_KM2 = 0.2;

/** Explored km² per region in the public fog, leaving out blocks inside a zone. */
function fogRegions(fog: FogStore, cutoff: string, places: PlacesConfig) {
  const lookup = regionCache();
  const regions = new Map<string, { region: Region; km2: number }>();
  for (const tile of fog.publicState(cutoff).tiles.values()) {
    for (const block of tile.blocks) {
      const gx = (tile.x * TILE_BLOCKS + block.x + 0.5) * BLOCK_PIXELS;
      const gy = (tile.y * TILE_BLOCKS + block.y + 0.5) * BLOCK_PIXELS;
      const lng = (gx / WORLD_PIXELS) * 360 - 180;
      const lat = (Math.atan(Math.sinh(Math.PI * (1 - (2 * gy) / WORLD_PIXELS))) * 180) / Math.PI;
      if (inPrivacyZone(places.zones, lat, lng)) continue;
      const region = lookup(lat, lng);
      if (!region) continue;
      const side = (40_075.016686 * Math.cos((lat * Math.PI) / 180)) / WORLD_PIXELS;
      const key = `${region.region}\u001f${region.country}`;
      const entry = regions.get(key) ?? { region, km2: 0 };
      entry.km2 += block.explored * side * side;
      regions.set(key, entry);
    }
  }
  return regions;
}

function mergeRegions(stayed: ReturnType<typeof regionsVisited>['stayed'], fogged: ReturnType<typeof fogRegions>, places: PlacesConfig) {
  const ignored = new Set(places.fogIgnoreRegions.map((name) => name.toLowerCase()));
  const merged = new Map<string, PlacesRegion>();
  const blank = (region: Region): PlacesRegion =>
    ({ ...region, days: 0, firstDay: null, lastDay: null, exploredKm2: null, manual: false });
  for (const [key, { region, days }] of stayed) {
    const sorted = [...days].sort();
    merged.set(key, { ...blank(region), days: sorted.length, firstDay: sorted[0], lastDay: sorted.at(-1)! });
  }
  for (const [key, { region, km2 }] of fogged) {
    const known = merged.get(key);
    if (known) known.exploredKm2 = Math.round(km2 * 100) / 100;
    else if (km2 >= FOG_REGION_MIN_KM2 && !ignored.has(region.region.toLowerCase())) {
      merged.set(key, { ...blank(region), exploredKm2: Math.round(km2 * 100) / 100 });
    }
  }
  for (const place of places.extraPlaces) {
    const region = regionOf(place.lat, place.lng);
    if (!region) continue;
    const key = `${region.region}\u001f${region.country}`;
    const known = merged.get(key);
    if (known) known.manual = true;
    else merged.set(key, { ...blank(region), manual: true });
  }
  const regions = [...merged.values()].sort((a, b) =>
    (b.lastDay ?? '').localeCompare(a.lastDay ?? '') || (b.exploredKm2 ?? 0) - (a.exploredKm2 ?? 0) || a.region.localeCompare(b.region));
  const byCountry = new Map<string, { code: string; regions: number; days: Set<string>; km2: number }>();
  for (const region of regions) {
    const entry = byCountry.get(region.country) ?? { code: region.code, regions: 0, days: new Set<string>(), km2: 0 };
    entry.regions++;
    entry.km2 += region.exploredKm2 ?? 0;
    for (const day of stayed.get(`${region.region}\u001f${region.country}`)?.days ?? []) entry.days.add(day);
    byCountry.set(region.country, entry);
  }
  const countries = [...byCountry].map(([country, entry]) => ({
    country, code: entry.code, regions: entry.regions, days: entry.days.size, exploredKm2: Math.round(entry.km2 * 100) / 100,
  })).sort((a, b) => b.days - a.days || b.exploredKm2 - a.exploredKm2);
  return { regions, countries };
}

// A day's distance, like LocationStore.day(): the phone's own fixes when it
// recorded the day, else the Timeline trips' distances, else the Timeline track.
function travel(location: LocationStore, points: readonly Point[], until: number, since: string | null): PlacesExtra['travel'] {
  const byDay = new Map<string, { live: Array<{ lat: number; lng: number }>; all: Array<{ lat: number; lng: number }>; trips: number }>();
  const day = (key: string) => {
    let entry = byDay.get(key);
    if (!entry) byDay.set(key, entry = { live: [], all: [], trips: 0 });
    return entry;
  };
  for (const point of points) {
    if (point.accuracy !== null && point.accuracy > DISTANCE_ACCURACY_LIMIT_M) continue;
    const entry = day(dayOf(point.time));
    entry.all.push(point);
    if (point.source === 'live') entry.live.push(point);
  }
  const modes = new Map<string, { km: number; trips: number }>();
  for (const trip of location.activitiesBefore(until)) {
    const metres = trip.distanceMeters ?? 0;
    day(dayOf(trip.start)).trips += metres;
    const mode = trip.mode ?? 'UNKNOWN';
    const entry = modes.get(mode) ?? { km: 0, trips: 0 };
    entry.km += metres / 1000;
    entry.trips++;
    modes.set(mode, entry);
  }
  const length = (points: Array<{ lat: number; lng: number }>) => {
    let total = 0;
    for (let i = 1; i < points.length; i++) total += distanceBetween(points[i - 1], points[i]);
    return total;
  };
  const totals = new Map<string, number>();
  for (const [key, entry] of byDay) {
    totals.set(key, entry.live.length > 1 ? length(entry.live) : entry.trips > 0 ? entry.trips : length(entry.all));
  }
  const lastDay = dayOf(until - 1);
  const days = Array.from({ length: 30 }, (_, i) => {
    const key = dayOf(dayStart(lastDay) - (29 - i) * DAY_MS);
    return { day: key, km: km(totals.get(key) ?? 0) };
  });
  return {
    since,
    allTimeKm: Math.round([...totals.values()].reduce((sum, metres) => sum + metres, 0) / 1000),
    last30Km: Math.round(days.reduce((sum, entry) => sum + entry.km, 0)),
    days,
    modes: [...modes].filter(([mode]) => mode !== 'UNKNOWN')
      .map(([mode, entry]) => ({ mode, label: MODE_LABELS[mode] ?? mode.toLowerCase().replace(/^in_/, '').replace(/_/g, ' '), km: Math.round(entry.km), trips: entry.trips }))
      .sort((a, b) => b.km - a.km),
  };
}

// One overview map per country with explored ground (up to ten), framed on its explored
// blocks at the closest zoom (at most PUBLIC_MAX_ZOOM) that fits 4 × 3 map tiles.
function maps(fog: FogStore, cutoff: string): PlacesMap[] {
  const state = fog.publicState(cutoff);
  const lookup = regionCache();
  const countries = new Map<string, { code: string; minX: number; minY: number; maxX: number; maxY: number; km2: number }>();
  for (const tile of state.tiles.values()) {
    let sx = 0, sy = 0, n = 0;
    const box = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
    for (const block of tile.blocks) {
      const gx = (tile.x * TILE_BLOCKS + block.x) * BLOCK_PIXELS;
      const gy = (tile.y * TILE_BLOCKS + block.y) * BLOCK_PIXELS;
      sx += gx * block.explored; sy += gy * block.explored; n += block.explored;
      box.minX = Math.min(box.minX, gx); box.minY = Math.min(box.minY, gy);
      box.maxX = Math.max(box.maxX, gx + BLOCK_PIXELS); box.maxY = Math.max(box.maxY, gy + BLOCK_PIXELS);
    }
    if (!n) continue;
    const lng = (sx / n / WORLD_PIXELS) * 360 - 180;
    const lat = (Math.atan(Math.sinh(Math.PI * (1 - (2 * sy) / n / WORLD_PIXELS))) * 180) / Math.PI;
    const found = lookup(lat, lng);
    if (!found) continue;
    const country = found.country;
    const pixelKm = (40_075.016686 * Math.cos((lat * Math.PI) / 180)) / WORLD_PIXELS;
    const entry = countries.get(country) ?? { code: found.code, minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity, km2: 0 };
    entry.minX = Math.min(entry.minX, box.minX); entry.minY = Math.min(entry.minY, box.minY);
    entry.maxX = Math.max(entry.maxX, box.maxX); entry.maxY = Math.max(entry.maxY, box.maxY);
    entry.km2 += n * pixelKm * pixelKm;
    countries.set(country, entry);
  }
  return [...countries].filter(([, box]) => box.km2 >= FOG_REGION_MIN_KM2).sort((a, b) => b[1].km2 - a[1].km2).slice(0, 10).map(([label, box]) => {
    for (let z = PUBLIC_MAX_ZOOM; ; z--) {
      const perTile = WORLD_PIXELS / 2 ** z;
      const x = Math.floor(box.minX / perTile);
      const y = Math.floor(box.minY / perTile);
      const cols = Math.floor((box.maxX - 1) / perTile) - x + 1;
      const rows = Math.floor((box.maxY - 1) / perTile) - y + 1;
      if ((cols <= 4 && rows <= 3) || z <= 2) return { label, code: box.code, z, x, y, cols: Math.min(cols, 4), rows: Math.min(rows, 3), km2: Math.round(box.km2 * 10) / 10 };
    }
  });
}

let memo: { key: string; snapshot: PlacesSnapshot } | null = null;

export function placesSnapshot(location: LocationStore, fog: FogStore, places: PlacesConfig, ownerName: string, now = new Date()): PlacesSnapshot {
  const until = publicCutoff(places, now);
  const cutoff = new Date(until).toISOString();
  const fogState = fog.publicState(cutoff);
  const key = `${until}|${fogState.version}|${location.status().lastReceivedAt}|${ownerName}`;
  if (memo?.key === key) return memo.snapshot;
  const points = location.pointsBefore(until);
  const visited = regionsVisited(points, location.visitsBefore(until), places);
  const { regions, countries } = mergeRegions(visited.stayed, fogRegions(fog, cutoff, places), places);
  const moved = travel(location, points, until, visited.since);
  const history = fog.areaHistory();
  const monthAgo = dayOf(until - 30 * DAY_MS);
  const baseline = [...history].reverse().find((entry) => entry.day <= monthAgo) ?? null;
  const extra: PlacesExtra = {
    asOf: cutoff,
    delayHours: places.delayHours,
    explored: {
      km2: fogState.exploredKm2,
      tiles: fogState.tiles.size,
      last30DaysKm2: baseline ? Math.round((fogState.exploredKm2 - baseline.km2) * 100) / 100 : null,
    },
    regions,
    countries,
    travel: moved,
    maps: maps(fog, cutoff),
  };
  const snapshot: PlacesSnapshot = {
    source: 'places',
    profile: { id: 'places', name: ownerName, avatar: '', url: '' },
    stats: {
      exploredKm2: Math.round(fogState.exploredKm2),
      regions: regions.length,
      countries: countries.length,
      kmLast30Days: moved.last30Km,
    },
    entries: [],
    extra,
  };
  memo = { key, snapshot };
  return snapshot;
}

/** "Last seen around" for Now: the region of the latest fix outside every zone, [nowDelayHours] old or older. */
export function lastSeenRegion(location: LocationStore, places: PlacesConfig, now = new Date()): (Region & { day: string }) | null {
  const until = +now - places.nowDelayHours * 3_600_000;
  for (const point of location.pointsBackwards(until - 7 * DAY_MS, until)) {
    if (point.accuracy !== null && point.accuracy > REGION_ACCURACY_LIMIT_M) continue;
    if (inPrivacyZone(places.zones, point.lat, point.lng)) continue;
    const region = regionOf(point.lat, point.lng);
    if (region) return { ...region, day: taipeiDay(new Date(point.time)) };
  }
  return null;
}

/** After each Fog of World sync: forget revisions past the delay, and note today's public area. */
export function afterFogSync(fog: FogStore, places: PlacesConfig | null, now = new Date()): void {
  if (!places) {
    fog.pruneHistory(now.toISOString());
    return;
  }
  const until = publicCutoff(places, now);
  const cutoff = new Date(until).toISOString();
  fog.pruneHistory(cutoff);
  // Keyed by the last whole day the public area covers, like the cutoff itself.
  fog.recordArea(dayOf(until - 1), fog.publicState(cutoff).exploredKm2);
}
