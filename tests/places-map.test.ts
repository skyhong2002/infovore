import assert from 'node:assert/strict';
import test from 'node:test';
import { runInNewContext } from 'node:vm';
import { countryMapBounds, landJson, placesMapScript } from '../src/output/places-map.js';

function atlas(reducedMotion = false, countryOverview = false) {
  const frames = new Map<number, (now: number) => void>();
  const requests: string[] = [];
  const drawn: string[] = [];
  const canvasHandlers = new Map<string, (event: Record<string, unknown>) => void>();
  const viewHandlers = new Map<number, () => void>();
  let frameId = 0;
  let time = 0;

  class TileImage {
    onload?: () => void;
    url = '';
    set src(url: string) {
      this.url = url;
      requests.push(url);
      this.onload?.();
    }
  }

  const canvas = {
    getContext: () => ({ setTransform() {}, fillRect() {}, drawImage: (image: TileImage) => drawn.push(image.url) }),
    getBoundingClientRect: () => ({ width: 830, height: 558, left: 0, top: 0 }),
    addEventListener: canvasHandlers.set.bind(canvasHandlers),
  };
  const views = [
    { bounds: [0.828125, 0.421875, 0.84375, 0.4375] },
    { bounds: [0.505859375, 0.341796875, 0.51171875, 0.345703125], overview: countryOverview ? countryMapBounds.get('France') : undefined },
  ];
  const layers = [
    { key: 'fog', max: 9, url: '/fog/{z}/{x}/{y}.png' },
    ...['year', 'month', 'week'].map((key) => ({ key, max: 7, url: '/recent/' + key + '/{z}/{x}/{y}.png' })),
  ];
  const root = {
    querySelector: () => canvas,
    querySelectorAll: () => [],
    dataset: { views: JSON.stringify(views), layers: JSON.stringify(layers), land: '/land.json' },
  };
  const buttons = views.map((_, index) => ({
    dataset: { view: String(index) },
    setAttribute() {},
    addEventListener: (_event: string, handler: () => void) => viewHandlers.set(index, handler),
  }));

  runInNewContext(placesMapScript, {
    document: { querySelector: () => root, querySelectorAll: (selector: string) => selector.includes('.atlas-views') ? buttons : [] },
    window: { devicePixelRatio: 1 },
    Image: TileImage,
    fetch: () => Promise.reject(new Error('No basemap in this fixture')),
    matchMedia: (query: string) => ({ matches: reducedMotion && query.includes('reduced-motion'), addEventListener() {} }),
    getComputedStyle: () => ({ getPropertyValue: () => '' }),
    ResizeObserver: class { observe() {} },
    MutationObserver: class { observe() {} },
    performance: { now: () => time },
    requestAnimationFrame: (callback: (now: number) => void) => { frames.set(++frameId, callback); return frameId; },
    cancelAnimationFrame: (id: number) => frames.delete(id),
  });

  const tick = (now: number) => {
    time = now;
    for (const [id, callback] of [...frames]) if (frames.delete(id)) callback(now);
  };
  tick(0);
  tick(16);
  requests.length = 0;
  drawn.length = 0;
  return { tick, requests, drawn, fly: (index: number) => viewHandlers.get(index)!(), canvasHandlers };
}

test('a country flight requests only destination tiles, before the first animation frame', () => {
  const instant = atlas(true);
  instant.fly(1);
  instant.tick(32);
  assert.ok(instant.requests.includes('/fog/9/259/175.png'));
  assert.ok(instant.requests.includes('/recent/year/7/64/43.png'));
  assert.equal(instant.requests.length, 32);

  const animated = atlas();
  animated.fly(1);
  assert.deepEqual(animated.requests, instant.requests);
  for (let now = 32; now < 750; now += 16) animated.tick(now);
  assert.deepEqual(animated.requests, instant.requests, 'no requests for tiles along the flight');
  assert.ok(animated.drawn.includes('/fog/9/259/175.png'));
});

test('manual zoom stops a country flight and resumes requests for the current view', () => {
  const map = atlas();
  map.fly(1);
  for (let now = 32; now <= 320; now += 16) map.tick(now);
  map.requests.length = 0;
  map.canvasHandlers.get('wheel')!({ preventDefault() {}, deltaY: -500, deltaMode: 0, clientX: 415, clientY: 279 });
  map.tick(336);
  assert.ok(map.requests.length > 0);
  const count = map.requests.length;
  for (let now = 352; now < 750; now += 16) map.tick(now);
  assert.equal(map.requests.length, count);
});

test('France preloads the country overview rather than zooming in on the explored tile bounds', () => {
  const map = atlas(false, true);
  map.fly(1);
  assert.ok(map.requests.includes('/fog/5/16/11.png'), 'the country view still requests the tile containing Paris');
  assert.ok(!map.requests.some((url) => url.startsWith('/fog/9/')));
  const expected = [...map.requests];
  for (let now = 32; now < 750; now += 16) map.tick(now);
  assert.deepEqual(map.requests, expected);
  assert.ok(map.drawn.includes('/fog/5/16/11.png'));
});

test('land rings do not draw across the world at the antimeridian', () => {
  const { scale, land } = JSON.parse(landJson.toString()) as { scale: number; land: number[][] };
  const rings = land.map((ring) => {
    let pointX = 0, pointY = 0;
    const points: Array<[number, number]> = [];
    for (let index = 0; index < ring.length; index += 2) {
      pointX += ring[index]; pointY += ring[index + 1];
      points.push([pointX, pointY]);
    }
    for (let index = 0; index < points.length; index++) {
      const [px, py] = points[index];
      const [nx, ny] = points[(index + 1) % points.length];
      assert.ok(Math.abs(px - nx) <= scale / 2 || (py === scale && ny === scale), 'only the South Pole closure can span the whole world');
    }
    return points;
  });
  const isLand = (lon: number, lat: number) => {
    const pointX = (lon + 180) / 360 * scale;
    const pointY = (1 - Math.asinh(Math.tan(lat * Math.PI / 180)) / Math.PI) / 2 * scale;
    let inside = false;
    for (const points of rings) {
      for (let index = 0; index < points.length; index++) {
        const [px, py] = points[index];
        const [nx, ny] = points[(index + 1) % points.length];
        if ((py > pointY) !== (ny > pointY) && pointX < px + (nx - px) * (pointY - py) / (ny - py)) inside = !inside;
      }
    }
    return inside;
  };
  assert.equal(isLand(-40, 68), true, 'Greenland interior');
  assert.equal(isLand(110, 66), true, 'Siberian interior');
  assert.equal(isLand(-170, 66), false, 'open water west of Alaska');
  assert.equal(isLand(20, -83), true, 'Antarctic interior');
});
