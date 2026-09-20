import assert from 'node:assert/strict';
import test from 'node:test';
import { execFile } from 'node:child_process';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { syncDays } from '../scripts/dayflow-sync.mjs';
const config = { firstDay: '2026-08-20', deviceId: 'mac' };
const client = { callTool: async ({ name, arguments: args }) => ({ structuredContent: {
  schema_version: 1, time_zone: 'Asia/Taipei', day_boundary_hour: 4,
  ...(name === 'get_status' ? { today: '2026-09-05' } : name === 'list_categories' ? { categories: [] } : { date: args.date, cards: [] }),
} }) };

test('CLI sync keeps the helper on the Taipei calendar while the Mac is abroad', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'dayflow-timezone-'));
  const uploads = [];
  const server = createServer(async (request, response) => {
    let body = '';
    for await (const chunk of request) body += chunk;
    const batch = JSON.parse(body);
    uploads.push(batch);
    response.setHeader('Content-Type', 'application/json');
    response.end(JSON.stringify({ ok: true, day: batch.day }));
  });
  try {
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const helperPath = join(directory, 'dayflow.cjs');
    // A real child process reports its timezone, just like the native helper.
    await writeFile(helperPath, `#!${process.execPath}
require('node:readline').createInterface({ input: process.stdin }).on('line', line => {
  const message = JSON.parse(line);
  if (message.id === undefined) return;
  let result;
  if (message.method === 'initialize') {
    result = { protocolVersion: message.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'fixture', version: '1' } };
  } else {
    const value = { schema_version: 1, time_zone: Intl.DateTimeFormat().resolvedOptions().timeZone, day_boundary_hour: 4 };
    if (message.params.name === 'get_status') value.today = '2026-09-05';
    else if (message.params.name === 'list_categories') value.categories = [];
    else Object.assign(value, { date: message.params.arguments.date, cards: [] });
    result = { content: [{ type: 'text', text: JSON.stringify(value) }] };
  }
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }) + '\\n');
});
`, { mode: 0o700 });
    const configPath = join(directory, 'config.json');
    await writeFile(configPath, JSON.stringify({ firstDay: '2026-09-05', deviceId: 'test-mac',
      baseUrl: `http://127.0.0.1:${server.address().port}`, token: 'test-dayflow-token-with-at-least-32-characters', dayflowCommand: helperPath }));
    const { stdout } = await promisify(execFile)(process.execPath,
      [fileURLToPath(new URL('../scripts/dayflow-sync.mjs', import.meta.url)), configPath],
      { env: { ...process.env, TZ: 'Asia/Seoul' }, timeout: 15000 });
    assert.match(stdout, /Synced 1 Dayflow days/);
    assert.equal(uploads.length, 1);
    assert.equal(uploads[0].day, '2026-09-05');
    assert.equal(uploads[0].timeZone, 'Asia/Taipei');
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await rm(directory, { recursive: true, force: true });
  }
});

test('sync refreshes recent dates and checkpoints only acknowledged history, including empty days', async () => {
  const days = [], checkpoints = [];
  await assert.rejects(syncDays({ client, config, state: {}, saveState: async (s) => checkpoints.push(s.archiveCursor),
    post: async (batch) => { if (batch.day === '2026-08-22') throw new Error('offline'); days.push(batch.day); } }), /offline/);
  assert.deepEqual(days.slice(0, 7), ['2026-08-30','2026-08-31','2026-09-01','2026-09-02','2026-09-03','2026-09-04','2026-09-05']);
  assert.deepEqual(checkpoints, ['2026-08-21', '2026-08-22']);
  const resumed = [];
  await syncDays({ client, config, state: { archiveCursor: checkpoints.at(-1) }, saveState: async () => {}, post: async (b) => resumed.push(b.day) });
  assert.equal(resumed[7], '2026-08-22');
});

test('MCP failures and wrong dates never upload an empty replacement', async () => {
  for (const result of [{ isError: true }, { structuredContent: { schema_version: 2 } }, { structuredContent: { schema_version: 1, date: 'wrong', cards: [] } }]) {
    let uploaded = false;
    const badClient = { callTool: async (args) => args.name === 'get_timeline' ? result : client.callTool(args) };
    await assert.rejects(syncDays({ client: badClient, config, state: {}, saveState: async () => {}, post: async () => { uploaded = true; } }));
    assert.equal(uploaded, false);
  }
});
