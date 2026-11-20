import assert from 'node:assert/strict';
import test from 'node:test';

// Zones are read from the environment when config loads, so set them before importing the app.
// Zone A: a "home" in Hsinchu; zone B elsewhere so a list of several parses.
process.env.LOCATION_PRIVACY_ZONES = '24.787,120.997,1500; 25.1,121.9,800';
const { app, repository } = await import('../src/index.js');
const { Repository } = await import('../src/data/database.js');
const { encodeTile } = await import('../src/fog/tiles.js');
const { EXPLORED_COLOR, renderExploredRgba, parseTile } = await import('../src/fog/tiles.js');
const { afterFogSync, lastSeenRegion, placesSnapshot, publicCutoff } = await import('../src/location/public.js');
const { flagOf, regionOf } = await import('../src/location/regions.js');
const { inPrivacyZone, parsePlacesConfig, parsePrivacyZones } = await import('../src/location/zones.js');
const { placesDetails } = await import('../src/output/places.js');

const WORLD = 2 ** 22;
const fogPixel = (lat: number, lng: number) => [
  Math.floor(((lng + 180) / 360) * WORLD),
  Math.floor(((1 - Math.asinh(Math.tan((lat * Math.PI) / 180)) / Math.PI) / 2) * WORLD),
] as [number, number];

test('privacy zones parse strictly and contain what is inside them', () => {
  const zones = parsePrivacyZones('24.787,120.997,1500;25.0,121.5,2000');
  assert.equal(zones.length, 2);
  assert.ok(inPrivacyZone(zones, 24.79, 121.0), '≈ 450 m away');
  assert.ok(!inPrivacyZone(zones, 24.81, 120.997), '≈ 2.5 km away');
  assert.throws(() => parsePrivacyZones('24.7,120.9'), /LOCATION_PRIVACY_ZONES/);
  assert.throws(() => parsePrivacyZones('24.7,120.9,50'), /LOCATION_PRIVACY_ZONES/, 'too small to hide anything');
  assert.equal(parsePlacesConfig({}), null, 'no zone, no public projection');
  assert.deepEqual(parsePlacesConfig({ LOCATION_PRIVACY_ZONES: '24.7,120.9,1000' })?.delayHours, 72);
});

test('regions are named offline at the county or first-level scale', () => {
  assert.deepEqual(regionOf(25.034, 121.561), { region: 'Taipei City', country: 'Taiwan', local: '臺北市', code: 'TW' });
  assert.deepEqual(regionOf(23.0, 120.21), { region: 'Tainan', country: 'Taiwan', local: '臺南市', code: 'TW' });
  assert.deepEqual(regionOf(37.556, 126.922), { region: 'Seoul', country: 'South Korea', local: '서울특별시', code: 'KR' });
  assert.deepEqual(regionOf(48.86, 2.35), { region: 'Ile-de-France', country: 'France', local: '', code: 'FR' }, 'no accent-only twin');
  assert.equal(flagOf('TW'), '🇹🇼');
  assert.equal(regionOf(29.5, 125.0), null, 'open sea');
});

