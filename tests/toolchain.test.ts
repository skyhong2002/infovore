import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const file = (path: string) => readFile(new URL(`../${path}`, import.meta.url), 'utf8');

// CI and the production image run Node 22; local runs should too (.nvmrc, engines).
test('one Node major everywhere: .nvmrc, package engines, CI and the Dockerfile', async () => {
  const major = (await file('.nvmrc')).trim();
  assert.match(major, /^\d+$/);
  const pkg = JSON.parse(await file('package.json')) as { engines?: { node?: string } };
  assert.equal(pkg.engines?.node, `>=${major} <${Number(major) + 1}`);
  const lock = JSON.parse(await file('package-lock.json')) as { packages: Record<string, { engines?: { node?: string } }> };
  assert.equal(lock.packages[''].engines?.node, pkg.engines?.node, 'package-lock.json mirrors the engines field');
  assert.match(await file('.github/workflows/ci.yml'), /node-version-file: \.nvmrc/);
  assert.match(await file('Dockerfile'), new RegExp(`^FROM node:${major}-`, 'm'));
});
