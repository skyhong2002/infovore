import assert from 'node:assert/strict';
import test from 'node:test';
import { load } from 'cheerio';
import { app, repository } from '../src/index.js';
import { homePage, syncAge, type HomepageData } from '../src/output/home.js';
import { activityMeta, eventStatusLabel } from '../src/output/activity-meta.js';
import { platformSync } from '../src/output/overview.js';
import { publicError, statusPage } from '../src/output/status.js';
import { searchPage } from '../src/output/pages.js';
import { SCROLL_REGION_SCRIPT } from '../src/output/scripts.js';
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
  assert.match(page('tbody tr').last().text(), /Delayed[\s\S]*check that the device app is running/);
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

test('the Time page scope text follows the sources in the table', async () => {
  const { statsPage, TIME_SCOPE } = await import('../src/output/stats.js');
  const w = (n: number) => ({ last24h: n, last28d: n, day: n, week: n, month: n, year: n, allTime: n });
  const render = (sources: string[]) => load(statsPage('Sample', { generatedAt: new Date().toISOString(), measuredTotal: w(1), total: w(sources.length),
    sources: sources.map((source) => ({ source, method: 'measured', windows: w(1) })) } as never));
  const cases: Array<{ sources: string[]; scope: string; absent: RegExp[] }> = [
    { sources: Object.keys(TIME_SCOPE), scope: 'Media platforms (games, shows, anime, books, music, YouTube), manually logged events, exercise from Health and AI agent working time.', absent: [] },
    { sources: ['statsfm', 'backloggd'], scope: 'Media platforms (games, music).', absent: [/manually logged events/, /exercise from Health/, /AI agent/] },
    { sources: ['health', 'events'], scope: 'manually logged events and exercise from Health.', absent: [/Media platforms/, /AI agent/] },
    { sources: ['computai'], scope: 'AI agent working time.', absent: [/Media platforms/, /manually logged events/] },
    { sources: ['youtube', 'futuresource'], scope: 'Media platforms (YouTube) and futuresource.', absent: [/AI agent/] },
  ];
  for (const { sources, scope, absent } of cases) {
    const $ = render(sources);
    const text = $('.page-intro-aside').text();
    assert.ok(text.startsWith(scope), `${sources.join(',')}: ${text}`);
    for (const pattern of absent) assert.doesNotMatch(text, pattern, sources.join(','));
    assert.match(text, /Computer activity \(Dayflow\) and sleep are not in this table/);
    assert.equal(/AI agent time is wall-clock time/.test(text), sources.includes('computai'));
    const rows = $('.time-table tbody td:first-child a').map((_, a) => $(a).attr('href')!.replace('/platforms/', '')).get();
    assert.deepEqual(rows, sources);
    for (const source of rows) assert.ok(text.includes(TIME_SCOPE[source]?.label ?? source), `${source} row is named in the scope text`);
  }
  assert.match(render([])('.page-intro-aside').text(), /^No platform has recorded time yet\. Computer activity/);
});

test('the Time page hides the window picker without JavaScript and marks the default sort', async () => {
  const { statsPage } = await import('../src/output/stats.js');
  const w = (n: number) => ({ last24h: n, last28d: n, day: n, week: n, month: n, year: n, allTime: n });
  const render = (allTimes: number[]) => load(statsPage('Sample', { generatedAt: new Date().toISOString(), measuredTotal: w(1), total: w(9),
    sources: ['statsfm', 'health', 'events'].map((source, index) => ({ source, method: 'measured', windows: { ...w(1), allTime: allTimes[index] } })) } as never));
  const $ = render([30, 20, 10]);
  // Without the script nothing reveals the picker; the script unhides it before wiring it up.
  assert.notEqual($('label.time-window-pick').attr('hidden'), undefined);
  assert.match($('script').text(), /pick\.closest\('label'\)\.hidden = false/);
  // Rows arrive in all-time order, and the heading says so before any click.
  assert.deepEqual($('th[aria-sort]').map((_, th) => [[$(th).text(), $(th).attr('aria-sort')]]).get(), [['All time', 'descending']]);
  // Rows in another order claim no sort.
  assert.equal(render([10, 30, 20])('th[aria-sort]').length, 0);
});

test('the stylesheet keeps a hidden window picker hidden at every width', async () => {
  const css = await (await app.request('/styles.css')).text();
  assert.match(css, /\.time-window-pick\[hidden\]\{display:none!important\}/);
});

