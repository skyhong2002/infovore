import assert from 'node:assert/strict';
import test from 'node:test';
import { deflateSync, inflateSync } from 'node:zlib';
import { app, repository } from '../src/index.js';
import { Repository } from '../src/data/database.js';
import { syncFog, type FogDropboxConfig } from '../src/fog/dropbox.js';
import { encodeTile, exploredKm2, FOG_COLOR, parseTile, renderFogRgba, tileOfFilename, type FogTile } from '../src/fog/tiles.js';

const TOKEN = 'test-token-with-at-least-32-characters';
const auth = { Authorization: `Bearer ${TOKEN}` };

// Global fog pixels around Taipei 101 (121.5654°E, 25.0330°N); the world is 2^22 pixels wide.
const WORLD = 2 ** 22;
const gx = Math.floor(((121.5654 + 180) / 360) * WORLD);
const gy = Math.floor(((1 - Math.asinh(Math.tan((25.033 * Math.PI) / 180)) / Math.PI) / 2) * WORLD);
const tileX = Math.floor(gx / 8192);
const tileY = Math.floor(gy / 8192);

test('tile files decode with their checksums, and corrupt ones are refused', () => {
  // fog-machine's own example: id 123456 → x 64, y 241.
  assert.deepEqual(tileOfFilename('abcdlhwjskzz'), { id: 123456, x: 64, y: 241 });
  assert.equal(tileOfFilename('.DS_Store'), null);

  const { name, data } = encodeTile(tileX, tileY, [[gx, gy], [gx + 1, gy], [gx, gy + 70]]);
  const tile = parseTile(name, data);
  assert.equal(tile.x, tileX);
  assert.equal(tile.blocks.length, 2, 'the third pixel falls in the next block row');
  assert.equal(tile.blocks.reduce((n, b) => n + b.explored, 0), 3);
  const km2 = exploredKm2([tile]);
  // A fog pixel is about 9.55 m at the equator, times cos(25°) ≈ 8.66 m here.
  assert.ok(km2 > 3 * 8.5 ** 2 / 1e6 && km2 < 3 * 8.8 ** 2 / 1e6, String(km2));

  const raw = inflateSync(data);
  raw[32768] ^= 0xff; // flip a bitmap byte without updating the checksum
  assert.throws(() => parseTile(name, deflateSync(raw)), /checksum/);
});

test('the fog overlay is clear exactly where the explored pixel lies', () => {
  const { name, data } = encodeTile(tileX, tileY, [[gx, gy]]);
  const tiles = new Map<string, FogTile>([[`${tileX},${tileY}`, parseTile(name, data)]]);
  for (const z of [10, 14, 17]) {
    const scale = WORLD / (256 * 2 ** z);
    const tx = Math.floor(gx / (256 * scale));
    const ty = Math.floor(gy / (256 * scale));
    const rgba = renderFogRgba(tiles, z, tx, ty);
    const px = Math.floor((gx - tx * 256 * scale) / scale);
    const py = Math.floor((gy - ty * 256 * scale) / scale);
    assert.equal(rgba[(py * 256 + px) * 4 + 3], 0, `z${z}: explored pixel is clear`);
    const clear = [...Array(256 * 256).keys()].filter((i) => rgba[i * 4 + 3] === 0).length;
    assert.equal(clear, scale >= 1 ? 1 : (1 / scale) ** 2, `z${z}: only that pixel`);
    assert.equal(rgba[3], px === 0 && py === 0 ? 0 : FOG_COLOR[3], `z${z}: elsewhere fogged`);
  }
});

