import assert from 'node:assert/strict';
import test from 'node:test';

// Zones are read from the environment when config loads, so set them before importing the app.
// Zone A: a "home" in Hsinchu; zone B elsewhere so a list of several parses.
process.env.LOCATION_PRIVACY_ZONES = '24.787,120.997,1500; 25.1,121.9,800';
const { app, repository } = await import('../src/index.js');
const { Repository } = await import('../src/data/database.js');
const { encodeTile } = await import('../src/fog/tiles.js');
const { clearZonesRgba, FOG_COLOR, renderFogRgba, parseTile } = await import('../src/fog/tiles.js');
const { afterFogSync, lastSeenRegion, placesSnapshot, publicCutoff } = await import('../src/location/public.js');
const { regionOf } = await import('../src/location/regions.js');
const { inPrivacyZone, parsePlacesConfig, parsePrivacyZones } = await import('../src/location/zones.js');

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
  assert.deepEqual(regionOf(25.034, 121.561), { region: 'Taipei City', country: 'Taiwan' });
  assert.deepEqual(regionOf(23.0, 120.21), { region: 'Tainan', country: 'Taiwan' });
  assert.deepEqual(regionOf(37.556, 126.922), { region: 'Seoul', country: 'South Korea' });
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
      // Tainan five days ago, two fixes 1 km apart.
      { time: at(5), lat: 22.99, lng: 120.21, accuracy: 10 },
      { time: at(5, 20), lat: 22.999, lng: 120.21, accuracy: 10 },
      // Seoul 23 h ago: within both delays, so not yet public anywhere.
      { time: at(1, 60), lat: 37.556, lng: 126.922, accuracy: 10 },
    ],
  });
  repo.location.ingest({
    deviceId: 'phone', source: 'timeline', points: [{ time: at(20), lat: 25.034, lng: 121.561, accuracy: 30 }], visits: [],
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
  assert.deepEqual(extra.regions.map((r) => r.region), ['Tainan', 'Taipei City'], 'Seoul is too recent; Hsinchu is a zone');
  assert.equal(extra.regions[0].days, 1);
  assert.equal(snapshot.stats.countries, 1);
  assert.ok(Date.parse(extra.asOf) <= +now - 72 * 3_600_000, 'at least the delay behind');
  assert.equal(extra.asOf.slice(11), '16:00:00.000Z', 'a whole Taipei day boundary');
  const tainan = extra.travel.days.find((d) => d.km >= 0.9 && d.km <= 1.1);
  assert.ok(tainan, 'Tainan day ≈ 1 km');
  assert.equal(extra.travel.modes[0].label, 'Metro');
  assert.equal(extra.travel.modes[0].km, 12);
  const json = JSON.stringify(snapshot);
  for (const coordinate of ['22.99', '120.21', '24.78', '120.99', '37.55', '25.03', '121.56']) {
    assert.ok(!json.includes(coordinate), `no coordinate ${coordinate}`);
  }
  // Now: the latest fix at least a day old, outside zones.
  assert.deepEqual(lastSeenRegion(repo.location, places, now), { region: 'Tainan', country: 'Taiwan', day: '2026-11-12' });
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

  // A zone renders as explored ground, not as a hole or a trail.
  const [zx, zy] = fogPixel(24.787, 120.997);
  const home = encodeTile(Math.floor(zx / 8192), Math.floor(zy / 8192), [[zx, zy]]);
  const tiles = new Map([[`${Math.floor(zx / 8192)},${Math.floor(zy / 8192)}`, parseTile(home.name, home.data)]]);
  const z = 9;
  const mx = Math.floor(zx / (WORLD / 2 ** z));
  const my = Math.floor(zy / (WORLD / 2 ** z));
  const rgba = renderFogRgba(tiles, z, mx, my);
  const before = [...Array(256 * 256).keys()].filter((i) => rgba[i * 4 + 3] === 0).length;
  clearZonesRgba(rgba, z, mx, my, places.zones);
  const after = [...Array(256 * 256).keys()].filter((i) => rgba[i * 4 + 3] === 0).length;
  // 1500 m at ≈ 277 m a pixel: a disc of ≈ 90 pixels.
  assert.ok(before <= 1 && after > 60 && after < 120, `${before} → ${after}`);
  assert.equal(rgba[3], FOG_COLOR[3], 'away from the zone the fog stays');
  repo.close();
});

test('the Places page, JSON and fog tiles are public but capped', async () => {
  const now = new Date();
  seedLocation(repository, now);
  const page = await app.request('/platforms/places');
  assert.equal(page.status, 200);
  const body = await page.text();
  assert.match(body, /Tainan/);
  assert.doesNotMatch(body, /Hsinchu/, 'the zone stays out');
  assert.doesNotMatch(body, /Seoul/, 'too recent');
  const json = await (await app.request('/api/places.json')).json() as { regions: Array<{ region: string }> };
  assert.deepEqual(json.regions.map((r) => r.region), ['Tainan', 'Taipei City']);
  assert.equal((await app.request('/api/places/fog/9/428/223.png')).status, 200);
  assert.equal((await app.request('/api/places/fog/10/856/446.png')).status, 400, 'no closer than zoom 9');
  assert.match(await (await app.request('/platforms')).text(), /href="\/platforms\/places"/);
  assert.match(await (await app.request('/now')).text(), /Last seen around<\/a> Tainan, Taiwan/);
  assert.match(await (await app.request('/sitemap.xml')).text(), /\/platforms\/places/);
});
