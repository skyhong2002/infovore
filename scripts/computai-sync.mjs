#!/usr/bin/env node
// Push ComputAI's rolling 30-day aggregates to infovore. Spend, plan value,
// rank and badges never leave the Mac: only the fields in toReport are sent.
import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { homedir, hostname } from 'node:os';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

const run = promisify(execFile);

export function toReport(card, { deviceId, now = new Date() }) {
  const ops = card.ops ?? {};
  if (card.period !== '30d' || !Number.isFinite(card.tokens) || !Array.isArray(card.pulse)) throw new Error('Unexpected ComputAI card JSON');
  return {
    schemaVersion: 1, deviceId, observedAt: now.toISOString(), period: '30d',
    tokens: Math.round(card.tokens),
    agentHours: Number(ops.agent_hours ?? 0),
    peakParallel: Math.round(ops.peak_parallel ?? 0),
    cacheHitPct: Number(ops.cache_hit_pct ?? 0),
    fleet: (ops.fleet ?? []).map((f) => ({ source: String(f.source), pct: Number(f.pct) })),
    models: (card.models ?? []).slice(0, 10).map((m) => ({ model: String(m.model), sharePct: Number(m.share_pct) })),
    daily: card.pulse.slice(-30).map((v) => Math.max(0, Number(v) || 0)),
  };
}

async function main() {
  const configPath = resolve(process.argv[2] ?? 'computai-sync.json');
  const config = JSON.parse(await readFile(configPath, 'utf8'));
  const base = new URL(config.baseUrl);
  if (base.protocol !== 'https:' && !(base.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(base.hostname))) throw new Error('Use HTTPS for the ingest endpoint');
  if (base.username || base.password || base.search || base.hash || base.pathname !== '/') throw new Error('baseUrl must be an origin');
  if (typeof config.token !== 'string' || config.token.length < 32) throw new Error('A dedicated ComputAI token is required');
  const command = config.computaiCommand ?? resolve(homedir(), '.local/bin/computai');
  const { stdout } = await run(command, ['--card', '--json'], {
    env: { ...process.env, COMPUTAI_NO_UPDATE_CHECK: '1' }, timeout: 10 * 60 * 1000, maxBuffer: 16 * 1024 * 1024,
  });
  const report = toReport(JSON.parse(stdout), { deviceId: config.deviceId ?? hostname().replace(/[^a-zA-Z0-9._-]/g, '-') });
  for (let attempt = 0; ; attempt++) {
    try {
      const response = await fetch(new URL('/api/ingest/computai/reports', base), {
        method: 'POST', headers: { Authorization: `Bearer ${config.token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(report), signal: AbortSignal.timeout(30000), redirect: 'error',
      });
      if (!response.ok) {
        if (response.status < 500 && response.status !== 429) throw Object.assign(new Error(`ComputAI ingest rejected the report: HTTP ${response.status}`), { permanent: true });
        throw new Error(`ComputAI ingest HTTP ${response.status}`);
      }
      const result = await response.json();
      if (result.ok !== true) throw Object.assign(new Error('Invalid ingest acknowledgement'), { permanent: true });
      console.log(`${new Date().toISOString()} Sent ComputAI report (${report.tokens} tokens, ${result.updated ? 'updated' : 'unchanged'})`);
      return;
    } catch (error) {
      if (error.permanent || attempt >= 2) throw error;
      await new Promise((r) => setTimeout(r, 1000 * 2 ** attempt));
    }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error) => { console.error(error.message); process.exitCode = 1; });
}
