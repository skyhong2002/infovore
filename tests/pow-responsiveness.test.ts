import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';

// Probe runs in the parent process, so a stalled child cannot stall the deadline.
test('real HTTP remains responsive while solving synthetic impossible PoW', { timeout: 60_000 }, async (t) => {
  const child = fork(new URL('./fixtures/pow-server.mjs', import.meta.url), [], { execArgv: ['--import', 'tsx'], stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
  t.after(() => child.kill());
  const [{ port }] = await once(child, 'message') as [{ port: number }];
  const started = once(child, 'message');
  const solving = fetch(`http://127.0.0.1:${port}/solve`).then((r) => r.text()).catch(() => 'closed');
  await started;
  for (let wave = 0; wave < 5; wave++) {
    if (wave) await delay(500);
    const begin = performance.now();
    const probes = await Promise.all(Array.from({ length: 3 }, () => fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(1000) }).then((r) => r.text()).catch(() => 'timeout')));
    const elapsed = Math.round(performance.now() - begin);
    assert.deepEqual(probes, ['alive', 'alive', 'alive'], `HTTP blocked during PoW (${elapsed}ms)`);
    console.log(`synthetic PoW active: socket wave ${wave + 1}, three concurrent probes in ${elapsed}ms`);
  }
  assert.notEqual(await solving, 'closed');
});
