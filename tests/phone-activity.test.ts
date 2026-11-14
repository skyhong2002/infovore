import assert from 'node:assert/strict';
import test from 'node:test';
import { Hono } from 'hono';
import { Repository } from '../src/data/database.js';
import { phoneActivityRoute } from '../src/dayflow/phone-routes.js';
import { phonePage, phoneScript } from '../src/output/phone.js';
import { createIngestApp } from '../src/ingest.js';

type Activity = ReturnType<Repository['dayflow']['phone']['activity']>;
const token = 'test-dayflow-phone-token-with-at-least-32-chars';
test('owner timeline authenticates, scopes devices, clips at 4am, and never serves raw captures', async () => {
  const repo = new Repository(':memory:');
  try {
    const app = new Hono();
    phoneActivityRoute(app, '/api/phone/activity', repo.dayflow.phone, token);
    const base = Date.parse('2026-11-12T03:55:00+08:00');
    for (const deviceId of ['pixel', 'other']) {
      repo.dayflow.phone.ingest({ schemaVersion: 1, deviceId, observations: [{ id: 'private-obs-123', capturedAt: new Date(base).toISOString(), package: 'com.private', appLabel: 'Private app', text: 'RAW SECRET', blocked: false }] });
      repo.dayflow.phone.saveCards({ deviceId, start: base, end: base + 10 * 60000, observations: [] }, [
        { start: base, end: base + 10 * 60000, title: 'Private title '+deviceId, summary: '<img src=x onerror=alert(1)>', category: 'Learning', apps: ['Reader'] },
      ], 'test-model');
    }
    for (const authorization of ['', token, 'Bearer desktop-token-with-at-least-32-characters', 'Bearer nope']) {
      const res = await app.request('/api/phone/activity', { headers: { authorization } });
      assert.equal(res.status, 401);
      assert.equal(res.headers.get('cache-control'), 'no-store');
      assert.doesNotMatch(await res.text(), /Private title|RAW SECRET/);
    }
    const read = (query: string) => app.request('/api/phone/activity'+query, { headers: { authorization: 'Bearer '+token } });
    const response = await read('?day=2026-11-12&deviceId=pixel');
    assert.equal(response.headers.get('vary'), 'Authorization');
    assert.equal(response.headers.get('x-robots-tag'), 'noindex, nofollow');
    const data = await response.json() as Activity;
    assert.equal(data.cards.length, 1);
    assert.equal(data.cards[0].title, 'Private title pixel');
    assert.equal(data.cards[0].startAt, '2026-11-11T20:00:00.000Z');
    assert.equal(data.categories.find((c: {name: string}) => c.name === 'Learning')!.minutes, 5);
    assert.equal(data.status.pending, 1);
    assert.doesNotMatch(JSON.stringify(data), /RAW SECRET|com.private|private-obs-123|deviceId|test-model/);
    const previous = await (await read('?day=2026-11-11&deviceId=pixel')).json() as Activity;
    assert.equal(previous.cards[0].endAt, '2026-11-11T20:00:00.000Z');
    assert.equal((await (await read('?day=2026-11-12')).json() as Activity).cards.length, 2);
    assert.equal((await (await read('?day=2026-11-12&deviceId=missing')).json() as Activity).status.pending, 0);
    for (const query of ['?day=2026-02-30', '?day=not-a-date', '?deviceId=bad%27', '?day=2026-13-01']) assert.equal((await read(query)).status, 400);
    const ingest = createIngestApp(repo);
    assert.equal((await ingest.request('/api/ingest/dayflow-phone/activity?day=2026-11-12', {headers:{authorization:'Bearer '+token}})).status, 200);
    assert.equal((await ingest.request('/api/ingest/dayflow-phone/activity')).status, 401);
    assert.doesNotMatch(phonePage(), /Private title|RAW SECRET|test-dayflow-phone-token/);
    assert.match(phonePage(), /src="\/phone.js"/);
    assert.match(phoneScript, /textContent = value/);
    assert.doesNotMatch(phoneScript, /innerHTML|localStorage|sessionStorage/);
  } finally { repo.close(); }
});

test('phone dashboard shares Dayflow aggregates, separates devices, clips days and excludes future time', async () => {
  const repo = new Repository(':memory:');
  try {
    const start = Date.parse('2026-11-12T03:55:00+08:00');
    for (const deviceId of ['pixel', 'other']) {
      repo.dayflow.phone.saveCards({deviceId, start, end:start+10*60000, observations:[]}, [
        {start,end:start+10*60000,title:'YouTube 口琴教學',summary:'學習口琴',category:'Learning',apps:['YouTube']},
        {start:start+20*60000,end:start+30*60000,title:'Idle',summary:'',category:'Idle',apps:[]},
      ], 'test-model');
    }
    const now = new Date('2026-11-12T04:20:00+08:00');
    const overview = repo.dayflow.phone.overview('pixel', now);
    assert.equal(overview.stats.recordedDays, 2);
    assert.equal(overview.stats.todayMinutes, 10, '5 min learning + 5 min idle before now');
    assert.equal(overview.extra.daily.find(d=>d.day==='2026-11-12')?.activeMinutes, 5);
    assert.equal(overview.extra.daily.find(d=>d.day==='2026-11-11')?.trackedMinutes, 5);
    assert.equal(overview.extra.categories.find(c=>c.name==='Learning')?.minutes, 10);
    assert.equal(overview.extra.keywordMode, 'local');
    assert.equal(overview.extra.keywordPools.status, 'insufficient_history');
    assert.equal(repo.dayflow.phone.overview('missing', now).stats.recordedDays, 0);
    repo.dayflow.phone.saveCards({deviceId:'future',start:+now+60000,end:+now+120000,observations:[]},[
      {start:+now+60000,end:+now+120000,title:'Future activity',summary:'',category:'Work',apps:[]},
    ],null);
    assert.equal(repo.dayflow.phone.overview('future',now).stats.recordedDays,0);
    assert.doesNotMatch(JSON.stringify(overview), /deviceId|test-model|observations|image/);
    const app = new Hono();
    phoneActivityRoute(app, '/activity', repo.dayflow.phone, token);
    assert.equal((await app.request('/activity?overview=1')).status,401);
    const response = await app.request('/activity?overview=1&deviceId=pixel', {headers:{authorization:'Bearer '+token}});
    assert.equal(response.status,200);
    assert.ok('overview' in (await response.json() as object));
  } finally {repo.close();}
});
