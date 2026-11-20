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
// or line a flat array of [x, y] deltas, plus normalized country overview bounds.
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

function unwrap(points) {
  let offset = 0;
  return points.map(([pointX, pointY], index) => {
    if (index) offset -= Math.round((pointX - points[index - 1][0]) / SCALE) * SCALE;
    return [pointX + offset, pointY];
  });
}

function clipX(points, edge, side) {
  const clipped = [];
  let [prevX, prevY] = points.at(-1);
  for (const [pointX, pointY] of points) {
    const inside = (pointX - edge) * side >= 0;
    if (inside !== ((prevX - edge) * side >= 0)) {
      clipped.push([edge, Math.round(prevY + (pointY - prevY) * (edge - prevX) / (pointX - prevX))]);
    }
    if (inside) clipped.push([pointX, pointY]);
    prevX = pointX; prevY = pointY;
  }
  return clipped;
}

function splitRing(points) {
  const ring = unwrap(points);
  const [startX, startY] = ring[0];
  const [endX] = ring.at(-1);
  if (endX !== startX) {
    const pole = startY < SCALE / 2 ? 0 : SCALE;
    ring.push([endX, pole], [startX, pole]);
  }
  const [minX, , maxX] = componentBounds(ring);
  const left = Math.floor(minX / SCALE), right = Math.ceil(maxX / SCALE);
  const pieces = [];
  for (let copy = left; copy < right; copy++) {
    const west = copy * SCALE;
    const east = clipX(ring, west, 1);
    if (!east.length) continue;
    const clipped = clipX(east, west + SCALE, -1).map(([pointX, pointY]) => [pointX - west, pointY]);
    if (area(clipped) > 0) pieces.push(encode(clipped));
  }
  return pieces;
}

function area(points) {
  return Math.abs(points.reduce((sum, [pointX, pointY], index) => {
    const [prevX, prevY] = points[(index + points.length - 1) % points.length];
    return sum + prevX * pointY - pointX * prevY;
  }, 0));
}

function componentBounds(points) {
  return points.reduce(([minX, minY, maxX, maxY], [pointX, pointY]) =>
    [Math.min(minX, pointX), Math.min(minY, pointY), Math.max(maxX, pointX), Math.max(maxY, pointY)],
  [Infinity, Infinity, -Infinity, -Infinity]);
}

function overviewBounds(polygons, decodeRing) {
  const components = polygons.map(([outer]) => {
    const points = unwrap(decodeRing(outer));
    return { area: area(points), bounds: componentBounds(points) };
  }).sort((first, second) => second.area - first.area);
  const [main, ...rest] = components;
  const nearby = [main.bounds];
  const gap = SCALE / 180;
  for (const [minX, minY, maxX, maxY] of nearby) {
    for (const [index, island] of rest.entries()) {
      if (!island) continue;
      const [west, north, east, south] = island.bounds;
      const distance = [-SCALE, 0, SCALE].map((offset) => Math.hypot(
        Math.max(0, west + offset - maxX, minX - east - offset), Math.max(0, north - maxY, minY - south),
      ));
      const closest = Math.min(...distance);
      if (closest > gap) continue;
      const offset = (distance.indexOf(closest) - 1) * SCALE;
      nearby.push([west + offset, north, east + offset, south]);
      rest[index] = null;
    }
  }
  return componentBounds(nearby.flatMap(([west, north, east, south]) => [[west, north], [east, south]]))
    .map((value) => value / SCALE);
}

const landTopo = JSON.parse(readFileSync(join(dir, 'land-50m.json'), 'utf8'));
const land = decoder(landTopo);
const rings = [];
const collect = (geometry) => {
  if (geometry.type === 'GeometryCollection') geometry.geometries.forEach(collect);
  if (geometry.type === 'Polygon') geometry.arcs.forEach((ring) => rings.push(...splitRing(land.ring(ring))));
  if (geometry.type === 'MultiPolygon') geometry.arcs.forEach((polygon) => polygon.forEach((ring) => rings.push(...splitRing(land.ring(ring)))));
};
collect(landTopo.objects.land);

// Borders: arcs that two countries share (coastlines belong to one country only).
const countriesTopo = JSON.parse(readFileSync(join(dir, 'countries-50m.json'), 'utf8'));
const countries = decoder(countriesTopo);
const uses = new Map();
const countryBounds = {};
const count = (indexes) => indexes.forEach((index) => uses.set(index < 0 ? ~index : index, (uses.get(index < 0 ? ~index : index) ?? 0) + 1));
for (const geometry of countriesTopo.objects.countries.geometries) {
  const polygons = geometry.type === 'Polygon' ? [geometry.arcs] : geometry.arcs;
  if (!polygons?.length) continue;
  polygons.forEach((polygon) => polygon.forEach(count));
  countryBounds[geometry.properties.name] = overviewBounds(polygons, countries.ring);
}
const borders = [...uses].filter(([, n]) => n > 1).map(([index]) => encode(countries.arcs[index]));

writeFileSync(new URL('../assets/land.json', import.meta.url), JSON.stringify({
  source: 'Natural Earth 1:50m (public domain) via world-atlas', scale: SCALE, land: rings, borders, countryBounds,
}));
console.log(`${rings.length} land rings, ${borders.length} border lines`);
