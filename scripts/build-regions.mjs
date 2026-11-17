#!/usr/bin/env node
// Builds assets/regions.json, the offline lookup that names the region a
// location point falls in (src/location/regions.ts), from GeoNames dumps
// (CC BY 4.0, https://www.geonames.org). Download cities1000.zip and
// alternateNamesV2.zip (both unzipped), admin1CodesASCII.txt, admin2Codes.txt
// and countryInfo.txt from https://download.geonames.org/export/dump/ into one
// directory, then:
//
//   node scripts/build-regions.mjs <that directory>
//
// A point takes the region of the nearest populated place. Regions are first-
// level divisions (Seoul, Tokyo, California), except in Taiwan, where GeoNames'
// first level is the defunct province: there the county or city is used.
// Each region also carries its name in the country's first local language
// that has one (臺南市, 서울특별시, 東京都, Wien), and the ISO country code.
import { createReadStream, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline';

const dir = process.argv[2];
if (!dir) throw new Error('usage: build-regions.mjs <geonames dump directory>');
const lines = (name) => readFileSync(join(dir, name), 'utf8').split('\n').filter((line) => line && !line.startsWith('#'));

const countryRows = lines('countryInfo.txt').map((line) => line.split('\t'));
const countries = new Map(countryRows.map((f) => [f[0], f[4]]));
// Local languages, in the country's order, without English (the name shown first).
const languages = new Map(countryRows.map((f) => [f[0], (f[15] ?? '').split(',').filter((l) => l && !l.startsWith('en'))]));
const admin = (file) => new Map(lines(file).map((line) => line.split('\t')).map((f) => [f[0], { name: f[2] || f[1], id: f[3] }]));
const admin1 = admin('admin1CodesASCII.txt');
const admin2 = admin('admin2Codes.txt');
const BY_ADMIN2 = new Set(['TW']);

const regions = [];
const regionIds = [];
const regionIndex = new Map();
const seen = new Set();
const points = [];
for (const line of lines('cities1000.txt')) {
  const f = line.split('\t');
  const [lat, lng, country, a1, a2] = [Number(f[4]), Number(f[5]), f[8], f[10], f[11]];
  const countryName = countries.get(country);
  if (!countryName || !Number.isFinite(lat) || !Number.isFinite(lng)) continue;
  const division = BY_ADMIN2.has(country) ? admin2.get(`${country}.${a1}.${a2}`) : admin1.get(`${country}.${a1}`);
  const key = `${division?.name ?? ''}\u001f${country}`;
  let index = regionIndex.get(key);
  if (index === undefined) {
    index = regions.length;
    regions.push([division?.name ?? '', countryName, '', country]);
    regionIds.push(division?.id ?? '');
    regionIndex.set(key, index);
  }
  // One place per region in each 0.1° cell is plenty for a nearest-place lookup.
  const cell = `${Math.round(lat * 10)},${Math.round(lng * 10)},${index}`;
  if (seen.has(cell)) continue;
  seen.add(cell);
  points.push(Math.round(lat * 100), Math.round(lng * 100), index);
}

// Local names: per region, the first of the country's languages with a name
// (a full code such as zh-TW before its base zh; Taiwan also takes zh-Hant),
// preferring short names (Wien over Bundesland Wien), then preferred ones,
// never historic or colloquial.
const wanted = new Map(regionIds.map((id, index) => [id, index]).filter(([id]) => id));
const candidates = new Map(); // region index → [{ lang, name, score }]
const input = createInterface({ input: createReadStream(join(dir, 'alternateNamesV2.txt')) });
for await (const line of input) {
  const f = line.split('\t');
  const index = wanted.get(f[1]);
  if (index === undefined || !f[2] || f[2].length > 8 || f[7] === '1' || f[6] === '1') continue;
  const list = candidates.get(index) ?? [];
  list.push({ lang: f[2], name: f[3], score: (f[5] === '1' ? 2 : 0) + (f[4] === '1' ? 1 : 0) });
  candidates.set(index, list);
}
let named = 0;
for (const [index, list] of candidates) {
  const [, , , country] = regions[index];
  const order = languages.get(country)?.flatMap((lang) => {
    const base = lang.split('-')[0];
    return country === 'TW' && base === 'zh' ? [lang, 'zh-Hant', base] : lang === base ? [lang] : [lang, base];
  }) ?? [];
  for (const lang of [...new Set(order)]) {
    const match = list.filter((c) => c.lang === lang).sort((a, b) => b.score - a.score)[0];
    if (!match) continue;
    // Île-de-France beside Ile-de-France says nothing new.
    const plain = (text) => text.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
    if (plain(match.name) !== plain(regions[index][0])) {
      regions[index][2] = match.name;
      named++;
    }
    break;
  }
}

const out = { source: 'GeoNames cities1000 and alternate names (CC BY 4.0, geonames.org)', regions, points };
writeFileSync(new URL('../assets/regions.json', import.meta.url), JSON.stringify(out));
console.log(`${regions.length} regions (${named} with a local name), ${points.length / 3} places`);
