import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

// scripts/deploy.sh against a stub `docker` that records every call and fails
// the one whose arguments contain STUB_FAIL. No container is touched.
const stubDocker = `#!/bin/sh
echo "$*" >> "$STUB_DIR/calls"
if [ -n "\${STUB_FAIL:-}" ]; then case "$*" in *"$STUB_FAIL"*) exit 1;; esac; fi
case "$1" in
  inspect)
    case "$3" in
      *Health.Status*) if [ -e "$STUB_DIR/drained-$4" ] && [ "$4" != "\${STUB_NEVER_UNHEALTHY:-}" ]; then echo unhealthy; else echo healthy; fi;;
      *State.Running*) echo true;;
      *.Image*) echo sha256:running;;
      *Mounts*) echo statusskyhongtw_infovore-data;;
      *Labels*)
        echo "com.docker.compose.project=$4"
        echo "traefik.http.services.infovore.loadbalancer.server.port=3000"
        if [ "$4" = infovore-candidate ] && [ -n "\${STUB_LABEL_DIFF:-}" ]; then echo "traefik.http.routers.infovore.middlewares=new"; fi;;
    esac;;
  exec) case "$*" in *infovore-drain*) touch "$STUB_DIR/drained-$2";; esac;;
  compose) case "$*" in *--force-recreate*) rm -f "$STUB_DIR/drained-infovore";; esac;;
esac
`;

async function deploy(t: { after(fn: () => unknown): void }, env: Record<string, string> = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'infovore-deploy-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await writeFile(join(dir, 'docker'), stubDocker);
  await writeFile(join(dir, 'sleep'), '#!/bin/sh\n');
  await chmod(join(dir, 'docker'), 0o755);
  await chmod(join(dir, 'sleep'), 0o755);
  await writeFile(join(dir, 'meminfo'), 'MemAvailable:    3000000 kB\n');
  await writeFile(join(dir, 'calls'), '');
  const result = await new Promise<{ code: number; output: string }>((resolve) => {
    execFile('sh', [fileURLToPath(new URL('../scripts/deploy.sh', import.meta.url))], {
      env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, STUB_DIR: dir, INFOVORE_MEMINFO: join(dir, 'meminfo'), ...env },
    }, (error, stdout, stderr) => resolve({ code: error ? Number(error.code ?? 1) : 0, output: stdout + stderr }));
  });
  const calls = (await readFile(join(dir, 'calls'), 'utf8')).trim().split('\n');
  const index = (fragment: string) => calls.findIndex((call) => call.includes(fragment));
  return { ...result, calls, index };
}

const CANDIDATE = '-p infovore-candidate';
const touchesProduction = (calls: string[]) => calls.some((call) =>
  /exec infovore sh -c touch/.test(call) || (call.includes('--force-recreate') && !call.includes(CANDIDATE)));

test('a full rollout serves from a ready candidate, drains before every stop, and removes only the candidate', async (t) => {
  const run = await deploy(t);
  assert.equal(run.code, 0, run.output);
  const order = [`${CANDIDATE} -f docker-compose.yml -f docker-compose.traefik.yml -f docker-compose.candidate.yml up -d`,
    'exec infovore-candidate sh scripts/container-health.sh --ready', 'exec infovore sh -c touch /tmp/infovore-drain',
    'up -d --no-build --force-recreate', 'exec infovore sh scripts/container-health.sh --ready',
    'exec infovore-candidate sh -c touch /tmp/infovore-drain', `${CANDIDATE} -f docker-compose.yml -f docker-compose.traefik.yml -f docker-compose.candidate.yml down`];
  const positions = order.map(run.index);
  assert.ok(positions.every((position) => position >= 0), JSON.stringify(positions));
  assert.deepEqual([...positions].sort((a, b) => a - b), positions, 'steps run in order');
  assert.ok(run.calls.filter((call) => / down$/.test(call)).every((call) => call.includes(CANDIDATE)), 'only the candidate project is taken down');
});

