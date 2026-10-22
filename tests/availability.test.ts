import assert from 'node:assert/strict';
import { fork, type ChildProcess } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { once } from 'node:events';
import { request } from 'node:http';
import test from 'node:test';

function message(child: ChildProcess, type: string): Promise<any> {
  return new Promise((resolve) => {
    const receive = (value: any) => { if (value.type === type) { child.off('message', receive); resolve(value); } };
    child.on('message', receive);
  });
}

test('real homepage SQLite stall cannot freeze public health socket', { timeout: 60_000 }, async (t) => {
  const child = fork(new URL('./fixtures/availability-gateway.mjs', import.meta.url), [], { execArgv: ['--import', 'tsx'], stdio: ['ignore', 'ignore', 'inherit', 'ipc'] });
  t.after(() => { if (child.connected) child.disconnect(); });
  const { port } = await message(child, 'ready');
  const origin = `http://127.0.0.1:${port}`;
  const startup = await fetch(`${origin}/healthz`);
  assert.equal(startup.status, 503, 'frontend starts before DB/card initialization, without a snapshot');
  await message(child, 'health');
  assert.equal((await fetch(`${origin}/healthz`).then((r) => r.json()) as { status: string }).status, 'healthy');
  let seeded: Response | undefined;
  for (let i = 0; i < 100; i++) {
    seeded = await fetch(`${origin}/`);
    if (seeded.status === 200) break;
    await delay(50);
  }
  assert.equal(seeded!.status, 200);
  const html = await seeded!.text();
  assert.match(html, /Time by platform/);
  const generatedAt = seeded!.headers.get('x-home-generated-at');
  assert.ok(generatedAt, 'a genuine homepage must expose its generation timestamp');
  const armed = message(child, 'armed'); child.send({ type: 'slow' }); await armed;
  const blocked = message(child, 'blocked');
  // Clock-driven regeneration must start without a visitor initiating DB work.
  await blocked;
  const begin = performance.now();
  for (const method of ['GET', 'HEAD', 'GET', 'HEAD']) {
    const response = await fetch(`${origin}/`, { method, signal: AbortSignal.timeout(1000) });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('x-home-generated-at'), generatedAt);
    assert.equal(await response.text(), method === 'HEAD' ? '' : html);
  }
  assert.ok(performance.now() - begin < 1000, 'last-good homepage remains responsive during 12 seconds of blocked SQLite');
  await delay(4100);
  for (let i = 0; i < 3; i++) {
    const stale = await fetch(`${origin}/healthz`, { signal: AbortSignal.timeout(1000) });
    assert.equal(stale.status, 503);
    const body = await stale.json() as any;
    assert.equal(body.status, 'unhealthy');
    assert.equal(body.metadata.error, 'snapshot_stale');
    assert.equal(body.sources[0].fresh, true, 'metadata failure is separate from source freshness');
    assert.ok(body.metadata.ageMs >= 4000);
    const home = await fetch(`${origin}/`, { signal: AbortSignal.timeout(1000) });
    assert.equal(home.status, 200);
    assert.equal(home.headers.get('x-home-stale'), 'true');
    assert.ok(Number(home.headers.get('age')) >= 4);
    assert.equal(home.headers.get('x-home-generated-at'), generatedAt);
    assert.equal(await home.text(), html);
    await delay(200);
  }
  assert.equal((await fetch(`${origin}/`)).status, 200);
  console.log('12s real SQLite stall: seeded GET/HEAD served; stale homepage retained while health fails closed');
  await message(child, 'health');
  console.log('availability: recovered observation');
  let recovered: Response | undefined;
  for (let i = 0; i < 50; i++) {
    recovered = await fetch(`${origin}/healthz`);
    if (recovered.status === 200) break;
    const waiting = await recovered.json() as any;
    assert.equal(waiting.metadata.fresh, true);
    assert.equal(waiting.backend.error, 'backend_busy');
    await delay(100);
  }
  assert.equal(recovered!.status, 200, 'health recovers only after old real requests settle and capacity is released');
  assert.equal((await recovered!.json() as any).status, 'healthy');
  const home = await fetch(`${origin}/`);
  const homeBody = await home.text();
  assert.equal(home.status, 200, homeBody);
  assert.match(homeBody, /Time by platform/);
  const json = await fetch(`${origin}/api/activities.json`);
  assert.equal(json.status, 200);
  assert.equal((await json.json() as any).total, 0);
  const malformed = await new Promise((resolve) => {
    const req = request({ hostname: '127.0.0.1', port, path: 'http://[', agent: false }, (res) => { res.resume(); resolve(res.statusCode); });
    req.on('error', () => resolve(0)); req.end();
  });
  assert.equal(malformed, 400, 'malformed request target cannot crash the frontend');
  assert.equal((await fetch(`${origin}/healthz`)).status, 200);
  const mcp = await fetch(`${origin}/mcp`, {
    method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {
      protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'synthetic availability probe', version: '1' },
    } }),
  });
  assert.equal(mcp.status, 200);
  assert.equal((await mcp.json() as any).result.serverInfo.name, 'infovore');
  const metadataFailure = message(child, 'health-error'); child.send({ type: 'metadata-error' }); await metadataFailure;
  const failed = await fetch(`${origin}/healthz`);
  assert.equal(failed.status, 503);
  assert.equal((await failed.json() as any).metadata.error, 'metadata_read_failed');
  const metadataRecovery = message(child, 'health'); child.send({ type: 'metadata-recover' }); await metadataRecovery;
  assert.equal((await fetch(`${origin}/healthz`).then((r) => r.json()) as any).status, 'healthy');
});
