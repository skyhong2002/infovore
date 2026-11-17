#!/usr/bin/env node
// Builds assets/land.json, the basemap of the public Places map (land and
// country borders, drawn by src/output/places-map.ts), from Natural Earth 1:50m
// (public domain) via the world-atlas package (ISC). Download land-50m.json and
// countries-50m.json from https://cdn.jsdelivr.net/npm/world-atlas@2.0.2/ into
// one directory, then:
//
//   node scripts/build-land.mjs <that directory>
//
// Output: Web Mercator coordinates scaled to 0…2^20 across the world, each ring
// or line a flat array of [x, y] deltas: { land: number[][], borders: number[][] }.
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const dir = process.argv[2];
if (!dir) throw new Error('usage: build-land.mjs <world-atlas directory>');
const SCALE = 2 ** 20;
const MAX_LAT = 85.05112878;

function decoder(topology) {
  const { scale, translate } = topology.transform;
  const arcs = topology.arcs.map((arc) => {
    let x = 0, y = 0;
    return arc.map(([dx, dy]) => {
      x += dx; y += dy;
      const lng = x * scale[0] + translate[0];
      const lat = Math.max(-MAX_LAT, Math.min(MAX_LAT, y * scale[1] + translate[1]));
      return [
        Math.round(((lng + 180) / 360) * SCALE),
        Math.round(((1 - Math.asinh(Math.tan((lat * Math.PI) / 180)) / Math.PI) / 2) * SCALE),
      ];
    });
  });
  const arc = (index) => (index >= 0 ? arcs[index] : [...arcs[~index]].reverse());
  const ring = (indexes) => indexes.flatMap((index, i) => (i ? arc(index).slice(1) : arc(index)));
  return { arcs, ring };
}

function encode(points) {
  const out = [];
  let px = 0, py = 0;
  for (const [x, y] of points) {
    if (out.length && x === px && y === py) continue;
    out.push(x - px, y - py);
    px = x; py = y;
  }
  return out;
}

const landTopo = JSON.parse(readFileSync(join(dir, 'land-50m.json'), 'utf8'));
const land = decoder(landTopo);
const rings = [];
const collect = (geometry) => {
  if (geometry.type === 'GeometryCollection') geometry.geometries.forEach(collect);
  if (geometry.type === 'Polygon') geometry.arcs.forEach((r) => rings.push(encode(land.ring(r))));
  if (geometry.type === 'MultiPolygon') geometry.arcs.forEach((polygon) => polygon.forEach((r) => rings.push(encode(land.ring(r)))));
};
collect(landTopo.objects.land);

// Borders: arcs that two countries share (coastlines belong to one country only).
const countriesTopo = JSON.parse(readFileSync(join(dir, 'countries-50m.json'), 'utf8'));
const countries = decoder(countriesTopo);
const uses = new Map();
const count = (indexes) => indexes.forEach((index) => uses.set(index < 0 ? ~index : index, (uses.get(index < 0 ? ~index : index) ?? 0) + 1));
for (const geometry of countriesTopo.objects.countries.geometries) {
  if (geometry.type === 'Polygon') geometry.arcs.forEach(count);
  if (geometry.type === 'MultiPolygon') geometry.arcs.forEach((polygon) => polygon.forEach(count));
}
const borders = [...uses].filter(([, n]) => n > 1).map(([index]) => encode(countries.arcs[index]));

writeFileSync(new URL('../assets/land.json', import.meta.url), JSON.stringify({
  source: 'Natural Earth 1:50m (public domain) via world-atlas', scale: SCALE, land: rings, borders,
}));
console.log(`${rings.length} land rings, ${borders.length} border lines`);
