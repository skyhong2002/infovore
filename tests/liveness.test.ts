import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, open, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { startGateway } from '../src/gateway.js';
import { prewarmFiles } from '../src/prewarm.js';
import { createIngestApp } from '../src/ingest.js';
import { repository } from '../src/index.js';

test('container healthcheck probes liveness, never readiness or source freshness', async () => {
  const dockerfile = await readFile(new URL('../Dockerfile', import.meta.url), 'utf8');
  const healthcheck = dockerfile.match(/^HEALTHCHECK[^\n]*\\\n[^\n]*/m)?.[0] ?? '';
  assert.match(healthcheck, /\/livez/);
  assert.doesNotMatch(healthcheck, /\/healthz/);
  assert.match(healthcheck, /--start-interval=/);
});

test('gateway is live while its backend is still starting, and /healthz still says unhealthy', async (t) => {
  const gateway = startGateway({ port: 0, hostname: '127.0.0.1', backendFile: new URL('./fixtures/health-peer.mjs', import.meta.url) });
  t.after(() => gateway.close());
  await once(gateway.server, 'listening');
  const origin = `http://127.0.0.1:${(gateway.server.address() as { port: number }).port}`;
  const live = await fetch(`${origin}/livez`);
  assert.equal(live.status, 200);
  assert.deepEqual(await live.json(), { status: 'alive' });
  assert.equal((await fetch(`${origin}/livez`, { method: 'HEAD' })).status, 200);
  const health = await fetch(`${origin}/healthz`);
  assert.equal(health.status, 503);
  assert.equal((await health.json() as { status: string }).status, 'unhealthy');
});

test('ingest answers the shared /livez healthcheck with its existing configuration health', async () => {
  const ingest = createIngestApp(repository);
  for (const path of ['/livez', '/healthz']) {
    const response = await ingest.request(path);
    assert.equal(response.status, 200, path);
    assert.deepEqual(await response.json(), { status: 'healthy', service: 'infovore-ingest' });
  }
});

test('database prewarm reads files sequentially, tolerates absence, and stops at its deadline', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'infovore-prewarm-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await writeFile(join(dir, 'db'), Buffer.alloc(9 << 20, 1));
  await writeFile(join(dir, 'db-wal'), Buffer.alloc(1234, 2));
  const warm = await prewarmFiles([join(dir, 'db'), join(dir, 'db-wal'), join(dir, 'missing')]);
  assert.equal(warm.bytes, (9 << 20) + 1234);
  assert.equal(warm.complete, true);
  // A FIFO with no writer blocks the read, standing in for a stalled disk.
  execFileSync('mkfifo', [join(dir, 'stalled')]);
  const stalled = await prewarmFiles([join(dir, 'stalled'), join(dir, 'db')], 200);
  assert.equal(stalled.complete, false);
  assert.equal(stalled.bytes, 0);
  assert.ok(stalled.ms >= 150 && stalled.ms < 5000, String(stalled.ms));
  // Release the blocked open so the abandoned read settles and the test exits.
  await (await open(join(dir, 'stalled'), 'w')).close();
});
