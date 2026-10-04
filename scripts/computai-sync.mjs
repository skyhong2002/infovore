#!/usr/bin/env node
// Push ComputAI's rolling 30-day aggregates and its agent work segments to
// infovore. Spend, plan value, rank and badges never leave the Mac: only the
// fields in toReport and toSegments are sent.
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { homedir, hostname } from 'node:os';
import { basename, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

const run = promisify(execFile);
// ComputAI's rule for agent hours: requests in one session less than five
// minutes apart are continuous work.
const AGENT_GAP = 300;
// A segment ends one minute after its last request, so a single reply shows.
const TAIL = 60;
const SOURCES = ['claude', 'codex', 'gemini', 'opencode'];
const DAY = 86_400;

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

const safe = (value) => String(value).replace(/[^a-zA-Z0-9._-]/g, '-').slice(0, 100) || 'unknown';

// Rows ordered by source, device, session, subagent, project, ts. Other machines'
// sessions arrive as ComputAI's hash, or blank from versions that dropped them;
// blank ones split by project instead.
export function toSegments(rows, { machineNames = {}, localMachine }) {
  const segments = [];
  let current = null;
  const close = () => { if (current) segments.push(current.segment); current = null; };
  for (const row of rows) {
    const key = [row.source, row.device, row.session, row.subagent, row.project].join('\u001f');
    if (!current || current.key !== key || row.ts - current.last > AGENT_GAP) {
      close();
      current = { key, last: row.ts, segment: {
        source: row.source,
        machine: safe(row.device ? machineNames[row.device] ?? row.device : localMachine),
        project: basename(String(row.project ?? '')).slice(0, 200),
        session: row.session ? createHash('sha256').update(String(row.session)).digest('hex').slice(0, 12) : '',
        subagent: Boolean(row.subagent),
        start: row.ts, end: row.ts, tokens: 0, requests: 0,
      } };
    }
    current.last = row.ts;
    current.segment.end = row.ts;
    current.segment.tokens += Math.max(0, Math.round(Number(row.tokens) || 0));
    current.segment.requests += Math.max(1, Number(row.requests) || 1);
  }
  close();
  return segments.map((s) => ({ ...s, start: new Date(s.start * 1000).toISOString(), end: new Date((s.end + TAIL) * 1000).toISOString() }));
}

async function readLedger(path, from, to) {
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    // ComputAI writes with a rollback journal; wait out its writes instead of failing.
    db.exec('PRAGMA busy_timeout = 30000');
    const machineNames = Object.fromEntries(db.prepare('SELECT id, name FROM devices').all().map((d) => [d.id, d.name]));
    // A day of lead-in so a session that began before `from` keeps its true start.
    const rows = db.prepare(`SELECT source, session, subagent, device, project, ts, requests,
        input + cache_read + cache_write_5m + cache_write_1h + output AS tokens
      FROM usage WHERE source IN (${SOURCES.map(() => '?').join(',')}) AND ts >= ? AND ts < ?
      ORDER BY source, device, session, subagent, project, ts`).all(...SOURCES, from - DAY, to);
    const first = db.prepare(`SELECT MIN(ts) first FROM usage WHERE source IN (${SOURCES.map(() => '?').join(',')})`).get(...SOURCES).first;
    return { rows, machineNames, first };
  } finally { db.close(); }
}

function taipeiMidnight(epoch) {
  return Math.floor((epoch + 8 * 3600) / DAY) * DAY - 8 * 3600;
}

async function main() {
  const configPath = resolve(process.argv[2] ?? 'computai-sync.json');
  const config = JSON.parse(await readFile(configPath, 'utf8'));
  const base = new URL(config.baseUrl);
  if (base.protocol !== 'https:' && !(base.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(base.hostname))) throw new Error('Use HTTPS for the ingest endpoint');
  if (base.username || base.password || base.search || base.hash || base.pathname !== '/') throw new Error('baseUrl must be an origin');
  if (typeof config.token !== 'string' || config.token.length < 32) throw new Error('A dedicated ComputAI token is required');
  const deviceId = config.deviceId ?? safe(hostname());
  const post = async (path, body) => {
    for (let attempt = 0; ; attempt++) {
      try {
        const response = await fetch(new URL(path, base), {
          method: 'POST', headers: { Authorization: `Bearer ${config.token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify(body), signal: AbortSignal.timeout(60000), redirect: 'error',
        });
        if (!response.ok) {
          if (response.status < 500 && response.status !== 429) throw Object.assign(new Error(`ComputAI ingest rejected ${path}: HTTP ${response.status}`), { permanent: true });
          throw new Error(`ComputAI ingest HTTP ${response.status}`);
        }
        const result = await response.json();
        if (result.ok !== true) throw Object.assign(new Error('Invalid ingest acknowledgement'), { permanent: true });
        return result;
      } catch (error) {
        if (error.permanent || attempt >= 2) throw error;
        await new Promise((r) => setTimeout(r, 1000 * 2 ** attempt));
      }
    }
  };

  const command = config.computaiCommand ?? resolve(homedir(), '.local/bin/computai');
  const { stdout } = await run(command, ['--card', '--json'], {
    env: { ...process.env, COMPUTAI_NO_UPDATE_CHECK: '1' }, timeout: 10 * 60 * 1000, maxBuffer: 16 * 1024 * 1024,
  });
  const report = toReport(JSON.parse(stdout), { deviceId });
  const sent = await post('/api/ingest/computai/reports', report);
  console.log(`${new Date().toISOString()} Sent ComputAI report (${report.tokens} tokens, ${sent.updated ? 'updated' : 'unchanged'})`);

  // The ledger is ComputAI's internal store; if its layout changes, keep the
  // report flowing and skip segments until this reader is updated.
  const ledger = config.ledgerPath ?? resolve(process.env.COMPUTAI_DATA_DIR ?? resolve(homedir(), '.local/share/computai'), 'ledger.sqlite');
  const now = Math.floor(Date.now() / 1000);
  const recent = taipeiMidnight(now) - 2 * DAY;
  try {
    const { first } = await readLedger(ledger, now, now);
    const windows = [];
    let from = process.argv.includes('--backfill') && first ? taipeiMidnight(first) : recent;
    while (from <= now) { windows.push([from, Math.min(from + 7 * DAY, now + 1)]); from += 7 * DAY; }
    let total = 0;
    for (const [a, b] of windows) {
      const { rows, machineNames } = await readLedger(ledger, a, b);
      const segments = toSegments(rows, { machineNames, localMachine: config.machineName ?? hostname() })
        .filter((s) => Date.parse(s.start) >= a * 1000 && Date.parse(s.start) < b * 1000);
      await post('/api/ingest/computai/segments', { schemaVersion: 1, deviceId, observedAt: new Date().toISOString(),
        from: new Date(a * 1000).toISOString(), to: new Date(b * 1000).toISOString(), segments });
      total += segments.length;
    }
    console.log(`${new Date().toISOString()} Sent ${total} ComputAI work segments in ${windows.length} window(s)`);
  } catch (error) {
    console.error(`ComputAI segments skipped: ${error.message}`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error) => { console.error(error.message); process.exitCode = 1; });
}