function seedLocation(repo: InstanceType<typeof Repository>, now: Date) {
  const day = 86_400_000;
  const at = (daysAgo: number, minutes = 0) => new Date(+now - daysAgo * day + minutes * 60_000).toISOString();
  repo.location.ingest({
    deviceId: 'phone', source: 'live', visits: [], activities: [],
    points: [
      // Inside the Hsinchu zone: never counts towards regions.
      { time: at(10), lat: 24.7875, lng: 120.9975, accuracy: 10 },
      { time: at(10, 30), lat: 24.788, lng: 120.998, accuracy: 10 },
      // Through Miaoli by train for 15 minutes, five days ago: not a visit.
      { time: at(5, -60), lat: 24.56, lng: 120.82, accuracy: 10 },
      { time: at(5, -45), lat: 24.45, lng: 120.75, accuracy: 10 },
      // Then two hours in Tainan, 1 km in all.
      { time: at(5), lat: 22.99, lng: 120.21, accuracy: 10 },
      { time: at(5, 60), lat: 22.999, lng: 120.21, accuracy: 10 },
      { time: at(5, 120), lat: 22.999, lng: 120.21, accuracy: 10 },
      // Seoul 23 h ago: within both delays, so not yet public anywhere.
      { time: at(1, 60), lat: 37.556, lng: 126.922, accuracy: 10 },
    ],
  });
  repo.location.ingest({
    deviceId: 'phone', source: 'timeline', points: [{ time: at(20), lat: 25.034, lng: 121.561, accuracy: 30 }],
    // A Timeline stay of 45 minutes counts on its own; a 10-minute one does not.
    visits: [{ start: at(20, 40), end: at(20, 85), lat: 25.034, lng: 121.561 }, { start: at(19), end: at(19, 10), lat: 24.95, lng: 121.2 }],
    activities: [{ start: at(20), end: at(20, 40), distanceMeters: 12_000, mode: 'IN_SUBWAY' }],
  });
}

test('the public projection is delayed, leaves zones out and carries no coordinates', () => {
  const repo = new Repository(':memory:');
  const now = new Date('2026-11-17T04:00:00Z');
  seedLocation(repo, now);
  const places = parsePlacesConfig({ LOCATION_PRIVACY_ZONES: '24.787,120.997,1500' })!;
  const snapshot = placesSnapshot(repo.location, repo.fog, places, 'Owner', now);
  const extra = snapshot.extra;
  assert.deepEqual(extra.regions.map((r) => r.region), ['Tainan', 'Taipei City'],
    'Seoul is too recent; Hsinchu is a zone; Miaoli was passed through; Taoyuan only a short stop');
  assert.equal(extra.regions[0].days, 1);
  assert.equal(snapshot.stats.countries, 1);
  assert.ok(Date.parse(extra.asOf) <= +now - 72 * 3_600_000, 'at least the delay behind');
  assert.equal(extra.asOf.slice(11), '16:00:00.000Z', 'a whole Taipei day boundary');
  const tainan = extra.travel.days.find((d) => d.km >= 170 && d.km <= 200);
  assert.ok(tainan, 'the Tainan day: ≈ 185 km by train, then 1 km there');
  assert.equal(extra.travel.modes[0].label, 'Metro');
  assert.equal(extra.travel.modes[0].km, 12);
  const json = JSON.stringify(snapshot);
  for (const coordinate of ['22.99', '120.21', '24.78', '120.99', '37.55', '25.03', '121.56']) {
    assert.ok(!json.includes(coordinate), `no coordinate ${coordinate}`);
  }
  // Now: the latest fix at least a day old, outside zones.
  assert.deepEqual(lastSeenRegion(repo.location, places, now), { region: 'Tainan', country: 'Taiwan', local: '臺南市', code: 'TW', day: '2026-11-12' });
  assert.equal(lastSeenRegion(repo.location, places, new Date(+now + 10 * 86_400_000)), null, 'nothing in the 7 days before');
  repo.close();
});

