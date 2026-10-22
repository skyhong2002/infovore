import assert from 'node:assert/strict';
import { once } from 'node:events';
import { request } from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';
import { gunzipSync } from 'node:zlib';
import test, { type TestContext } from 'node:test';
import { startGateway } from '../src/gateway.js';

async function setup(t: TestContext, options: Partial<Parameters<typeof startGateway>[0]> = {}) {
  const gateway = startGateway({ port: 0, hostname: '127.0.0.1', homeRefreshMs: 100, homeCooldownMs: 100,
    requestDeadlineMs: 30, homeMaxBytes: 1024, ...options, backendFile: new URL('./fixtures/home-peer.mjs', import.meta.url) });
  t.after(() => gateway.close());
  await once(gateway.server, 'listening');
  await once(gateway.child, 'message');
  const origin = `http://127.0.0.1:${(gateway.server.address() as { port: number }).port}`;
  async function command(payload: object = {}) {
    const incoming = new Promise<{ count: number; pending: number }>((resolve) => {
      const receive = (message: any) => {
        if (message.type !== 'stats') return;
        gateway.child.off('message', receive); resolve(message);
      };
      gateway.child.on('message', receive);
    });
    gateway.child.send(payload);
    return incoming;
  }
  const get = (method = 'GET') => fetch(origin, { method, signal: AbortSignal.timeout(1000) });
  async function seed() {
    await command({ mode: 'good', release: true });
    for (let i = 0; i < 100; i++) {
      const response = await get();
      if (response.status === 200) return response;
      await delay(10);
    }
    throw new Error('no genuine homepage captured');
  }
  return { gateway, origin, command, get, seed };
}

function raw(origin: string, headers: Record<string, string>, method = 'GET') {
  return new Promise<{ status: number; headers: import('node:http').IncomingHttpHeaders; body: Buffer }>((resolve, reject) => {
    const req = request(origin, { headers, method, agent: false }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode!, headers: res.headers, body: Buffer.concat(chunks) }));
      res.on('error', reject);
    });
    req.on('error', reject); req.end();
  });
}

test('cold callers and cancellation cannot duplicate a deadlined regeneration; its late real result is captured', { timeout: 30_000 }, async (t) => {
  const { origin, command, get } = await setup(t, { homeRefreshMs: 60_000, homeCooldownMs: 60_000, maxInFlight: 1 });
  for (let i = 0; i < 5; i++) {
    const response = await get(i % 2 ? 'HEAD' : 'GET');
    assert.equal(response.status, 503);
    if (i % 2) assert.equal(await response.text(), '');
    else assert.equal((await response.json() as any).error, 'home_snapshot_unavailable');
  }
  const cancelled = request(origin, { agent: false });
  cancelled.on('error', () => {}); cancelled.end(); cancelled.destroy();
  await delay(12_200);
  const state = await command();
  assert.equal(state.count, 1);
  assert.equal(state.pending, 1);
  const beforeRelease = Date.now();
  await command({ mode: 'good', release: true });
  let result: Response | undefined;
  for (let i = 0; i < 100; i++) {
    result = await get();
    if (result.status === 200) break;
    await delay(10);
  }
  assert.equal(result!.status, 200);
  assert.ok(Date.parse(result!.headers.get('x-home-generated-at')!) <= beforeRelease - 200, 'late completion must not reset generation time');
  assert.match(await result!.text(), /Genuine last synced/);
  assert.equal((await command()).count, 1);
});

test('failed, private, varying and oversized refreshes keep only the old real page, then expire fail-closed', async (t) => {
  const { command, get, seed } = await setup(t, { homeMaxAgeMs: 2500 });
  const initial = await seed();
  const generatedAt = initial.headers.get('x-home-generated-at');
  const html = await initial.text();
  for (const mode of ['empty', 'reset', 'error', 'oversize', 'private', 'cookie', 'vary', 'encoded']) {
    const previous = await command({ mode });
    for (let i = 0; i < 100; i++) {
      if ((await command()).count > previous.count) break;
      await delay(10);
    }
    await delay(20);
    const response = await get();
    assert.equal(response.status, 200, mode);
    assert.equal(response.headers.get('x-home-generated-at'), generatedAt, mode);
    assert.equal(response.headers.get('x-home-stale'), 'true', mode);
    assert.equal(response.headers.get('x-home-error'), mode === 'oversize' ? 'snapshot_too_large' : mode === 'reset' ? 'backend_unavailable' : 'invalid_home_response', mode);
    assert.equal(await response.text(), html, mode);
  }
  await delay(2600);
  assert.equal((await get()).status, 503, 'max stale retention is finite even while refreshes keep failing');
});

