import test from 'node:test';
import assert from 'node:assert/strict';
import { app, repository } from '../src/index.js';
import { recordedCoverage } from '../src/data/coverage.js';
import { dayflowDay, type DayflowBatch } from '../src/dayflow/types.js';
import { buildRhythmCard } from '../src/output/rhythm.js';
import { rasterize } from '../src/output/render.js';

test('rhythm card renders seven days, Dayflow orange, and an empty week', async () => {
  const now = new Date('2026-09-06T12:00:00+08:00');
  const days = recordedCoverage([{ source: 'dayflow', start: +now - 3600000, end: +now }], now);
  const svg = await buildRhythmCard('Sky', days);
  assert.match(svg, /width="520"/);
  assert.match(svg, /#f59b45/);
  const png = await rasterize(svg, 'png', 1);
  assert.equal(png.readUInt32BE(16), 520);
  assert.ok(png.readUInt32BE(20) > 450);
  assert.ok(png.readUInt32BE(20) < 850);
  assert.match(await buildRhythmCard('Sky', recordedCoverage([], now)), /<svg/);
});

test('rhythm card routes share cache, expose formats and refresh after Dayflow ingestion', async () => {
  const before = await app.request('/card/activity-rhythm.svg');
  assert.equal(before.status, 200);
  const etag = before.headers.get('etag')!;
  assert.equal((await app.request('/card/activity-rhythm.svg', { headers: { 'if-none-match': etag } })).status, 304);
  const now = new Date(), start = new Date(+now - 1200000), end = new Date(+now - 1140000);
  const batch: DayflowBatch = { schemaVersion: 1, deviceId: 'rhythm-test', day: dayflowDay(start),
    observedAt: now.toISOString(), timeZone: 'Asia/Taipei', dayBoundaryHour: 4, categories: [],
    cards: [{ record_id: 1, start: start.toISOString(), end: end.toISOString(), title: 'PRIVATE NARRATIVE',
      category: 'Work', duration_minutes: 1 }] };
  repository.dayflow.ingest(batch);
  const after = await app.request('/card/activity-rhythm.svg');
  assert.equal(after.status, 200);
  assert.notEqual(after.headers.get('etag'), etag);
  assert.doesNotMatch(await after.text(), /PRIVATE NARRATIVE|rhythm-test/);
  for (const format of ['png', 'webp']) {
    const response = await app.request(`/card/activity-rhythm.${format}?scale=1`);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('content-type'), `image/${format}`);
  }
  assert.match(await (await app.request('/cards')).text(), /activity-rhythm.webp/);
  assert.match(await (await app.request('/')).text(), /href="\/card\/activity-rhythm.svg"/);
});