test('the public fog shows each tile as it was before the delay and clears privacy zones', () => {
  const repo = new Repository(':memory:');
  const places = parsePlacesConfig({ LOCATION_PRIVACY_ZONES: '24.787,120.997,1500' })!;
  const [hx, hy] = fogPixel(23.0, 120.21);
  const tx = Math.floor(hx / 8192);
  const ty = Math.floor(hy / 8192);
  const old = encodeTile(tx, ty, [[hx, hy]]);
  const newer = encodeTile(tx, ty, [[hx, hy], [hx + 300, hy]]);
  repo.fog.put(old.name, 'r1', old.data, '2026-11-01T00:00:00.000Z');
  repo.fog.put(newer.name, 'r2', newer.data, '2026-11-16T00:00:00.000Z');
  const now = new Date('2026-11-17T04:00:00Z');
  const cutoff = new Date(publicCutoff(places, now)).toISOString();
  const state = repo.fog.publicState(cutoff);
  const blocks = [...state.tiles.values()][0].blocks;
  assert.equal(blocks.reduce((n, b) => n + b.explored, 0), 1, 'the revision synced after the cutoff is not public yet');
  assert.equal(repo.fog.status().blocks, 2, 'the private view has the latest');

  afterFogSync(repo.fog, places, now);
  assert.equal(repo.fog.areaHistory().length, 1);
  repo.fog.put(newer.name, 'r3', newer.data, '2026-11-16T12:00:00.000Z');
  afterFogSync(repo.fog, places, new Date('2026-11-25T04:00:00Z'));
  const left = repo.fog.publicState('2026-11-30T00:00:00.000Z');
  assert.equal([...left.tiles.values()][0].blocks.reduce((n, b) => n + b.explored, 0), 2);

  // In a zone the real pixels give way to noise as dense as the ring around it:
  // a lone track there vanishes, and a well-walked zone shows no hole.
  const [zx, zy] = fogPixel(24.787, 120.997);
  const z = 9;
  const scale = WORLD / (256 * 2 ** z); // fog pixels per map pixel
  const mx = Math.floor(zx / (WORLD / 2 ** z));
  const my = Math.floor(zy / (WORLD / 2 ** z));
  const explored = (rgba: Uint8Array) => [...Array(256 * 256).keys()].filter((i) => rgba[i * 4 + 3] === 255);
  const layer = (pixels: Array<[number, number]>) => {
    const tile = encodeTile(Math.floor(zx / 8192), Math.floor(zy / 8192), pixels);
    return renderExploredRgba(new Map([[`${Math.floor(zx / 8192)},${Math.floor(zy / 8192)}`, parseTile(tile.name, tile.data)]]), z, mx, my, places.zones);
  };
  const lone = layer([[zx, zy]]);
  assert.equal(explored(lone).length, 0, 'the track inside the zone is gone');
  assert.equal(lone[3], 0, 'unexplored ground is transparent');
  // Every other map pixel within ~4 km explored: the zone fills at about half.
  const grid: Array<[number, number]> = [];
  for (let dy = -16; dy <= 16; dy++) for (let dx = -16; dx <= 16; dx++) if ((dx + dy) % 2 === 0) grid.push([zx + dx * scale, zy + dy * scale]);
  const dense = layer(grid.filter(([x, y]) => Math.floor(x / 8192) === Math.floor(zx / 8192) && Math.floor(y / 8192) === Math.floor(zy / 8192)));
  const r = 1500 / (40_075_016.686 * Math.cos((24.787 * Math.PI) / 180) / (256 * 2 ** z));
  const cx = zx / scale - mx * 256;
  const cy = zy / scale - my * 256;
  const inZone = explored(dense).filter((i) => ((i % 256) + 0.5 - cx) ** 2 + (Math.floor(i / 256) + 0.5 - cy) ** 2 <= r * r).length;
  // ≈ 90 pixels in the zone, about half of them explored.
  assert.ok(inZone > 25 && inZone < 70, String(inZone));
  assert.deepEqual([...dense.subarray(explored(dense)[0] * 4, explored(dense)[0] * 4 + 3)], [...EXPLORED_COLOR]);
  repo.close();
});