test('a late page older than retention is never served as newly fresh', async (t) => {
  const { command, get } = await setup(t, { homeRefreshMs: 60_000, homeCooldownMs: 60_000, homeMaxAgeMs: 100 });
  await delay(200);
  await command({ mode: 'good', release: true });
  await delay(30);
  assert.equal((await get()).status, 503);
  assert.equal((await command()).count, 1);
});

test('canonical cache never captures authorization, cookies, query or binary route responses', async (t) => {
  const { origin, seed, get, command } = await setup(t, { homeRefreshMs: 60_000, requestDeadlineMs: 3000 });
  const seeded = await seed();
  const html = await seeded.text();
  await command({ health: true });
  const variants: Record<string, string>[] = [{ authorization: 'Bearer synthetic' }, { cookie: 'synthetic=value' }];
  for (const headers of variants) {
    const response = await raw(origin, headers);
    assert.equal(response.status, 200);
    assert.deepEqual(response.body, Buffer.from([0, 255, 17, 128]));
  }
  assert.deepEqual((await raw(origin + '/?variant=private', {})).body, Buffer.from([0, 255, 17, 128]));
  assert.deepEqual((await raw(origin + '/binary', {})).body, Buffer.from([0, 255, 17, 128]));
  assert.equal(await get().then((r) => r.text()), html);
  assert.equal((await command()).count, 1);
});

test('settled failures have a cooldown even under a cache-miss flood', async (t) => {
  const { command, get } = await setup(t, { homeRefreshMs: 50, homeCooldownMs: 500 });
  await command({ mode: 'error', release: true });
  await delay(30);
  const initial = await command();
  assert.equal(initial.count, 1);
  for (let i = 0; i < 20; i++) assert.equal((await get()).status, 503);
  assert.equal((await command()).count, 1);
  await delay(600);
  assert.equal((await command()).count, 2, 'clock retries once after cooldown, not once per waiting visitor');
});

test('a periodic refresh captures changed real HTML without any homepage visitor', async (t) => {
  const { command, get, seed } = await setup(t);
  const first = await seed();
  const original = await first.text();
  const before = await command({ mode: 'good' });
  await delay(350);
  assert.ok((await command()).count > before.count);
  const next = await get();
  assert.equal(next.status, 200);
  assert.notEqual(await next.text(), original);
  assert.notEqual(next.headers.get('x-home-generated-at'), first.headers.get('x-home-generated-at'));
});

test('cached homepage serves valid gzip and matching HEAD without per-visitor regeneration', async (t) => {
  const { origin, command, seed } = await setup(t, { homeRefreshMs: 60_000 });
  const seeded = await seed();
  const html = await seeded.text();
  const before = await command();
  const zipped = await raw(origin, { 'accept-encoding': 'gzip' });
  assert.equal(zipped.status, 200);
  assert.equal(zipped.headers['content-encoding'], 'gzip');
  assert.equal(gunzipSync(zipped.body).toString(), html);
  assert.equal(Number(zipped.headers['content-length']), zipped.body.length);
  assert.equal(zipped.headers.vary, 'Accept-Encoding');
  const head = await raw(origin, { 'accept-encoding': 'gzip' }, 'HEAD');
  assert.equal(head.headers['content-encoding'], 'gzip');
  assert.equal(head.headers['content-length'], zipped.headers['content-length']);
  assert.equal(head.body.length, 0);
  for (let i = 0; i < 10; i++) assert.equal((await raw(origin, { 'accept-encoding': 'gzip;q=0, identity;q=1' })).body.toString(), html);
  assert.equal((await command()).count, before.count);
});
