import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { load, type CheerioAPI } from 'cheerio';
import type { AnyNode } from 'domhandler';
import { app } from '../src/index.js';
import { INLINE_SCRIPTS, TIME_TABLE_SCRIPT } from '../src/output/scripts.js';
import { scriptHash, securityHeaders } from '../src/security-headers.js';

const csp = securityHeaders['Content-Security-Policy']!;
const scriptSrc = csp.split(';').map((part) => part.trim()).find((part) => part.startsWith('script-src '))!;

test('script-src allows inline scripts by hash only, and still the Cloudflare beacon', () => {
  assert.ok(scriptSrc, csp);
  assert.doesNotMatch(scriptSrc, /'unsafe-inline'|'unsafe-eval'/);
  assert.match(scriptSrc, /https:\/\/static\.cloudflareinsights\.com/);
  assert.match(csp, /connect-src 'self' https:\/\/cloudflareinsights\.com/);
  // Styles may stay inline.
  assert.match(csp, /style-src 'self' 'unsafe-inline'/);
  for (const body of INLINE_SCRIPTS) assert.ok(scriptSrc.includes(scriptHash(body)));
  // The hash is the standard CSP form: base64 SHA-256 of the script text.
  assert.equal(scriptHash('alert(1)'), `'sha256-${createHash('sha256').update('alert(1)').digest('base64')}'`);
});

// Every HTML page the site links to from its main pages (one level deep), plus the 404 page.
async function htmlPages(): Promise<Map<string, { csp: string | null; html: string }>> {
  const pages = new Map<string, { csp: string | null; html: string }>();
  const fetchPage = async (path: string) => {
    if (pages.has(path)) return null;
    const response = await app.request(path, { headers: { accept: 'text/html' } });
    if (!/^text\/html/.test(response.headers.get('content-type') ?? '')) return null;
    const html = await response.text();
    pages.set(path, { csp: response.headers.get('content-security-policy'), html });
    return html;
  };
  const seeds = ['/', '/now', '/stats', '/platforms', '/profile', '/cards', '/search', '/search?q=fixture', '/api', '/status', '/no-such-page'];
  const linked = new Set<string>();
  for (const seed of seeds) {
    const html = await fetchPage(seed);
    if (!html) continue;
    const $ = load(html);
    $('a[href^="/"]').each((_, a) => {
      const href = $(a).attr('href')!.split('#')[0]!;
      if (href && !href.startsWith('//') && !/\.(json|svg|webp|png|xml|txt|css)(\?|$)/.test(href)) linked.add(href);
    });
  }
  for (const path of [...linked].slice(0, 120)) await fetchPage(path);
  return pages;
}