test('the Places page, JSON and fog tiles are public but capped', async () => {
  const now = new Date();
  seedLocation(repository, now);
  const kyoto = patch(35.0, 135.76, 60);
  repository.fog.put(kyoto.name, 'k1', kyoto.data, '2026-01-01T00:00:00.000Z');
  const page = await app.request('/platforms/places');
  assert.equal(page.status, 200);
  const body = await page.text();
  assert.match(body, /Tainan/);
  assert.doesNotMatch(body, /Hsinchu/, 'the zone stays out');
  assert.doesNotMatch(body, /Seoul/, 'too recent');
  const json = await (await app.request('/api/places.json')).json() as { regions: Array<{ region: string }> };
  assert.deepEqual(json.regions.map((r) => r.region), ['Tainan', 'Taipei City', 'Kyoto'], 'Kyoto from Fog of World');
  assert.equal((await app.request('/api/places/fog/9/428/223.png')).status, 200);
  assert.equal((await app.request('/api/places/fog/10/856/446.png')).status, 400, 'no closer than zoom 9');
  assert.match(await (await app.request('/platforms')).text(), /href="\/platforms\/places"/);
  // One interactive map: its script and Natural Earth basemap are served from the site itself.
  const src = /<script src="(\/places\.js\?v=[0-9a-f]+)" defer><\/script>/.exec(body)?.[1];
  assert.ok(src, 'the map script is linked');
  const script = await app.request(src!);
  assert.equal(script.headers.get('cache-control'), 'public, max-age=31536000, immutable');
  assert.match(await script.text(), /places-atlas/);
  const land = await (await app.request(/data-land="([^"]+)"/.exec(body)![1])).json() as { land: number[][]; borders: number[][] };
  assert.ok(land.land.length > 1000 && land.borders.length > 100);
  const layers = JSON.parse(/data-layers="([^"]+)"/.exec(body)![1].replace(/&quot;/g, '"')) as Array<{ key: string; url: string; max: number }>;
  assert.deepEqual(layers.map((l) => `${l.key}:${l.max}`), ['fog:9', 'year:7', 'month:7', 'week:7']);
  assert.equal((await app.request(layers[3].url.replace('{z}', '7').replace('{x}', '106').replace('{y}', '55'))).status, 200);
  assert.equal((await app.request('/api/places/recent/week/8/213/110.png')).status, 400, 'recent tracks stop at zoom 7');
  assert.equal((await app.request('/api/places/recent/decade/7/106/55.png')).status, 400);
  assert.match(body, /class="recent-week"><strong><i class="places-dot"/, 'a region stayed in this week glows');
  assert.match(await (await app.request('/now')).text(), /Last seen around<\/a> 🇹🇼 Tainan 臺南市, Taiwan/);
  assert.match(body, /Tainan <span lang="zh-Hant-TW" class="places-local">臺南市<\/span>/);
  assert.match(await (await app.request('/sitemap.xml')).text(), /\/platforms\/places/);
});

// A square of explored fog pixels around a place, about 0.25 km² at 60 × 60.
function patch(lat: number, lng: number, side: number) {
  const [gx, gy] = fogPixel(lat, lng);
  const pixels: Array<[number, number]> = [];
  for (let dy = 0; dy < side; dy++) for (let dx = 0; dx < side; dx++) pixels.push([gx + dx, gy + dy]);
  return encodeTile(Math.floor(gx / 8192), Math.floor(gy / 8192), pixels);
}

test('France overview frames metropolitan France while retaining the separate explored bounds', () => {
  const repo = new Repository(':memory:');
  try {
    const paris = patch(48.86, 2.35, 120);
    repo.fog.put(paris.name, 'paris', paris.data, '2026-11-01T00:00:00.000Z');
    const places = parsePlacesConfig({ LOCATION_PRIVACY_ZONES: '24.787,120.997,1500' })!;
    const { extra } = placesSnapshot(repo.location, repo.fog, places, 'France test', new Date('2026-11-17T04:00:00Z'));
    const markup = placesDetails(extra);
    const encoded = /data-views="([^"]+)"/.exec(markup)?.[1];
    assert.ok(encoded);
    const [{ label, bounds, overview }] = JSON.parse(encoded.replaceAll('&quot;', '"'));
    assert.equal(label, 'France');
    assert.ok(bounds[2] - bounds[0] < 2 / 360, 'explored bounds are still local to Paris');
    const contains = (lat: number, lng: number) => {
      const [pointX, pointY] = fogPixel(lat, lng).map((value) => value / WORLD);
      return pointX >= overview[0] && pointX <= overview[2] && pointY >= overview[1] && pointY <= overview[3];
    };
    for (const [lat, lng] of [[48.39, -4.49], [50.63, 3.06], [43.7, 7.26], [41.92, 8.74], [48.86, 2.35]]) {
      assert.ok(contains(lat, lng), `${lat}, ${lng} should be in the overview`);
    }
    assert.ok(!contains(4.94, -52.33), 'overseas territories do not shrink metropolitan France into a dot');
  } finally {
    repo.close();
  }
});