test('a candidate that cannot be created or started is cleaned up and production is untouched', async (t) => {
  for (const fail of ['up --no-start', `${CANDIDATE} -f docker-compose.yml -f docker-compose.traefik.yml -f docker-compose.candidate.yml up -d`]) {
    const run = await deploy(t, { STUB_FAIL: fail });
    assert.equal(run.code, 1, fail);
    assert.ok(run.calls.some((call) => call.includes(CANDIDATE) && call.endsWith(' down')), `${fail}: candidate removed`);
    assert.equal(touchesProduction(run.calls), false, `${fail}: production neither drained nor recreated`);
    assert.match(run.output, /production untouched/);
  }
});

test('a candidate whose readiness check fails never leads to production being drained', async (t) => {
  const run = await deploy(t, { STUB_FAIL: 'exec infovore-candidate sh scripts/container-health.sh --ready' });
  assert.equal(run.code, 1);
  assert.equal(touchesProduction(run.calls), false);
  assert.ok(run.calls.some((call) => call.includes(CANDIDATE) && call.endsWith(' down')));
});

test('changed Traefik labels stop the rollout before the candidate starts', async (t) => {
  const run = await deploy(t, { STUB_LABEL_DIFF: '1' });
  assert.equal(run.code, 1);
  assert.match(run.output, /Traefik labels changed/);
  assert.equal(run.index(`${CANDIDATE} -f docker-compose.yml -f docker-compose.traefik.yml -f docker-compose.candidate.yml up -d`), -1);
  assert.equal(touchesProduction(run.calls), false);
});

test('a failed production recreate keeps the ready candidate serving and prints the rollback', async (t) => {
  for (const fail of ['up -d --no-build --force-recreate', 'exec infovore sh scripts/container-health.sh --ready']) {
    const run = await deploy(t, { STUB_FAIL: fail });
    assert.equal(run.code, 1, fail);
    assert.match(run.output, /candidate keeps serving\. To roll back:/);
    assert.match(run.output, /docker tag infovore:rollback-\d{14} infovore:latest/);
    assert.equal(run.calls.some((call) => call.includes(CANDIDATE) && call.endsWith(' down')), false, `${fail}: candidate kept`);
    assert.equal(run.index('exec infovore-candidate sh -c touch /tmp/infovore-drain'), -1, `${fail}: candidate not drained`);
  }
});

test('low memory refuses to start a candidate', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'infovore-meminfo-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await writeFile(join(dir, 'meminfo'), 'MemAvailable:    1000000 kB\n');
  const low = await deploy(t, { INFOVORE_MEMINFO: join(dir, 'meminfo') });
  assert.equal(low.code, 1);
  assert.match(low.output, /MiB available; not starting a candidate/);
  assert.equal(low.calls.some((call) => call.startsWith('compose')), false);
});

test('production that cannot be drained is never stopped; both containers keep serving', async (t) => {
  for (const env of [{ STUB_FAIL: 'exec infovore sh -c touch' }, { STUB_NEVER_UNHEALTHY: 'infovore' }]) {
    const run = await deploy(t, env);
    const label = JSON.stringify(env);
    assert.equal(run.code, 1, label);
    assert.equal(run.index('--force-recreate'), -1, `${label}: production not recreated`);
    assert.equal(run.calls.some((call) => call.endsWith(' down')), false, `${label}: candidate not removed`);
    assert.match(run.output, /production could not be drained, so it was not stopped/, label);
    assert.match(run.output, /docker exec infovore sh -c 'rm -f \/tmp\/infovore-drain/, label);
  }
});

test('a candidate that cannot be drained is never removed; it keeps serving with the new production', async (t) => {
  for (const env of [{ STUB_FAIL: 'exec infovore-candidate sh -c touch' }, { STUB_NEVER_UNHEALTHY: 'infovore-candidate' }]) {
    const run = await deploy(t, env);
    const label = JSON.stringify(env);
    assert.equal(run.code, 1, label);
    assert.ok(run.index('--force-recreate') >= 0, `${label}: production was replaced first`);
    assert.equal(run.calls.some((call) => call.endsWith(' down')), false, `${label}: candidate not removed`);
    assert.match(run.output, /the candidate could not be drained, so it was not removed/, label);
    assert.match(run.output, /wait until 'docker inspect -f \{\{\.State\.Health\.Status\}\} infovore-candidate' is unhealthy/, label);
  }
});
