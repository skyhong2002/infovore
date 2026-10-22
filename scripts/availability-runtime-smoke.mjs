// Run from /app using the production-only Node 22 image, without network or
// production volumes. All records/tokens/challenges in this probe are synthetic.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { request } from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';
import { gunzipSync } from 'node:zlib';

console.log('runtime', process.version, process.platform, process.arch);
assert.equal(process.versions.node.split('.')[0], '22');
const { PowSolver, solvePow } = await import(process.cwd() + '/src/sources/anubis-pow.ts');
const expected = { nonce: 0, hash: createHash('sha256').update('synthetic-runtime0').digest('hex') };
assert.deepEqual(await solvePow('synthetic-runtime', 0), expected);
assert.equal(await solvePow('synthetic-runtime', 65, 100), null);
const options = { timeoutMs: 250 };
const solver = new PowSolver(options);
const impossible = solver.solve('synthetic-impossible', 65);
assert.equal(solver.solve('synthetic-impossible', 65), impossible);
await assert.rejects(solver.solve('different-synthetic', 65), /busy/);
await assert.rejects(impossible, /deadline/);
options.timeoutMs = 15_000;
assert.deepEqual(await solver.solve('synthetic-runtime', 0), expected);
console.log('PASS production tsx + mjs PoW: first nonce/hash, exhaustion, single-flight, overflow, timeout termination, recovery');

// Exercise the exact Docker CMD's npx/tsx entry, including its isolated app
// child (node --import tsx). Disable all polled sources: absolutely no upstream
// request is made, and the configured-but-empty Dayflow source stays unhealthy.
const child = spawn('npx', ['tsx', 'src/server.ts'], {
  detached: true,
  env: { ...process.env, NODE_ENV: 'production', PORT: '3000', SOURCES: 'dayflow', DATABASE_PATH: ':memory:',
    DAYFLOW_TOKEN: 'synthetic-runtime-token-at-least-32-characters', COMPUTAI_TOKEN: '', INGEST_TOKEN: '', HEALTH_CONNECT_TOKEN: '' },
  stdio: ['ignore', 'pipe', 'inherit'],
});
let stdout = '';
child.stdout.on('data', (data) => { stdout += data; });
const base = 'http://127.0.0.1:3000';
try {
  for (let i = 0; i < 120 && !stdout.includes('listening on :3000'); i++) {
    assert.equal(child.exitCode, null, 'entrypoint exited early');
    await delay(100);
  }
  assert.match(stdout, /listening on :3000/);
  const initial = await fetch(`${base}/healthz`, { signal: AbortSignal.timeout(1000) });
  assert.equal(initial.status, 503, 'empty data must never be reported healthy');
  let health;
  for (let i = 0; i < 120; i++) {
    health = await fetch(`${base}/healthz`, { signal: AbortSignal.timeout(1000) }).then((r) => r.json());
    if (health.metadata.fresh) break;
    await delay(250);
  }
  assert.equal(health.metadata.fresh, true, 'backend must actually publish a successful metadata read');
  assert.equal(health.status, 'unhealthy');
  assert.equal(health.sources[0].source, 'dayflow');
  assert.equal(health.sources[0].fresh, false);
  let home;
  for (let i = 0; i < 120; i++) {
    home = await fetch(`${base}/`, { signal: AbortSignal.timeout(4000) });
    if (home.status === 200) break;
    assert.equal(home.status, 503, 'only explicit startup/stale/deadline failure is allowed while caches warm');
    const failure = await home.json();
    assert.equal(failure.error, 'home_snapshot_unavailable');
    await delay(250);
  }
  assert.equal(home.status, 200);
  assert.match(await home.text(), /Time by platform/);
  const png = await fetch(`${base}/favicon.png`);
  assert.equal(png.status, 200);
  assert.equal(png.headers.get('content-type'), 'image/png');
  assert.deepEqual([...new Uint8Array(await png.arrayBuffer()).slice(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
  const activities = await fetch(`${base}/api/activities.json`).then((r) => r.json());
  assert.equal(activities.total, 0);
  const spent = await fetch(`${base}/api/time-spent.json`);
  assert.equal(spent.status, 200);
  assert.ok(Array.isArray((await spent.json()).sources));
  const mcp = await fetch(`${base}/mcp`, {
    method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {
      protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'synthetic image smoke', version: '1' },
    } }),
  });
  assert.equal(mcp.status, 200);
  assert.equal((await mcp.json()).result.serverInfo.name, 'infovore');
  const compressed = await new Promise((resolve, reject) => {
    request(`${base}/`, { headers: { 'accept-encoding': 'gzip' } }, (res) => {
      const chunks = []; res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, bytes: Buffer.concat(chunks) }));
      res.on('error', reject);
    }).on('error', reject).end();
  });
  assert.equal(compressed.status, 200);
  assert.equal(compressed.headers['content-encoding'], 'gzip');
  assert.match(gunzipSync(compressed.bytes).toString(), /Time by platform/);
  const began = performance.now();
  const probes = await Promise.all(Array.from({ length: 8 }, (_, i) => fetch(`${base}/${i % 2 ? '' : 'healthz'}`, { signal: AbortSignal.timeout(1000) }).then(async (r) => ({ status: r.status, body: await r.text() }))));
  assert.ok(probes.every((r, i) => r.status === (i % 2 ? 200 : 503)));
  console.log('PASS exact npx/tsx Docker entry + child: honest empty-source health, homepage, JSON APIs, binary PNG, gzip bytes, MCP POST');
  console.log('PASS 8 concurrent loopback homepage/health sockets', Math.round(performance.now() - began), 'ms');
} finally {
  const exited = once(child, 'exit');
  try { process.kill(-child.pid, 'SIGTERM'); } catch (error) { if (error.code !== 'ESRCH') throw error; }
  await Promise.race([exited, delay(5000).then(() => { throw new Error('runtime smoke child failed to exit'); })]);
}
console.log('PASS runtime smoke cleanup');
