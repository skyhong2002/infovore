#!/usr/bin/env node
import { readFile, writeFile, rename, mkdir, rm } from 'node:fs/promises';
import { hostname } from 'node:os';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

export function nextDay(day, delta = 1) {
  const date = new Date(`${day}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + delta);
  return date.toISOString().slice(0, 10);
}
function validDay(day) {
  return typeof day === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(day) && Number.isFinite(Date.parse(day)) && new Date(day).toISOString().slice(0, 10) === day;
}
export function unwrap(result) {
  if (result.isError) throw new Error('Dayflow MCP reported an error');
  const value = result.structuredContent ?? JSON.parse(result.content.find((c) => c.type === 'text')?.text ?? 'null');
  if (value?.schema_version !== 1) throw new Error('Unsupported Dayflow MCP schema');
  return value;
}
export async function syncDays({ client, config, state, saveState, post, fullBackfill = false, now = () => new Date() }) {
  const call = async (name, args = {}) => unwrap(await client.callTool({ name, arguments: args }));
  const status = await call('get_status');
  if (status.time_zone !== 'Asia/Taipei' || status.day_boundary_hour !== 4 || !validDay(status.today)) throw new Error('Unexpected Dayflow calendar settings');
  if (!validDay(config.firstDay) || config.firstDay > status.today) throw new Error('firstDay must be a past calendar day');
  const { categories } = await call('list_categories');
  if (!Array.isArray(categories)) throw new Error('Missing Dayflow categories');
  const sync = async (day) => {
    const observedAt = now().toISOString();
    const timeline = await call('get_timeline', { date: day });
    if (timeline.date !== day || timeline.time_zone !== 'Asia/Taipei' || timeline.day_boundary_hour !== 4 || !Array.isArray(timeline.cards)) throw new Error(`Invalid timeline response for ${day}`);
    await post({ schemaVersion: 1, deviceId: config.deviceId, day, observedAt,
      timeZone: 'Asia/Taipei', dayBoundaryHour: 4, categories, cards: timeline.cards });
  };
  let count = 0;
  // Refresh recent days even while a large historical import is still in progress.
  const recentStart = [config.firstDay, nextDay(status.today, -6)].sort().at(-1);
  for (let day = recentStart; day <= status.today; day = nextDay(day)) { await sync(day); count++; }
  let cursor = validDay(state.archiveCursor) && state.archiveCursor >= config.firstDay && state.archiveCursor < recentStart
    ? state.archiveCursor : config.firstDay;
  // Continue an interrupted backfill, then rotate through old history to pick up edits/deletions.
  const budget = fullBackfill ? 10000 : 14;
  for (let n = 0; n < budget && cursor < recentStart; n++) {
    await sync(cursor); count++;
    cursor = nextDay(cursor);
    await saveState({ archiveCursor: cursor });
  }
  return count;
}

async function main() {
  const configPath = resolve(process.argv[2] ?? 'dayflow-sync.json');
  const config = JSON.parse(await readFile(configPath, 'utf8'));
  const base = new URL(config.baseUrl);
  if (base.protocol !== 'https:' && !(base.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(base.hostname))) throw new Error('Use HTTPS for the ingest endpoint');
  if (base.username || base.password || base.search || base.hash || base.pathname !== '/') throw new Error('baseUrl must be an origin');
  if (typeof config.token !== 'string' || config.token.length < 32) throw new Error('A dedicated Dayflow token is required');
  config.deviceId ??= hostname();
  const statePath = resolve(dirname(configPath), 'state.json');
  const lock = resolve(dirname(configPath), 'sync.lock');
  try { await mkdir(lock); } catch (error) {
    if (error.code !== 'EEXIST') throw error;
    let pid;
    try { pid = Number(await readFile(`${lock}/pid`, 'utf8')); } catch { throw new Error('Sync lock exists without a PID; check running jobs before removing it'); }
    if (!Number.isInteger(pid) || pid < 1) throw new Error('Invalid sync lock PID');
    try { process.kill(pid, 0); return; } catch (e) { if (e.code !== 'ESRCH') throw e; }
    await rm(lock, { recursive: true }); await mkdir(lock);
  }
  await writeFile(`${lock}/pid`, String(process.pid), { mode: 0o600 });
  const client = new Client({ name: 'infovore-dayflow-sync', version: '1.0.0' });
  const deadline = setTimeout(() => { console.error('Dayflow sync exceeded 12 minutes'); process.exit(1); }, 12 * 60 * 1000);
  try {
    let state = {};
    try { state = JSON.parse(await readFile(statePath, 'utf8')); } catch (e) { if (e.code !== 'ENOENT') throw e; }
    await client.connect(new StdioClientTransport({ command: config.dayflowCommand ?? '/Applications/Dayflow.app/Contents/Helpers/dayflow', args: ['mcp'], stderr: 'ignore' }));
    const count = await syncDays({ client, config, state, fullBackfill: process.argv.includes('--backfill'),
      saveState: async (value) => {
        await writeFile(`${statePath}.tmp`, JSON.stringify(value), { mode: 0o600 });
        await rename(`${statePath}.tmp`, statePath);
      },
      post: async (batch) => {
        for (let attempt = 0; ; attempt++) {
          try {
            const response = await fetch(new URL('/api/ingest/dayflow/days', base), {
              method: 'POST', headers: { Authorization: `Bearer ${config.token}`, 'Content-Type': 'application/json' },
              body: JSON.stringify(batch), signal: AbortSignal.timeout(30000), redirect: 'error',
            });
            if (!response.ok) {
              if (response.status < 500 && response.status !== 429) throw Object.assign(new Error(`Dayflow ingest rejected ${batch.day}: HTTP ${response.status}`), { permanent: true });
              throw new Error(`Dayflow ingest HTTP ${response.status}`);
            }
            const result = await response.json();
            if (result.ok !== true || result.day !== batch.day) throw Object.assign(new Error('Invalid ingest acknowledgement'), { permanent: true });
            return;
          } catch (error) {
            if (error.permanent || attempt >= 2) throw error;
            await new Promise((r) => setTimeout(r, 1000 * 2 ** attempt));
          }
        }
      },
    });
    console.log(`${new Date().toISOString()} Synced ${count} Dayflow days`);
  } finally { clearTimeout(deadline); await client.close(); await rm(lock, { recursive: true, force: true }); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error) => { console.error(error.message); process.exitCode = 1; });
}
