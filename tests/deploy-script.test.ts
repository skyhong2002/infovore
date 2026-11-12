import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { chmod, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

// scripts/deploy.sh against a stub `docker` that records every call and fails
// the one whose arguments contain STUB_FAIL. No container is touched, and the
// lock file is the test's own (INFOVORE_DEPLOY_LOCK), never /tmp's. `git` and
// `flock` are stubbed too (a fixed commit; flock records its arguments), so the
// tests also run from a copy without .git and with BusyBox's flock (no -w),
// as in the Node 22 image.
const stubDocker = `#!/bin/sh
echo "$*" >> "$STUB_DIR/calls"
if [ -n "\${STUB_FAIL:-}" ]; then case "$*" in *"$STUB_FAIL"*) exit 1;; esac; fi
case "$1" in
  inspect)
    case "$3" in
      *Health.Status*) if [ -e "$STUB_DIR/drained-$4" ] && [ "$4" != "\${STUB_NEVER_UNHEALTHY:-}" ]; then echo unhealthy; else echo healthy; fi;;
      *State.Running*) echo true;;
      *.Image*) echo sha256:running;;
      *Mounts*) echo "\${STUB_VOLUME-statusskyhongtw_infovore-data}";;
      *Labels*)
        echo "com.docker.compose.project=$4"
        echo "traefik.http.services.infovore.loadbalancer.server.port=3000"
        if [ "$4" = infovore-candidate ] && [ -n "\${STUB_LABEL_DIFF:-}" ]; then echo "traefik.http.routers.infovore.middlewares=new"; fi;;
    esac;;
  exec) case "$*" in *infovore-drain*) touch "$STUB_DIR/drained-$2";; esac;;
  compose) case "$*" in *--force-recreate*) rm -f "$STUB_DIR/drained-\${STUB_PRODUCTION:-infovore}";; esac;;
esac
`;

// The availability probes' `curl`: records its arguments, never connects, and
// prints the status a probe would see: STUB_CURL_STATUS (default 200) for URLs
// containing STUB_CURL_FAIL, 200 otherwise. The deploy's own sleep is stubbed
// out, so it waits a little with the real one to keep the probe loop from spinning.
const stubCurl = `#!/bin/sh
echo "$*" >> "$STUB_DIR/curl-calls"
/bin/sleep 0.01
for arg in "$@"; do url=$arg; done
if [ -n "\${STUB_CURL_FAIL:-}" ]; then case "$url" in *"$STUB_CURL_FAIL"*) printf '%s' "\${STUB_CURL_STATUS:-503}"; exit 0;; esac; fi
printf 200
`;

async function deploy(t: { after(fn: () => unknown): void }, env: Record<string, string> = {}, args: string[] = []) {
  const dir = await mkdtemp(join(tmpdir(), 'infovore-deploy-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await writeFile(join(dir, 'docker'), stubDocker);
  await writeFile(join(dir, 'curl'), stubCurl);
  await writeFile(join(dir, 'git'), '#!/bin/sh\necho 0123abc\n');
  await writeFile(join(dir, 'flock'), '#!/bin/sh\necho "$*" >> "$STUB_DIR/flock-calls"\n');
  await chmod(join(dir, 'git'), 0o755);
  await chmod(join(dir, 'flock'), 0o755);
  await writeFile(join(dir, 'sleep'), '#!/bin/sh\n');
  await chmod(join(dir, 'docker'), 0o755);
  await chmod(join(dir, 'curl'), 0o755);
  await chmod(join(dir, 'sleep'), 0o755);
  await writeFile(join(dir, 'meminfo'), 'MemAvailable:    3000000 kB\n');
  await writeFile(join(dir, 'calls'), '');
  await writeFile(join(dir, 'curl-calls'), '');
  const result = await new Promise<{ code: number; output: string }>((resolve) => {
    execFile('sh', [fileURLToPath(new URL('../scripts/deploy.sh', import.meta.url)), ...args], {
      env: {
        ...process.env,
        PATH: `${dir}:${process.env.PATH}`,
        STUB_DIR: dir,
        TMPDIR: dir,
        INFOVORE_MEMINFO: join(dir, 'meminfo'),
        INFOVORE_DEPLOY_LOCK: join(dir, 'deploy.lock'),
        INFOVORE_DEPLOY_LOG: join(dir, 'deploy.log'),
        PUBLIC_BASE_URL: 'https://infovore.test',
        ...env,
      },
    }, (error, stdout, stderr) => resolve({ code: error ? Number(error.code ?? 1) : 0, output: stdout + stderr }));
  });
  const calls = (await readFile(join(dir, 'calls'), 'utf8')).trim().split('\n');
  const curlCalls = (await readFile(join(dir, 'curl-calls'), 'utf8')).split('\n').filter(Boolean);
  const deployLog = await readFile(join(dir, 'deploy.log'), 'utf8').catch(() => '');
  const leftovers = (await readdir(dir)).filter((name) => name.startsWith('infovore-probes.'));
  const flockCalls = await readFile(join(dir, 'flock-calls'), 'utf8').catch(() => '');
  const index = (fragment: string) => calls.findIndex((call) => call.includes(fragment));
  return { ...result, calls, curlCalls, deployLog, leftovers, flockCalls, index };
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
  assert.match(run.output, /deployed \S+\n[^\n]*availability: probes \d+, non-2xx 0\n?$/, 'the probe summary closes the output');
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
    assert.match(run.output, /docker tag infovore:rollback-\d{14} infovore && git checkout ORIG_HEAD && docker compose -f docker-compose.yml -f docker-compose.traefik.yml up -d --no-build/);
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
  for (const env of [{ STUB_FAIL: 'exec infovore sh -c touch' }, { STUB_NEVER_UNHEALTHY: 'infovore' }] as Array<Record<string, string>>) {
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
  for (const env of [{ STUB_FAIL: 'exec infovore-candidate sh -c touch' }, { STUB_NEVER_UNHEALTHY: 'infovore-candidate' }] as Array<Record<string, string>>) {
    const run = await deploy(t, env);
    const label = JSON.stringify(env);
    assert.equal(run.code, 1, label);
    assert.ok(run.index('--force-recreate') >= 0, `${label}: production was replaced first`);
    assert.equal(run.calls.some((call) => call.endsWith(' down')), false, `${label}: candidate not removed`);
    assert.match(run.output, /the candidate could not be drained, so it was not removed/, label);
    assert.match(run.output, /wait until 'docker inspect -f \{\{\.State\.Health\.Status\}\} infovore-candidate' is unhealthy/, label);
  }
});

test('the sky-server config rolls out the Dokploy stack without ever pointing the candidate at its project', async (t) => {
  const config = fileURLToPath(new URL('../scripts/deploy.sky-server.env', import.meta.url));
  const production = 'compose-calculate-online-port-oqidr1-infovore-1';
  const dokployFile = '-f /etc/dokploy/compose/compose-calculate-online-port-oqidr1/code/docker-compose.yml';
  const candidate = `-p infovore-candidate ${dokployFile} -f docker-compose.candidate-dokploy.yml`;
  const run = await deploy(t, { STUB_PRODUCTION: production, STUB_VOLUME: '' }, [config]);
  assert.equal(run.code, 0, run.output);
  assert.ok(run.index(`tag sha256:running blog-svc-infovore:rollback-`) >= 0, 'running image kept for rollback');
  assert.ok(run.index('build -q -t blog-svc-infovore:production .') >= 0, 'builds the fixed tag Dokploy uses');
  const order = [`${candidate} up -d`, 'exec infovore-candidate sh scripts/container-health.sh --ready',
    `exec ${production} sh -c touch /tmp/infovore-drain`,
    `compose -p compose-calculate-online-port-oqidr1 ${dokployFile} up -d --no-build --force-recreate`,
    `exec ${production} sh scripts/container-health.sh --ready`,
    'exec infovore-candidate sh -c touch /tmp/infovore-drain', `${candidate} down`];
  const positions = order.map(run.index);
  assert.ok(positions.every((position) => position >= 0), JSON.stringify(positions));
  assert.deepEqual([...positions].sort((a, b) => a - b), positions, 'steps run in order');
  assert.ok(run.calls.filter((call) => call.includes('-p infovore-candidate')).every((call) => !call.includes('oqidr1 ')),
    'candidate calls never name the production project');
  assert.ok(run.calls.filter((call) => / down$/.test(call)).every((call) => call.includes('-p infovore-candidate')), 'only the candidate project is taken down');
  // The config's probes: only the public site's pages (the stub curl never connects).
  const probed = new Set(run.curlCalls.map((call) => call.split(' ').at(-1)));
  assert.deepEqual([...probed].sort(), ['https://infovore.skyhong.tw/', 'https://infovore.skyhong.tw/now', 'https://infovore.skyhong.tw/status']);
  assert.match(run.output, /availability: probes \d+, non-2xx 0/);
});

test('a missing deploy config stops before touching Docker', async (t) => {
  const run = await deploy(t, {}, ['/nonexistent/deploy.env']);
  assert.equal(run.code, 1);
  assert.match(run.output, /deploy config \/nonexistent\/deploy.env not found/);
  assert.deepEqual(run.calls, ['']);
});

// ---- Availability probes ----------------------------------------------------

test('probes run during the rollout with Accept: text/html, end with it, and are summarised and logged', async (t) => {
  const run = await deploy(t);
  assert.equal(run.code, 0, run.output);
  assert.match(run.output, /probing https:\/\/infovore\.test\/ https:\/\/infovore\.test\/now https:\/\/infovore\.test\/status every 0\.5 s/);
  // At least the closing sweep of every URL; every probe asks for HTML and has a timeout.
  assert.ok(run.curlCalls.length >= 3, String(run.curlCalls.length));
  assert.ok(run.curlCalls.every((call) => call.includes('-H Accept: text/html') && call.includes('--max-time')), run.curlCalls[0]);
  for (const path of ['/', '/now', '/status']) assert.ok(run.curlCalls.some((call) => call.endsWith(`https://infovore.test${path}`)), path);
  const summary = run.output.match(/availability: probes (\d+), non-2xx (\d+)/);
  assert.ok(summary, run.output);
  assert.equal(Number(summary[1]), run.curlCalls.length, 'every probe is counted');
  assert.equal(summary[2], '0');
  // The deploy log gets one line without secrets: time, commit, exit code, counts.
  assert.match(run.deployLog, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ 0123abc exit=0 probes \d+, non-2xx 0\n$/);
  assert.deepEqual(run.leftovers, [], 'the probe scratch directory is removed');
});

test('failed probes are listed with time, path and status but do not fail the deploy by default', async (t) => {
  const run = await deploy(t, { STUB_CURL_FAIL: '/now', STUB_CURL_STATUS: '503' });
  assert.equal(run.code, 0, run.output);
  const summary = run.output.match(/availability: probes (\d+), non-2xx (\d+)/);
  assert.ok(summary && Number(summary[2]) >= 1, run.output);
  assert.equal(Number(summary[2]), run.curlCalls.filter((call) => call.endsWith('/now')).length, 'exactly the /now probes failed');
  assert.match(run.output, /\] {3}\d\d:\d\d:\d\d \/now 503\n/);
  assert.doesNotMatch(run.output, /\/status 503|\s\/ 503/);
  assert.match(run.deployLog, /exit=0 probes \d+, non-2xx [1-9]\d*\n$/);
});

test('PROBE_FAIL_ON_ERROR=1 turns a failed probe into a failed deploy; a clean one still passes', async (t) => {
  const failing = await deploy(t, { STUB_CURL_FAIL: '/status', STUB_CURL_STATUS: '000', PROBE_FAIL_ON_ERROR: '1' });
  assert.equal(failing.code, 1, failing.output);
  assert.match(failing.output, /deployed /, 'the rollout itself finished');
  assert.match(failing.output, /\/status 000/);
  assert.match(failing.output, /PROBE_FAIL_ON_ERROR=1 and a probe failed/);
  const clean = await deploy(t, { PROBE_FAIL_ON_ERROR: '1' });
  assert.equal(clean.code, 0, clean.output);
});

test('a rollout that fails after the probes started still reports them and keeps its exit code', async (t) => {
  const run = await deploy(t, { STUB_FAIL: 'up -d --no-build --force-recreate' });
  assert.equal(run.code, 1);
  assert.match(run.output, /candidate keeps serving[\s\S]*availability: probes \d+, non-2xx 0/);
  assert.match(run.deployLog, /exit=1 probes/);
  assert.deepEqual(run.leftovers, []);
});

test('probes can be turned off, and stay off without any URL; refusals before the rollout start none', async (t) => {
  const off = await deploy(t, { PROBE_ENABLED: '0' });
  assert.equal(off.code, 0, off.output);
  assert.deepEqual(off.curlCalls, []);
  assert.doesNotMatch(off.output, /availability/);

  const noUrl = await deploy(t, { PUBLIC_BASE_URL: '' });
  assert.equal(noUrl.code, 0, noUrl.output);
  assert.deepEqual(noUrl.curlCalls, []);
  assert.match(noUrl.output, /availability probes off: set PROBE_URLS/);

  const explicit = await deploy(t, { PROBE_URLS: 'https://example.test/healthz' });
  assert.equal(explicit.code, 0, explicit.output);
  assert.ok(explicit.curlCalls.length >= 1 && explicit.curlCalls.every((call) => call.endsWith('https://example.test/healthz')));

  const dir = await mkdtemp(join(tmpdir(), 'infovore-meminfo-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await writeFile(join(dir, 'meminfo'), 'MemAvailable:    1000000 kB\n');
  const refused = await deploy(t, { INFOVORE_MEMINFO: join(dir, 'meminfo') });
  assert.equal(refused.code, 1);
  assert.deepEqual(refused.curlCalls, []);
  assert.equal(refused.deployLog, '');
});

test('the deploy lock lives where INFOVORE_DEPLOY_LOCK says', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'infovore-lock-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const lock = join(dir, 'own.lock');
  const run = await deploy(t, { INFOVORE_DEPLOY_LOCK: lock });
  assert.equal(run.code, 0, run.output);
  assert.deepEqual(await readdir(dir), ['own.lock']);
  // Waits up to ten minutes for a running deploy, on the descriptor opened on that file.
  assert.equal(run.flockCalls, '-w 600 9\n');
  // The default stays /tmp/infovore-deploy.lock, the path production deploys share.
  const script = await readFile(fileURLToPath(new URL('../scripts/deploy.sh', import.meta.url)), 'utf8');
  assert.match(script, /LOCK=\$\{INFOVORE_DEPLOY_LOCK:-\/tmp\/infovore-deploy\.lock\}/);
});