test('the API page code block is keyboard scrollable and named, and /status is documented as HTML or JSON', async () => {
  const $ = load(await (await app.request('/api')).text());
  const pre = $('.api-doc pre');
  assert.equal(pre.attr('tabindex'), '0');
  assert.equal(pre.attr('role'), 'region');
  assert.equal($(`#${pre.attr('aria-labelledby')}`).text(), 'Examples');
  const service = $('.table-scroll[aria-labelledby="api-service"] table').text();
  assert.match(service, /\/status\.json[\s\S]*as JSON[\s\S]*\/status[\s\S]*HTML page/);
  assert.match(service, /\/mcpPOST, not GET/);
});

test('every API table scrolls inside its own named, focusable region and stacks on phones', async () => {
  const $ = load(await (await app.request('/api')).text());
  const tables = $('.api-doc table');
  assert.equal(tables.length, 5);
  tables.each((_, table) => {
    const region = $(table).parent();
    assert.ok(region.hasClass('table-scroll'), 'the table sits in a scroll region');
    assert.equal(region.attr('tabindex'), '0');
    assert.equal(region.attr('role'), 'region');
    const heading = $(`#${region.attr('aria-labelledby')}`);
    assert.equal(heading.prop('tagName'), 'H2');
    assert.ok(heading.text().length > 0);
    assert.equal($(table).find('thead th[scope="col"]').length, 2);
  });
  assert.deepEqual(tables.map((_, table) => $(table).parent().attr('aria-labelledby')).get(),
    ['api-activities', 'api-time', 'api-mirrors', 'api-cards', 'api-service']);
  const css = await (await app.request('/styles.css')).text();
  assert.match(css, /\.api-doc \.table-scroll\{max-width:100%;overflow-x:auto/);
  assert.match(css, /@media\(max-width:560px\)\{\.api-doc thead\{clip:rect\(0 0 0 0\)/);
});

test('each /status card names its columns for phones: state, last successful sync, note, data', () => {
  const page = load(statusPage({ ownerName: 'Sample', maxSourceAgeHours: 36, intervalMinutes: 60, nextScheduledAt: null, running: [], now: new Date('2026-11-12T08:00:00Z'),
    sources: [{ source: 'kitsu', lastFetched: '2026-11-12T07:00:00Z', error: null, json: '/api/kitsu.json' },
      { source: 'health', lastFetched: null, error: null, json: '/api/health.json', delayAfterHours: 24 }] }));
  page('tbody tr').each((_, row) => {
    assert.deepEqual(page(row).find('td > .status-label').map((__, label) => page(label).text()).get(),
      ['State', 'Last successful sync', 'Note', 'Data']);
  });
  const css = page('style').text();
  // Hidden where the column headers show; visible (the state chip's read-only) once they are hidden.
  assert.match(css, /\.status-label\{display:none\}@media\(max-width:640px\)\{\.status-label\{[^}]*display:block/);
  assert.match(css, /\.status-table td:nth-child\(2\) \.status-label\{clip:rect\(0 0 0 0\)/);
  assert.doesNotMatch(css, /Raw data/);
});

test('search cards mark their dates up as <time> in GMT+8', () => {
  const activity = (id: string, occurredAt: string, precision: Activity['occurredAtPrecision']): Activity => ({
    id, dedupeKey: id, source: 'kitsu', sourceItemId: id, type: 'library', mediaKind: 'anime', title: `Synthetic ${id}`, image: '',
    status: 'current', occurredAt, occurredAtPrecision: precision, rating: null, visibility: 'public', extra: {},
    firstSeenAt: occurredAt, lastSeenAt: occurredAt,
  });
  const $ = load(searchPage('Sample', { query: 'synthetic', source: '', kind: '' },
    { data: [activity('a', '2026-11-12T15:30:00.000Z', 'exact'), activity('b', '2026-11-10T00:00:00.000Z', 'day')], total: 2, limit: 48, offset: 0 },
    { kitsu: 2 }, []));
  const times = $('.entry-meta time');
  assert.equal(times.length, 2);
  assert.equal(times.eq(0).attr('datetime'), '2026-11-12T15:30:00.000Z');
  // 15:30 UTC is 23:30 in Taipei.
  assert.equal(times.eq(0).text(), 'Nov 12, 2026 · 23:30 GMT+8');
  assert.equal(times.eq(1).text(), 'Nov 10, 2026 GMT+8');
  // The tooltip keeps plain text.
  assert.doesNotMatch($('.entry-meta').first().attr('title') ?? '', /</);
});

test('API scroll regions keep a tab stop only while they actually overflow', async () => {
  const $ = load(await (await app.request('/api')).text());
  // Without JavaScript every region stays focusable and named; the script trims the rest.
  const regions = $('[data-scroll-region]');
  assert.equal(regions.length, 6);
  regions.each((_, region) => assert.equal($(region).attr('data-scroll-region'), $(region).attr('aria-labelledby')));
  assert.ok($('script').toArray().some((script) => $(script).text() === SCROLL_REGION_SCRIPT), 'the page runs the region script');

  // The script itself, on a minimal stand-in DOM: one region that fits, one that overflows.
  const element = (scrollWidth: number, clientWidth: number, id: string) => {
    const attributes = new Map<string, string>([['tabindex', '0'], ['role', 'region'], ['aria-labelledby', id]]);
    return {
      scrollWidth, clientWidth, dataset: { scrollRegion: id }, attributes,
      set tabIndex(value: number) { attributes.set('tabindex', String(value)); },
      setAttribute: (name: string, value: string) => attributes.set(name, value),
      removeAttribute: (name: string) => attributes.delete(name),
    };
  };
  const fits = element(600, 600, 'api-time');
  const overflows = element(900, 320, 'api-activities');
  const focused = element(600, 600, 'api-cards');
  const listeners: string[] = [];
  const document = { querySelectorAll: () => [fits, overflows, focused], activeElement: focused };
  new Function('document', 'addEventListener', SCROLL_REGION_SCRIPT)(document, (type: string) => listeners.push(type));
  assert.deepEqual([...fits.attributes.keys()], []);
  assert.deepEqual(Object.fromEntries(overflows.attributes), { tabindex: '0', role: 'region', 'aria-labelledby': 'api-activities' });
  assert.equal(focused.attributes.get('tabindex'), '0', 'the focused region keeps its tab stop');
  assert.deepEqual(listeners.sort(), ['load', 'resize']);
  // A narrower window that makes the first one overflow gives its tab stop and name back.
  fits.scrollWidth = 900;
  new Function('document', 'addEventListener', SCROLL_REGION_SCRIPT)(document, () => {});
  assert.deepEqual(Object.fromEntries(fits.attributes), { tabindex: '0', role: 'region', 'aria-labelledby': 'api-time' });
});

test('search platform filters separate the name from the count, visibly and for screen readers', async () => {
  const $ = load(searchPage('Sample', { query: '', source: '', kind: '' }, { data: [], total: 0, limit: 48, offset: 0 }, { kitsu: 40, simkl: 1 }, []));
  const chips = $('.search-filters[aria-label="Filter by platform"] a').slice(1);
  assert.deepEqual(chips.map((_, chip) => $(chip).text().replace(/\s+/g, ' ').trim()).get(), ['Kitsu, 40 entries', 'Simkl, 1 entry']);
  assert.equal(chips.first().find('small.chip-count').length, 1);
  const css = await (await app.request('/styles.css')).text();
  assert.match(css, /\.search-filters a\{[^}]*gap:6px/);
  assert.match(css, /\.search-filters \.chip-count\{border-left:1px solid var\(--line\)/);
});

test('a search card clamps its description, never its date', async () => {
  const activity: Activity = {
    id: 'long', dedupeKey: 'long', source: 'kitsu', sourceItemId: 'long', type: 'library', mediaKind: 'anime', title: 'Synthetic long',
    image: '', status: 'completed', occurredAt: '2026-11-12T15:30:00.000Z', occurredAtPrecision: 'exact', rating: null, visibility: 'public',
    extra: { author: 'A very long synthetic author name '.repeat(6) }, firstSeenAt: '2026-11-12T15:30:00.000Z', lastSeenAt: '2026-11-12T15:30:00.000Z',
  };
  const $ = load(searchPage('Sample', { query: 'synthetic', source: '', kind: '' }, { data: [activity], total: 1, limit: 48, offset: 0 }, { kitsu: 1 }, []));
  const meta = $('.entry-meta');
  assert.ok(meta.hasClass('entry-meta-split'));
  assert.match(meta.find('.entry-meta-main').text(), /^Kitsu/);
  assert.equal(meta.find('.entry-date time').text(), 'Nov 12, 2026 · 23:30 GMT+8');
  assert.equal(meta.find('.entry-meta-main time').length, 0);
  const css = await (await app.request('/styles.css')).text();
  assert.match(css, /\.entry-meta\.entry-meta-split\{display:block\}\.entry-meta-main\{display:-webkit-box;-webkit-line-clamp:2/);
  assert.match(css, /\.entry-date\{display:block\}/);
});

test('while searching, platform filters count the matches, not the whole platform', async () => {
  const chipsOf = ($: ReturnType<typeof load>) => $('.search-filters[aria-label="Filter by platform"] a').slice(1)
    .map((_, chip) => $(chip).text().replace(/\s+/g, ' ').trim()).get();
  // Rendering: matching counts (zero included) lead, with "matching" in the accessible name.
  const rendered = load(searchPage('Sample', { query: 'synthetic', source: '', kind: '' }, { data: [], total: 3, limit: 48, offset: 0 },
    { statsfm: 2178, simkl: 321, kitsu: 40 }, [], { kitsu: 2, simkl: 1 }));
  assert.deepEqual(chipsOf(rendered), ['Kitsu, 2 matching entries', 'Simkl, 1 matching entry', 'stats.fm, 0 matching entries']);
  // Without a search the totals stay.
  const idle = load(searchPage('Sample', { query: '', source: '', kind: '' }, { data: [], total: 0, limit: 48, offset: 0 }, { kitsu: 40, simkl: 321 }, []));
  assert.deepEqual(chipsOf(idle), ['Simkl, 321 entries', 'Kitsu, 40 entries']);

  // End to end: the route counts per platform with the query and kind applied, never the platform filter.
  const entry = (source: string, id: string, kind: 'anime' | 'show', title: string) =>
    ({ source, sourceItemId: id, kind, title, image: '', status: 'completed', activityAt: '2026-10-01T12:00:00Z', rating: null, extra: {} });
  repository.ingestEntries([
    entry('kitsu', 'polish-1', 'anime', 'Zephyrine Chronicle'), entry('kitsu', 'polish-2', 'anime', 'Zephyrine Chronicle II'),
    entry('kitsu', 'polish-3', 'anime', 'Unrelated'), entry('simkl', 'polish-4', 'show', 'Zephyrine Nights'),
    entry('simkl', 'polish-5', 'show', 'Other show'), entry('simkl', 'polish-6', 'show', 'Another show'),
  ] as never, '2026-10-01T13:00:00Z');
  const page = async (path: string) => load(await (await app.request(path)).text());
  const totals = chipsOf(await page('/search'));
  assert.ok(totals.includes('Simkl, 3 entries') && totals.includes('Kitsu, 3 entries'), totals.join(' | '));

  const searched = await page('/search?q=zephyrine');
  assert.deepEqual(chipsOf(searched).slice(0, 2), ['Kitsu, 2 matching entries', 'Simkl, 1 matching entry']);
  assert.match(searched('.page-intro-aside').text(), /^3 matching entries of/);
  // Choosing a platform keeps the other platforms' counts (they say what switching would show).
  const onKitsu = await page('/search?q=zephyrine&source=kitsu');
  assert.deepEqual(chipsOf(onKitsu).slice(0, 2), ['Kitsu, 2 matching entries', 'Simkl, 1 matching entry']);
  assert.equal(onKitsu('.search-filters a[aria-current="true"]').first().text().replace(/\s+/g, ' ').trim(), 'Kitsu, 2 matching entries');
  // Another selected filter (kind) narrows the counts too.
  const shows = await page('/search?q=zephyrine&kind=show');
  assert.deepEqual(chipsOf(shows).slice(0, 2), ['Simkl, 1 matching entry', 'Kitsu, 0 matching entries']);
});

test('the API page opens with jump links to every section, clear of the sticky header', async () => {
  const $ = load(await (await app.request('/api')).text());
  const links = $('nav.api-toc[aria-label="On this page"] a');
  assert.deepEqual(links.map((_, link) => $(link).text()).get(), ['Activities', 'Time', 'Platform mirrors', 'Cards', 'Service', 'Examples']);
  links.each((_, link) => {
    const id = ($(link).attr('href') ?? '').slice(1);
    assert.equal($(`h2#${id}`).length, 1, id);
  });
  // Before the long tables, right after the intro.
  assert.ok($('.api-doc > .page-intro').next().is('nav.api-toc'));
  assert.match($('style').text(), /\.api-doc h2\[id\]\{scroll-margin-top:84px\}/);
});