test('every inline script on every page is covered by the CSP, and no page uses inline handlers', async () => {
  const pages = await htmlPages();
  assert.ok(pages.size >= 10, `only ${pages.size} pages`);
  assert.ok([...pages.keys()].some((path) => path.startsWith('/platforms/')), 'platform pages are crawled');
  const seen = new Set<string>();
  for (const [path, page] of pages) {
    assert.equal(page.csp, csp, `${path} sends the CSP`);
    const $ = load(page.html);
    $('script').each((_, script) => {
      const element = $(script);
      if (element.attr('src')) return;
      const body = element.html() ?? '';
      seen.add(body);
      assert.ok(scriptSrc.includes(scriptHash(body)), `${path}: inline script not in the CSP: ${body.slice(0, 80)}`);
    });
    // Inline event handlers and javascript: URLs cannot be allowed by hash; none may exist.
    $('*').each((_, node) => {
      for (const name of Object.keys((node as { attribs?: Record<string, string> }).attribs ?? {})) {
        assert.ok(!/^on/i.test(name), `${path}: inline handler ${name}`);
      }
    });
    assert.doesNotMatch(page.html, /href="javascript:/i, path);
  }
  // The Time table (and its script) only renders with recorded time, which the test database lacks.
  const withData = load(timeTableHtml());
  withData('script').each((_, script) => {
    const body = withData(script).html() ?? '';
    seen.add(body);
    assert.ok(scriptSrc.includes(scriptHash(body)), `/stats with data: inline script not in the CSP: ${body.slice(0, 80)}`);
  });
  // Together they reach every script the site defines (so none is dead or untested).
  for (const body of INLINE_SCRIPTS) assert.ok(seen.has(body), `never served: ${body.slice(0, 60)}`);
});

// ---------------------------------------------------------------------------
// A minimal DOM, just enough to run the Time table script on server-rendered HTML.

type Listener = (event: { target: FakeElement }) => void;

class FakeText {
  parent: FakeElement | null = null;
  constructor(public text: string) {}
}

class FakeElement {
  attrs: Record<string, string>;
  children: FakeNode[] = [];
  parent: FakeElement | null = null;
  listeners = new Map<string, Listener[]>();
  value = '';
  hidden: boolean;
  scrollWidth = 0;
  clientWidth = 0;
  scrollLeft = 0;
  private classes: Set<string>;
  constructor(readonly tagName: string, attrs: Record<string, string> = {}) {
    this.attrs = { ...attrs };
    this.classes = new Set((attrs.class ?? '').split(/\s+/).filter(Boolean));
    this.hidden = 'hidden' in attrs;
  }
  get classList() {
    return {
      toggle: (name: string, force?: boolean) => { const on = force ?? !this.classes.has(name); if (on) this.classes.add(name); else this.classes.delete(name); return on; },
      contains: (name: string) => this.classes.has(name),
      add: (name: string) => { this.classes.add(name); },
    };
  }
  get dataset(): Record<string, string | undefined> {
    return Object.fromEntries(Object.entries(this.attrs).filter(([name]) => name.startsWith('data-')).map(([name, value]) => [name.slice(5), value]));
  }
  get textContent(): string { return this.children.map((child) => child instanceof FakeElement ? child.textContent : child.text).join(''); }
  set textContent(text: string) { this.children = []; this.appendChild(new FakeText(text)); }
  get childNodes(): FakeNode[] { return [...this.children]; }
  get id() { return this.attrs.id; }
  getAttribute(name: string) { return this.attrs[name] ?? null; }
  setAttribute(name: string, value: string) { this.attrs[name] = value; }
  removeAttribute(name: string) { delete this.attrs[name]; }
  hasAttribute(name: string) { return name in this.attrs; }
  set type(value: string) { this.attrs.type = value; }
  set className(value: string) { this.attrs.class = value; this.classes = new Set(value.split(/\s+/)); }
  append(...nodes: FakeNode[]) { for (const node of nodes) this.appendChild(node); }
  appendChild(node: FakeNode) {
    if (node.parent) node.parent.children = node.parent.children.filter((child) => child !== node);
    node.parent = this;
    this.children.push(node);
    return node;
  }
  addEventListener(type: string, listener: Listener) { this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]); }
  dispatch(type: string) { for (const listener of this.listeners.get(type) ?? []) listener({ target: this }); }
  matches(selector: string): boolean {
    return selector.split(',').some((one) => {
      const m = /^([a-z]*)((?:[.#][\w-]+)*)(?:\[([\w-]+)\])?$/.exec(one.trim());
      if (!m) throw new Error(`fake DOM: unsupported selector ${one}`);
      const [, tag, rest, attr] = m;
      if (tag && tag !== this.tagName) return false;
      if (attr && !(attr in this.attrs)) return false;
      for (const part of rest!.match(/[.#][\w-]+/g) ?? []) {
        if (part[0] === '.' && !this.classes.has(part.slice(1))) return false;
        if (part[0] === '#' && this.attrs.id !== part.slice(1)) return false;
      }
      return true;
    });
  }
  closest(selector: string): FakeElement | null {
    for (let node: FakeElement | null = this; node; node = node.parent) if (node.matches(selector)) return node;
    return null;
  }
  querySelectorAll(selector: string): FakeElement[] {
    const found: FakeElement[] = [];
    const walk = (node: FakeElement) => {
      for (const child of node.children) {
        if (!(child instanceof FakeElement)) continue;
        if (child.matches(selector)) found.push(child);
        walk(child);
      }
    };
    walk(this);
    return found;
  }
  querySelector(selector: string) { return this.querySelectorAll(selector)[0] ?? null; }
  get rows(): FakeElement[] { return this.querySelectorAll('tr'); }
  get cells(): FakeElement[] { return this.children.filter((child): child is FakeElement => child instanceof FakeElement && (child.tagName === 'td' || child.tagName === 'th')); }
  get tBodies(): FakeElement[] { return this.querySelectorAll('tbody'); }
}
type FakeNode = FakeElement | FakeText;

function fakeDocument($: CheerioAPI) {
  const convert = (node: AnyNode): FakeNode | null => {
    if (node.type === 'text') return new FakeText((node as unknown as { data: string }).data);
    if (node.type !== 'tag' && node.type !== 'script') return null;
    const element = node as unknown as { name: string; attribs: Record<string, string>; children: AnyNode[] };
    const fake = new FakeElement(element.name, element.attribs);
    for (const child of element.children) { const converted = convert(child); if (converted) fake.appendChild(converted); }
    if (element.name === 'select') fake.value = (fake.querySelector('option[selected]') ?? fake.querySelector('option'))!.attrs.value!;
    return fake;
  };
  const root = convert($('body')[0]!) as FakeElement;
  return {
    root,
    document: {
      querySelector: (selector: string) => root.querySelector(selector),
      getElementById: (id: string) => root.querySelectorAll(`#${id}`)[0] ?? null,
      createElement: (tag: string) => new FakeElement(tag),
    },
  };
}

function timeTableHtml(): string {
  const { statsPage } = require_stats;
  const w = (n: number) => ({ last24h: n, last28d: n, day: n, week: n, month: n, year: n, allTime: n });
  // All-time order: statsfm, health, events. Last-28-days order: events, health, statsfm.
  const sources = [
    { source: 'statsfm', method: 'measured', windows: { ...w(1), allTime: 300, last28d: 10 } },
    { source: 'health', method: 'measured', windows: { ...w(1), allTime: 200, last28d: 20 } },
    { source: 'events', method: 'measured', windows: { ...w(1), allTime: 100, last28d: 30 } },
  ];
  const daily = { days: Array.from({ length: 14 }, (_, i) => `2026-11-${String(i + 1).padStart(2, '0')}`), sources: {
    statsfm: Array(14).fill(1), health: [...Array(7).fill(0), ...Array(7).fill(5)], events: [...Array(7).fill(9), ...Array(7).fill(0)],
  } };
  return statsPage('Sample', { generatedAt: new Date().toISOString(), measuredTotal: w(1), total: w(9), sources } as never, daily as never);
}

function runTimeTable(narrowScreen: boolean) {
  const { root, document } = fakeDocument(load(timeTableHtml()));
  const media = { matches: narrowScreen, listeners: [] as Array<() => void>, addEventListener(_: string, listener: () => void) { this.listeners.push(listener); } };
  new Function('document', 'matchMedia', 'addEventListener', TIME_TABLE_SCRIPT)(document, () => media, () => {});
  const table = root.querySelector('.time-table')!;
  const order = () => table.tBodies[0]!.rows.map((row) => row.cells[0]!.dataset.value);
  const sortedBy = () => table.querySelectorAll('th').filter((th) => th.hasAttribute('aria-sort'))
    .map((th) => [th.textContent.trim(), th.getAttribute('aria-sort'), th.classList.contains('tw-hide') ? 'hidden' : 'visible']);
  return { table, order, sortedBy, pick: root.querySelector('#time-window')!, live: root.querySelector('#sort-status')!, media };
}
const require_stats = await import('../src/output/stats.js');

test('on a narrow screen the Time table is sorted by the visible window, and aria-sort says so', () => {
  const narrow = runTimeTable(true);
  // Server order (all time) is replaced by the order of the visible Last 28 days column.
  assert.deepEqual(narrow.sortedBy(), [['Last 28 days', 'descending', 'visible']]);
  assert.deepEqual(narrow.order(), ['Manual', 'Health', 'stats.fm']);
  // Loading the page announces nothing.
  assert.equal(narrow.live.textContent, '');

  // Picking another window re-sorts by it and announces the new order.
  narrow.pick.value = 'delta';
  narrow.pick.dispatch('change');
  assert.deepEqual(narrow.sortedBy(), [['vs prior 7 d', 'descending', 'visible']]);
  assert.deepEqual(narrow.order(), ['Health', 'stats.fm', 'Manual']);
  assert.equal(narrow.live.textContent, 'Sorted by vs prior 7 d, descending');

  // A sort the reader chose on a visible column is kept when it stays visible.
  narrow.pick.value = '6';
  narrow.pick.dispatch('change');
  assert.deepEqual(narrow.sortedBy(), [['All time', 'descending', 'visible']]);
  narrow.table.querySelectorAll('th')[1]!.dispatch('click');
  assert.deepEqual(narrow.sortedBy(), [['Method', 'descending', 'visible']]);
  narrow.pick.value = '1';
  narrow.pick.dispatch('change');
  assert.deepEqual(narrow.sortedBy(), [['Method', 'descending', 'visible']]);
});

test('on a wide screen the Time table keeps the server order and its All time sort', () => {
  const wide = runTimeTable(false);
  assert.deepEqual(wide.sortedBy(), [['All time', 'descending', 'visible']]);
  assert.deepEqual(wide.order(), ['stats.fm', 'Health', 'Manual']);
  // Narrowing the window hides All time: the sort follows the visible column.
  wide.media.matches = true;
  for (const listener of wide.media.listeners) listener();
  assert.deepEqual(wide.sortedBy(), [['Last 28 days', 'descending', 'visible']]);
  assert.deepEqual(wide.order(), ['Manual', 'Health', 'stats.fm']);
  // Clicking a heading still toggles the direction and announces it.
  const last28 = wide.table.querySelectorAll('th').find((th) => th.textContent.trim() === 'Last 28 days')!;
  last28.dispatch('click');
  assert.deepEqual(wide.sortedBy(), [['Last 28 days', 'ascending', 'visible']]);
  assert.deepEqual(wide.order(), ['stats.fm', 'Health', 'Manual']);
  assert.equal(wide.live.textContent, 'Sorted by Last 28 days, ascending');
});
