import assert from 'node:assert/strict';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import { startGateway } from '../src/gateway.js';

test('deadlined async work retains bounded capacity and health never reports healthy while all slots are occupied', async (t) => {
  const gateway = startGateway({ port: 0, hostname: '127.0.0.1', maxInFlight: 1, requestDeadlineMs: 100, staleMs: 10_000,
    backendFile: new URL('./fixtures/health-peer.mjs', import.meta.url) });
  t.after(() => gateway.close());
  await once(gateway.server, 'listening');
  await once(gateway.child, 'message');
  const incoming = once(gateway.child, 'message'); gateway.child.send({ type: 'health' }); await incoming;
  const base = `http://127.0.0.1:${(gateway.server.address() as { port: number }).port}`;
  // Startup now includes one background homepage generation in the same
  // bounded admission pool; wait for that real request to settle first.
  for (let i = 0; i < 100; i++) {
    const response = await fetch(`${base}/healthz`);
    if (response.status === 200) break;
    assert.equal((await response.json() as any).backend.error, 'backend_busy');
    await delay(20);
  }
  assert.equal((await fetch(`${base}/healthz`)).status, 200);
  const stalled = await fetch(`${base}/stall`);
  assert.equal(stalled.status, 503);
  assert.equal((await stalled.json() as any).error, 'backend_deadline');
  assert.equal((await fetch(`${base}/other`).then((r) => r.json()) as any).error, 'backend_busy');
  const saturated = await fetch(`${base}/healthz`);
  assert.equal(saturated.status, 503);
  const body = await saturated.json() as any;
  assert.equal(body.status, 'unhealthy');
  assert.equal(body.metadata.fresh, true, 'metadata freshness and serving capacity are independent');
  assert.equal(body.backend.error, 'backend_busy');
  assert.equal(body.backend.inFlight, 1);
  gateway.child.send({ type: 'release' });
  let recovered = false;
  for (let i = 0; i < 50; i++) {
    if ((await fetch(`${base}/healthz`)).status === 200) { recovered = true; break; }
    await delay(20);
  }
  assert.ok(recovered, 'admission is released after the actual response finishes, not after the client deadline');
  assert.equal(await fetch(`${base}/other`).then((r) => r.text()), 'synthetic backend');
});
