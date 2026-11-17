#!/usr/bin/env node
// Builds assets/regions.json, the offline lookup that names the region a
// location point falls in (src/location/regions.ts), from GeoNames dumps
// (CC BY 4.0, https://www.geonames.org). Download cities1000.zip (unzipped),
// admin1CodesASCII.txt, admin2Codes.txt and countryInfo.txt from
// https://download.geonames.org/export/dump/ into one directory, then:
//
//   node scripts/build-regions.mjs <that directory>
//
// A point takes the region of the nearest populated place. Regions are first-
// level divisions (Seoul, Tokyo, California), except in Taiwan, where GeoNames'
// first level is the defunct province: there the county or city is used.
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const dir = process.argv[2];
if (!dir) throw new Error('usage: build-regions.mjs <geonames dump directory>');
const lines = (name) => readFileSync(join(dir, name), 'utf8').split('\n').filter((line) => line && !line.startsWith('#'));

const countries = new Map(lines('countryInfo.txt').map((line) => line.split('\t')).map((f) => [f[0], f[4]]));
const admin1 = new Map(lines('admin1CodesASCII.txt').map((line) => line.split('\t')).map((f) => [f[0], f[2] || f[1]]));
const admin2 = new Map(lines('admin2Codes.txt').map((line) => line.split('\t')).map((f) => [f[0], f[2] || f[1]]));
const BY_ADMIN2 = new Set(['TW']);

const regions = [];
const regionIndex = new Map();
const seen = new Set();
const points = [];
for (const line of lines('cities1000.txt')) {
  const f = line.split('\t');
  const [lat, lng, country, a1, a2] = [Number(f[4]), Number(f[5]), f[8], f[10], f[11]];
  const country_name = countries.get(country);
  if (!country_name || !Number.isFinite(lat) || !Number.isFinite(lng)) continue;
  const name = BY_ADMIN2.has(country) ? admin2.get(`${country}.${a1}.${a2}`) : admin1.get(`${country}.${a1}`);
  const key = `${name ?? ''}\u001f${country}`;
  let index = regionIndex.get(key);
  if (index === undefined) {
    index = regions.length;
    regions.push([name ?? '', country_name]);
    regionIndex.set(key, index);
  }
  // One place per region in each 0.1° cell is plenty for a nearest-place lookup.
  const cell = `${Math.round(lat * 10)},${Math.round(lng * 10)},${index}`;
  if (seen.has(cell)) continue;
  seen.add(cell);
  points.push(Math.round(lat * 100), Math.round(lng * 100), index);
}
const out = { source: 'GeoNames cities1000 (CC BY 4.0, geonames.org)', regions, points };
writeFileSync(new URL('../assets/regions.json', import.meta.url), JSON.stringify(out));
console.log(`${regions.length} regions, ${points.length / 3} places`);