function fakeDropbox(files: Map<string, { rev: string; data: Buffer }>) {
  const calls: string[] = [];
  const fetcher = (async (input: string | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push(new URL(url).pathname);
    if (url.endsWith('/oauth2/token')) {
      assert.equal(init?.headers && (init.headers as Record<string, string>).Authorization, `Basic ${Buffer.from('key:secret').toString('base64')}`);
      return new Response(JSON.stringify({ access_token: 'short-lived' }), { status: 200 });
    }
    assert.equal((init?.headers as Record<string, string>).Authorization, 'Bearer short-lived');
    if (url.endsWith('/files/list_folder')) {
      const entries = [...files].map(([name, file]) => ({ '.tag': 'file', name, rev: file.rev }));
      entries.push({ '.tag': 'folder', name: 'nested', rev: '' }, { '.tag': 'file', name: 'notes.txt', rev: 'n1' });
      return new Response(JSON.stringify({ entries, cursor: 'c', has_more: false }), { status: 200 });
    }
    if (url.endsWith('/files/download')) {
      const arg = JSON.parse((init?.headers as Record<string, string>)['Dropbox-API-Arg']) as { path: string };
      const entry = [...files.values()].find((file) => `rev:${file.rev}` === arg.path);
      return entry ? new Response(new Uint8Array(entry.data), { status: 200 }) : new Response('missing', { status: 409 });
    }
    return new Response('unexpected', { status: 500 });
  }) as typeof fetch;
  return { fetcher, calls };
}

test('a Dropbox sync downloads only changed tiles and forgets removed ones', async () => {
  const repo = new Repository(':memory:');
  const config: FogDropboxConfig = { appKey: 'key', appSecret: 'secret', refreshToken: 'refresh', path: '/Apps/Fog of World/Sync', intervalMinutes: 30 };
  const a = encodeTile(tileX, tileY, [[gx, gy]]);
  const b = encodeTile(tileX + 1, tileY, [[gx + 8192, gy]]);
  const files = new Map([[a.name, { rev: 'a1', data: a.data }], [b.name, { rev: 'b1', data: b.data }]]);
  const dropbox = fakeDropbox(files);

  assert.deepEqual(await syncFog(repo.fog, config, dropbox.fetcher), { downloaded: 2, removed: 0, tiles: 2 });
  assert.equal(repo.fog.status().tiles, 2);
  dropbox.calls.length = 0;
  assert.deepEqual(await syncFog(repo.fog, config, dropbox.fetcher), { downloaded: 0, removed: 0, tiles: 2 });
  assert.ok(!dropbox.calls.includes('/2/files/download'), 'unchanged revisions are not downloaded again');

  const a2 = encodeTile(tileX, tileY, [[gx, gy], [gx + 1, gy]]);
  files.set(a.name, { rev: 'a2', data: a2.data });
  files.delete(b.name);
  assert.deepEqual(await syncFog(repo.fog, config, dropbox.fetcher), { downloaded: 1, removed: 1, tiles: 1 });
  const status = repo.fog.status();
  assert.equal(status.tiles, 1);
  assert.equal(status.blocks, 1);
  assert.equal(status.lastError, null);

  const failing = (async () => new Response('{"error":"invalid_grant"}', { status: 400 })) as unknown as typeof fetch;
  await assert.rejects(syncFog(repo.fog, config, failing), /token refresh failed/);
  assert.match(repo.fog.status().lastError ?? '', /invalid_grant/);
  assert.equal(repo.fog.status().tiles, 1, 'a failed sync keeps what was mirrored');
  repo.close();
});

test('fog status and overlay tiles need the location token', async () => {
  const { name, data } = encodeTile(tileX, tileY, [[gx, gy]]);
  repository.fog.put(name, 'r1', data);
  assert.equal((await app.request('/api/location/fog/status')).status, 401);
  assert.equal((await app.request('/api/location/fog/12/3431/1753.png')).status, 401);
  const status = await (await app.request('/api/location/fog/status', { headers: auth })).json() as { tiles: number; configured: boolean };
  assert.equal(status.tiles, 1);
  assert.equal(status.configured, false);
  const png = await app.request('/api/location/fog/12/3431/1753.png', { headers: auth });
  assert.equal(png.status, 200);
  assert.equal(png.headers.get('content-type'), 'image/png');
  assert.deepEqual([...new Uint8Array(await png.arrayBuffer()).subarray(0, 4)], [0x89, 0x50, 0x4e, 0x47]);
  assert.equal((await app.request('/api/location/fog/12/9999/1.png', { headers: auth })).status, 400);
  assert.equal((await app.request('/api/location/fog/12/1/1.jpg', { headers: auth })).status, 400);
});