test('Fog of World adds undated regions, minus thin and ignored ones', () => {
  const repo = new Repository(':memory:');
  const now = new Date('2026-11-17T04:00:00Z');
  seedLocation(repo, now);
  for (const [name, tile] of [['kyoto', patch(35.0, 135.76, 60)], ['changhua', patch(24.08, 120.54, 60)], ['osaka', patch(34.69, 135.5, 10)]] as const) {
    repo.fog.put(tile.name, name, tile.data, '2026-11-01T00:00:00.000Z');
  }
  const places = parsePlacesConfig({
    LOCATION_PRIVACY_ZONES: '24.787,120.997,1500', PLACES_FOG_IGNORE_REGIONS: 'Changhua, Nowhere',
  })!;
  const extra = placesSnapshot(repo.location, repo.fog, places, 'Owner', now).extra;
  const named = extra.regions.map((r) => `${r.region}/${r.days}/${r.exploredKm2 === null ? '-' : 'fog'}`);
  assert.deepEqual(named, ['Tainan/1/-', 'Taipei City/1/-', 'Kyoto/0/fog'],
    'Changhua is ignored for Fog of World alone; the Osaka patch is too thin');
  const kyoto = extra.regions.find((r) => r.region === 'Kyoto')!;
  assert.ok(kyoto.exploredKm2! > 0.2 && kyoto.exploredKm2! < 0.35, String(kyoto.exploredKm2));
  assert.equal(kyoto.local, '京都府');
  assert.deepEqual(extra.countries.map((c) => `${c.code}:${c.regions}:${c.days}`), ['TW:2:2', 'JP:1:0']);
  assert.deepEqual(extra.maps.map((m) => m.code).sort(), ['JP', 'TW'], 'a map per country with enough fog');
  repo.close();
});

test('recency layers band recorded tracks by age and leave zones and jumps out', async () => {
  const { recentLayers, renderRecentRgba, BAND_COLORS } = await import('../src/location/recent.js');
  const zones = parsePrivacyZones('24.787,120.997,1500');
  const until = Date.parse('2026-11-14T00:00:00Z');
  const at = (days: number, minutes = 0) => until - days * 86_400_000 + minutes * 60_000;
  const layers = recentLayers([
    { time: at(2), lat: 23.0, lng: 120.2, accuracy: 10 }, { time: at(2, 10), lat: 23.01, lng: 120.2, accuracy: 10 },
    { time: at(10), lat: 25.03, lng: 121.56, accuracy: 10 },
    { time: at(10, 5), lat: 24.787, lng: 120.997, accuracy: 10 }, // in the zone
    { time: at(10, 9), lat: 25.04, lng: 121.56, accuracy: 10 }, // after the zone: a dot, not a segment through it
    { time: at(100), lat: 35.0, lng: 135.7, accuracy: 10 }, { time: at(100, 20), lat: 37.5, lng: 127.0, accuracy: 10 }, // a flight
    { time: at(400), lat: 23.0, lng: 120.2, accuracy: 10 }, // older than a year
    { time: at(-1), lat: 23.0, lng: 120.2, accuracy: 10 }, // after the cutoff
  ], zones, until);
  assert.equal(layers.bands.week.length, 8, 'a dot and one segment');
  assert.equal(layers.bands.month.length, 8, 'two dots, nothing into the zone');
  assert.equal(layers.bands.year.length, 8, 'the flight is two dots');
  const rgba = renderRecentRgba(layers.bands.week, BAND_COLORS.week, 7, 106, 55);
  const lit = [...Array(256 * 256).keys()].filter((i) => rgba[i * 4 + 3] === 255);
  assert.ok(lit.length >= 4, String(lit.length));
  assert.deepEqual([...rgba.subarray(lit[0] * 4, lit[0] * 4 + 3)], [...BAND_COLORS.week]);
});
