import assert from 'node:assert/strict';
import test from 'node:test';
import { load } from 'cheerio';
import { Repository } from '../src/data/database.js';
import { platformPage } from '../src/output/platforms.js';
import { app } from '../src/index.js';

const definition = { source: 'phone', title: '手機足跡', description: 'Phone activity', accent: '#8dd3bd', jsonUrl: '/api/phone.json' };

test('phone platform publishes safe aggregates and fixed vocabulary without private prose', () => {
  const repo = new Repository(':memory:');
  try {
    const now = new Date('2026-11-14T12:00:00+08:00');
    const start = +now - 3600000;
    repo.dayflow.phone.saveCards({ deviceId: 'private-device', start, end: start + 1800000, observations: [] }, [
      { start, end: start + 1800000, title: 'YouTube confidentialpineapple', summary: 'privateorange 私人對話', category: 'Learning', apps: ['private-app'] },
    ], 'private-model');
    for (const offset of [1, 2]) {
      const past = start - offset * 86400000;
      repo.dayflow.phone.saveCards({ deviceId: 'private-device', start: past, end: past + 1800000, observations: [] }, [
        { start: past, end: past + 1800000, title: 'YouTube confidentialpineapple', summary: 'privateorange 私人對話', category: 'Learning', apps: ['private-app'] },
      ], 'private-model');
    }
    const snapshot = repo.dayflow.phone.publicSnapshot('Sky', now);
    assert.ok(snapshot.extra.keywordPools?.all.some(k => k.name === 'YouTube'));

    assert.equal(snapshot.source, 'phone');
    assert.equal(snapshot.stats.todayMinutes, 30);
    assert.equal(snapshot.extra.categories[0].name, 'Learning');
    assert.equal(snapshot.extra.daily[0].trackedMinutes, 30);
    assert.ok(snapshot.extra.daily[0].keywords?.some(k => k.name === 'YouTube'));
    const page = platformPage('Sky', definition, snapshot, snapshot.extra.lastSyncedAt);
    assert.match(page, /Categories this week/);
    assert.match(page, /Recent recorded days/);
    assert.match(page, /href="\/phone"/);
    assert.match(page, /href="\/platforms\/phone" aria-current="page"/);
    assert.doesNotMatch(page + JSON.stringify(snapshot), /confidentialpineapple|privateorange|私人對話|private-device|private-app|private-model/);
    assert.doesNotMatch(page, /Computer time|recurring words included|Nothing has been collected/);
    const empty = new Repository(':memory:');
    try {
      const html = platformPage('Sky', definition, empty.dayflow.phone.publicSnapshot('Sky', now), null);
      assert.match(html, /Waiting for the first summarized phone activity/);
    } finally { empty.close(); }
  } finally { repo.close(); }
});

test('phone is integrated into Platforms, canonical URLs, sitemap and public JSON', async () => {
  const response = await app.request('/platforms/phone');
  assert.equal(response.status, 200);
  const $ = load(await response.text());
  assert.equal($('link[rel=canonical]').attr('href'), 'http://localhost:3000/platforms/phone');
  assert.equal($('.platform-nav a[aria-current=page]').attr('href'), '/platforms/phone');
  assert.equal($('.main-nav a[href="/phone"]').length, 0);
  const index = await (await app.request('/platforms')).text();
  assert.match(index, /class="platform-tile" href="\/platforms\/phone"/);
  assert.match(await (await app.request('/sitemap.xml')).text(), /\/platforms\/phone/);
  const json = await app.request('/api/phone.json');
  assert.equal(json.status, 200);
  assert.equal((await json.json() as {source:string}).source, 'phone');
  assert.equal((await app.request('/api/phone/activity')).status, 401);
});
