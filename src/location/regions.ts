import { readFileSync } from 'node:fs';

// Offline region names for public location summaries: a point takes the
// region of the nearest populated place in assets/regions.json (built from
// GeoNames by scripts/build-regions.mjs). No coordinates leave the server.

export interface Region { region: string; country: string }

interface RegionData { regions: Array<[string, string]>; points: number[] }

const CELL = 1; // degrees per lookup bucket
const MAX_DISTANCE_KM = 150; // farther than this from any town: at sea, no region

let index: { data: RegionData; buckets: Map<string, number[]> } | null = null;

function load() {
  if (index) return index;
  const data = JSON.parse(readFileSync(new URL('../../assets/regions.json', import.meta.url), 'utf8')) as RegionData;
  const buckets = new Map<string, number[]>();
  for (let i = 0; i < data.points.length; i += 3) {
    const key = `${Math.floor(data.points[i] / 100 / CELL)},${Math.floor(data.points[i + 1] / 100 / CELL)}`;
    const bucket = buckets.get(key);
    if (bucket) bucket.push(i);
    else buckets.set(key, [i]);
  }
  index = { data, buckets };
  return index;
}

export function regionOf(lat: number, lng: number): Region | null {
  const { data, buckets } = load();
  const cy = Math.floor(lat / CELL);
  const cx = Math.floor(lng / CELL);
  const cos = Math.cos((lat * Math.PI) / 180);
  let best = -1;
  let bestKm2 = Infinity;
  for (let ring = 0; ring <= 2; ring++) {
    for (let dy = -ring; dy <= ring; dy++) {
      for (let dx = -ring; dx <= ring; dx++) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== ring) continue;
        let x = cx + dx;
        if (x < -180) x += 360;
        if (x >= 180) x -= 360;
        for (const i of buckets.get(`${cy + dy},${x}`) ?? []) {
          let dLng = Math.abs(data.points[i + 1] / 100 - lng);
          if (dLng > 180) dLng = 360 - dLng;
          const km2 = ((data.points[i] / 100 - lat) * 111.2) ** 2 + (dLng * 111.2 * cos) ** 2;
          if (km2 < bestKm2) { bestKm2 = km2; best = i; }
        }
      }
    }
    // A closer place can only be in the next ring when this ring's best is farther than one cell.
    if (best >= 0 && Math.sqrt(bestKm2) <= ring * CELL * 111.2 * Math.max(cos, 0.2)) break;
  }
  if (best < 0 || Math.sqrt(bestKm2) > MAX_DISTANCE_KM) return null;
  const [region, country] = data.regions[data.points[best + 2]];
  return { region: region || country, country };
}
