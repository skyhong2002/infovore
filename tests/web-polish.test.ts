import assert from 'node:assert/strict';
import test from 'node:test';
import { load } from 'cheerio';
import { app } from '../src/index.js';
import { homePage, syncAge, type HomepageData } from '../src/output/home.js';
import { activityMeta, eventStatusLabel } from '../src/output/activity-meta.js';
import { platformSync } from '../src/output/overview.js';
import { publicError, statusPage } from '../src/output/status.js';
import type { Activity } from '../src/data/types.js';

const base: HomepageData = {
  ownerName: 'Sample Owner', avatar: '', lastUpdated: 'Nov 12, 16:42 GMT+8', allActivities: [], recentActivities: [],
  platformOverviews: [], timeSpent: null, publicActivityCount: 48845, connectedSources: 2,
};

test('headings and metric labels keep clean text; notes are separate keyboard tooltips', () => {
  const $ = load(homePage({ ...base, cloudTerms: [{ label: 'Synthetic', source: 'kitsu', kind: 'anime', count: 2, weight: 3 } as never] }));
  $('h2').each((_, h2) => assert.doesNotMatch($(h2).text(), /i$/, `heading "${$(h2).text()}"`));
  assert.equal($('h2 .info, h2 button').length, 0);
  assert.equal($('.home-metric-label').filter((_, el) => /i$/i.test($(el).text())).length, 0);
  const buttons = $('button.info');
  assert.ok(buttons.length >= 3);
  buttons.each((_, button) => {
    const tip = $(`#${$(button).attr('aria-controls')}`);
    assert.equal(tip.attr('role'), 'tooltip');
    assert.equal($(button).attr('aria-describedby'), tip.attr('id'));
    assert.ok(tip.text().length > 10);
    assert.equal($(button).text(), '');
  });
  // No button nested in a link (invalid interactive nesting).
  assert.equal($('a button, a .info').length, 0);
  assert.equal($('.skip-link').attr('href'), '#main');
  assert.equal($('main#main').length, 1);
});

test('public entries use thousands separators and the share bar legend covers every platform', () => {
  const sources = ['kitsu', 'simkl', 'youtube'].map((source, index) => ({ source, method: 'measured' as const,
    windows: { last24h: 0, last28d: [90_000, 3_000, 200][index], day: 0, week: 0, month: 0, year: 0, allTime: 100_000 } }));
  const $ = load(homePage({ ...base, timeSpent: { sources, total: {} } as never }));
  assert.match($('.home-metric').text(), /48,845/);
  assert.equal($('.share-track a').length, 0);
  assert.equal($('.share-track').attr('aria-hidden'), 'true');
  assert.deepEqual($('.share-legend a').map((_, a) => $(a).attr('href')).get(), ['/platforms/kitsu', '/platforms/simkl', '/platforms/youtube']);
  assert.match($('.share-legend').text(), /<1%/);
  assert.match($('.home-metric').text(), /overlaps counted once/);
});

test('platform tiles show their own sync state, separate from the newest sync', () => {
  const now = new Date('2026-11-12T08:00:00Z');
  assert.deepEqual(platformSync(Date.parse('2026-11-12T07:30:00Z'), 36, now), { state: 'fresh', at: '2026-11-12T07:30:00.000Z' });
  assert.equal(platformSync('2026-11-09T07:30:00Z', 36, now).state, 'stale');
  assert.equal(platformSync(null, 36, now).state, 'never');
  assert.equal(syncAge('2026-11-12T07:25:00Z', now), '35 min ago');
  const $ = load(homePage({ ...base, platformOverviews: [
    { source: 'kitsu', image: '', title: 'A', detail: 'B', sync: { state: 'fresh', at: new Date().toISOString() } },
    { source: 'simkl', image: '', title: 'C', detail: 'D', sync: { state: 'stale', at: '2026-01-01T00:00:00Z' } },
  ] }));
  assert.match($('a[href="/platforms/kitsu"] .home-platform-sync').text(), /^Synced /);
  assert.match($('a[href="/platforms/simkl"] .home-platform-sync').text(), /Sync delayed · last good data/);
  assert.match($('.home-status-sub').text(), /1 platform is showing older data/);
});

test('past upcoming events read as date passed without claiming attendance', () => {
  const event = { id: 'e1', source: 'events', title: 'Synthetic concert', status: 'ticketed', occurredAt: '2026-07-01T11:00:00Z',
    firstSeenAt: '2026-06-01T00:00:00Z', mediaKind: 'event', image: '', extra: {}, rating: null } as unknown as Activity;
  const now = new Date('2026-11-12T00:00:00Z');
  assert.equal(eventStatusLabel(event, now), 'date passed · was ticketed');
  assert.match(activityMeta(event, now), /date passed/);
  assert.doesNotMatch(activityMeta(event, now), /attended/);
  assert.equal(eventStatusLabel({ ...event, occurredAt: '2026-12-01T11:00:00Z' }, now), null);
  assert.equal(eventStatusLabel({ ...event, status: 'attended' }, now), null);
});

