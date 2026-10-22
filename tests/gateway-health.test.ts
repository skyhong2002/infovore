import assert from 'node:assert/strict';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import { startGateway } from '../src/gateway.js';

test('health refuses an already-old observation even if IPC delivery is recent', async (t) => {
  const gateway = startGateway({ port: 0, hostname: '127.0.0.1', backendFile: new URL('./fixtures/health-peer.mjs', import.meta.url) });
  t.after(() => gateway.close());
  await once(gateway.server, 'listening');
  await once(gateway.child, 'message');
  const port = (gateway.server.address() as { port: number }).port;
  const incoming = once(gateway.child, 'message');
  gateway.child.send({ type: 'health', ageMs: 60_000 });
  await incoming;
  const result = await fetch(`http://127.0.0.1:${port}/healthz`);
  assert.equal(result.status, 503);
  assert.equal((await result.json() as any).metadata.error, 'snapshot_stale');
});

test('snapshot lifecycle is fail-closed at startup, on read error, stale metadata and child exit, then recovers only on a good observation', async (t) => {
  const gateway = startGateway({ port: 0, hostname: '127.0.0.1', staleMs: 500, backendFile: new URL('./fixtures/health-peer.mjs', import.meta.url) });
  t.after(() => gateway.close());
  await once(gateway.server, 'listening');
  await once(gateway.child, 'message');
  const origin = `http://127.0.0.1:${(gateway.server.address() as { port: number }).port}`;
  const probe = () => fetch(`${origin}/healthz`, { signal: AbortSignal.timeout(1000) });
  const publish = async (payload: object = {}) => {
    const incoming = once(gateway.child, 'message');
    gateway.child.send({ type: 'health', ...payload });
    await incoming;
  };
  assert.equal((await probe()).status, 503);
  assert.equal((await fetch(`${origin}/`)).status, 503);
  await publish();
  assert.equal((await probe()).status, 200);
  const body = (sources: object[]) => ({ status: 'healthy', maxSourceAgeHours: 1, sources });
  await publish({ body: body([{ source: 'synthetic-a', ageMs: 0, fresh: true, error: 'synthetic upstream failure' }]) });
  const degraded = await probe();
  assert.equal(degraded.status, 200);
  assert.equal((await degraded.json() as any).status, 'degraded', 'never relax degraded into healthy');
  await publish({ body: body([{ source: 'synthetic-a', ageMs: null, fresh: false, error: null }]) });
  assert.equal((await probe()).status, 503);
  await publish({ body: body([
    { source: 'synthetic-a', ageMs: 0, fresh: true, error: null },
    { source: 'synthetic-b', ageMs: 3_599_999, fresh: true, error: null },
  ]) });
  await delay(10);
  const aged = await probe().then((r) => r.json()) as any;
  assert.equal(aged.status, 'degraded');
  assert.equal(aged.sources[1].fresh, false, 'source ages continue advancing without a new DB read');
  const error = once(gateway.child, 'message'); gateway.child.send({ type: 'error' }); await error;
  const failed = await probe();
  assert.equal(failed.status, 503);
  assert.equal((await failed.json() as any).metadata.error, 'metadata_read_failed');
  await publish();
  assert.equal((await probe().then((r) => r.json()) as any).status, 'healthy');
  await delay(550);
  assert.equal((await probe()).status, 503);
  const head = await fetch(`${origin}/healthz`, { method: 'HEAD' });
  assert.equal(head.status, 503);
  assert.equal(await head.text(), '');
  await publish();
  assert.equal((await probe()).status, 200);
  const exited = once(gateway.child, 'exit'); gateway.child.send({ type: 'crash' }); await exited;
  const crashed = await probe();
  assert.equal(crashed.status, 503);
  assert.equal((await crashed.json() as any).metadata.error, 'backend_exited');
});

