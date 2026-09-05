import assert from 'node:assert/strict';
import test from 'node:test';
import { syncDays } from '../scripts/dayflow-sync.mjs';
const config = { firstDay: '2026-08-20', deviceId: 'mac' };
const client = { callTool: async ({ name, arguments: args }) => ({ structuredContent: {
  schema_version: 1, time_zone: 'Asia/Taipei', day_boundary_hour: 4,
  ...(name === 'get_status' ? { today: '2026-09-05' } : name === 'list_categories' ? { categories: [] } : { date: args.date, cards: [] }),
} }) };

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
