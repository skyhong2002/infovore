import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import test from 'node:test';
import { readFile } from 'node:fs/promises';

test('backend warmup leaves homepage regeneration exclusively to the gateway', async () => {
  const code = await readFile(new URL('../src/app-backend.ts', import.meta.url), 'utf8');
  const warmPaths = code.match(/for \(const path of \[([^\]]+)\]/)?.[1];
  assert.ok(warmPaths, 'other application routes still warm normally');
  assert.doesNotMatch(warmPaths, /['"]\/['"]/, 'startup must not render a second homepage outside single-flight admission');
});

test('production entrypoint exits nonzero when app child fails startup, allowing compose restart', { timeout: 60_000 }, async (t) => {
  const child = spawn(process.execPath, ['--import', 'tsx', 'src/server.ts'], {
    cwd: new URL('..', import.meta.url),
    env: { ...process.env, PORT: '0', DAYFLOW_TOKEN: 'synthetic-invalid-short-token' },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  let stderr = '';
  child.stderr.on('data', (data) => { stderr += data; });
  t.after(() => child.kill());
  let timer: ReturnType<typeof setTimeout>;
  const exit = await Promise.race([
    once(child, 'exit').then(([code]) => code),
    new Promise((resolve) => { timer = setTimeout(() => resolve('timeout'), 30_000); }),
  ]);
  clearTimeout(timer!);
  assert.match(stderr, /DAYFLOW_TOKEN must contain at least 32 characters/);
  assert.notEqual(exit, 'timeout', 'frontend must not remain alive permanently after its only backend dies');
  assert.notEqual(exit, 0);
});
