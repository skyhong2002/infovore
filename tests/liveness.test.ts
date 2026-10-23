import assert from 'node:assert/strict';
import { execFile, execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { once } from 'node:events';
import { mkdtemp, open, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { startGateway } from '../src/gateway.js';
import { prewarmFiles } from '../src/prewarm.js';
import { startRefreshOwner } from '../src/refresh-owner.js';

test('the web image healthcheck runs the ready-once script; ingest keeps its configuration health', async () => {
  const dockerfile = await readFile(new URL('../Dockerfile', import.meta.url), 'utf8');
  const healthcheck = dockerfile.match(/^HEALTHCHECK[^\n]*\\\n[^\n]*/m)?.[0] ?? '';
  assert.match(healthcheck, /CMD sh scripts\/container-health\.sh$/);
  assert.match(healthcheck, /--start-interval=2s/);
  assert.match(dockerfile, /^COPY scripts\/container-health\.sh /m);
  const compose = await readFile(new URL('../docker-compose.yml', import.meta.url), 'utf8');
  const ingest = compose.slice(compose.indexOf('  ingest:'));
  assert.match(ingest, /test: \["CMD-SHELL", "wget -qO- http:\/\/127\.0\.0\.1:3001\/healthz \|\| exit 1"\]/);
});

test('container healthcheck admits traffic only after full readiness, then tracks liveness until drained or restarted', async (t) => {
  const status: Record<string, number> = { '/livez': 200, '/healthz': 503, '/': 503, '/now': 503 };
  const server = createServer((req, res) => { res.statusCode = status[req.url ?? ''] ?? 404; res.end(); });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const dir = await mkdtemp(join(tmpdir(), 'infovore-health-'));
  t.after(() => { server.close(); return rm(dir, { recursive: true, force: true }); });
  const marker = join(dir, 'ready');
  const drain = join(dir, 'drain');
  const env = { ...process.env, PORT: String((server.address() as { port: number }).port), INFOVORE_READY_FILE: marker, INFOVORE_DRAIN_FILE: drain };
  const probe = () => new Promise<number>((resolve) => {
    execFile('sh', [fileURLToPath(new URL('../scripts/container-health.sh', import.meta.url))], { env }, (error) => resolve(error ? 1 : 0));
  });
  // Alive but not ready: the gateway answers, the backend or homepage does not.
  assert.equal(await probe(), 1);
  status['/healthz'] = 200;
  assert.equal(await probe(), 1, 'healthz alone is not ready without a real homepage');
  status['/'] = 200;
  assert.equal(await probe(), 1, 'a backend-rendered page must answer too');
  status['/now'] = 200;
  assert.equal(await probe(), 0);
  // Once ready, a stall or stale upstream must not remove it from routing...
  status['/healthz'] = 503; status['/'] = 503; status['/now'] = 503;
  assert.equal(await probe(), 0);
  // ...but a dead gateway does, and so does a deploy draining it out of Traefik.
  status['/livez'] = 503;
  assert.equal(await probe(), 1);
  status['/livez'] = 200;
  assert.equal(await probe(), 0);
  await writeFile(drain, '');
  assert.equal(await probe(), 1, 'a drained container must leave Traefik even though it is alive');
  await rm(drain);
  // A marker from an earlier process (container restart) does not count.
  status['/livez'] = 200;
  await writeFile(marker, 'some-earlier-boot\n');
  assert.equal(await probe(), 1);
});

test('a rollout candidate never touches sync runs or refreshes; the production role does', () => {
  const calls: string[] = [];
  const repository = { abandonRunningSyncs: () => { calls.push('abandon'); return 0; } };
  const schedule = () => { calls.push('schedule'); return Promise.resolve(); };
  assert.equal(startRefreshOwner('candidate', repository, schedule), false);
  assert.deepEqual(calls, []);
  assert.equal(startRefreshOwner(undefined, repository, schedule), true);
  assert.deepEqual(calls, ['abandon', 'schedule']);
});

test('the app child delegates refresh ownership to its role', async () => {
  const code = await readFile(new URL('../src/app-backend.ts', import.meta.url), 'utf8');
  assert.match(code, /startRefreshOwner\(process\.env\.INFOVORE_ROLE, repository, \(\) => refreshAndSchedule\(/);
  assert.equal(code.match(/abandonRunningSyncs|refreshAndSchedule\(/g)?.length, 1, 'no other refresh or sync-run writer');
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