test('public status redacts upstream URLs and has a readable page; scripts keep JSON', async () => {
  assert.equal(publicError('goodreads: HTTP 404 for https://example.com/user/show/123-someone'), 'goodreads: HTTP 404 for [link removed]');
  const page = load(statusPage({ ownerName: 'Sample', maxSourceAgeHours: 36, intervalMinutes: 60, nextScheduledAt: null, running: [], now: new Date('2026-11-12T08:00:00Z'),
    sources: [{ source: 'kitsu', lastFetched: '2026-11-12T07:00:00Z', error: null, json: '/api/kitsu.json' },
      { source: 'simkl', lastFetched: '2026-11-01T07:00:00Z', error: 'HTTP 500 for [link removed]', json: '/api/simkl.json' }] }));
  assert.equal(page('h1').text(), 'Sync status');
  assert.match(page('tbody').text(), /Fresh/);
  assert.match(page('tbody').text(), /Delayed[\s\S]*HTTP 500/);
  assert.doesNotMatch(page.html(), /link removed/);
  const json = await app.request('/status');
  assert.match(json.headers.get('content-type') ?? '', /json/);
  const htmlResponse = await app.request('/status', { headers: { accept: 'text/html' } });
  assert.match(htmlResponse.headers.get('content-type') ?? '', /html/);
  assert.match(await htmlResponse.text(), /Sync status/);
  assert.match((await app.request('/status.json')).headers.get('content-type') ?? '', /json/);
});

test('unknown pages are navigable for browsers and plain for scripts', async () => {
  const browser = await app.request('/no-such-page', { headers: { accept: 'text/html' } });
  assert.equal(browser.status, 404);
  const $ = load(await browser.text());
  assert.equal($('h1').text(), 'Nothing here');
  assert.ok($('a[href="/search"]').length > 0);
  const script = await app.request('/no-such-page');
  assert.equal(script.status, 404);
  assert.equal(await script.text(), '404 Not Found');
});

test('device-pushed sources explain where their errors are reported', () => {
  const page = load(statusPage({ ownerName: 'Sample', maxSourceAgeHours: 36, intervalMinutes: 60, nextScheduledAt: null, running: [], now: new Date('2026-11-12T08:00:00Z'),
    sources: [{ source: 'health', lastFetched: '2026-11-12T07:00:00Z', error: null, json: '/api/health.json' },
      { source: 'dayflow', lastFetched: '2026-11-08T07:00:00Z', error: null, json: '/api/dayflow.json' }] }));
  assert.match(page('tbody tr').first().text(), /pushed from a device/);
  assert.match(page('tbody tr').last().text(), /Delayed[\s\S]*check the device app/);
  assert.match(page('.feed-note').text(), /Phone screen activity is not listed/);
});

test('responses carry baseline security headers and search states its coverage', async () => {
  const response = await app.request('/search');
  assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(response.headers.get('referrer-policy'), 'strict-origin-when-cross-origin');
  assert.equal(response.headers.get('x-frame-options'), 'SAMEORIGIN');
  const $ = load(await response.text());
  assert.match($('.page-intro-aside').text(), /searchable entries[\s\S]*YouTube watches, health, Dayflow and AI agent records/);
});

test('the Time page scope text names what the table includes and excludes', async () => {
  const { statsPage } = await import('../src/output/stats.js');
  const w = (n: number) => ({ last24h: n, last28d: n, day: n, week: n, month: n, year: n, allTime: n });
  const $ = load(statsPage('Sample', { generatedAt: new Date().toISOString(), measuredTotal: w(1), total: w(4),
    sources: ['kitsu', 'events', 'health', 'computai'].map((source) => ({ source, method: 'measured', windows: w(1) })) } as never));
  const scope = $('.page-intro-aside').text();
  for (const included of ['Media platforms', 'manually logged events', 'exercise from Health', 'AI agent']) assert.match(scope, new RegExp(included));
  assert.match(scope, /Dayflow\) and sleep are not in this table/);
  assert.deepEqual($('.time-table tbody td:first-child a').map((_, a) => $(a).attr('href')).get(), ['/platforms/kitsu', '/platforms/events', '/platforms/health', '/platforms/computai']);
  assert.equal($('#time-window option[value="delta"]').length, 1);
});
