import type { Activity } from '../data/types.js';
import type { ActivityPage, WrappedSummary } from '../data/database.js';
import { config } from '../config.js';
import { PLAYING_WINDOW_DAYS, STALE_AFTER_DAYS } from '../data/status.js';
import { healthActivityMeta } from './health-activity.js';
import { baseStyles } from './styles.js';
import { createHash } from 'node:crypto';
import { dateFormat } from '../data/time.js';

export function html(value: unknown): string {
  return String(value ?? '').replace(/[<>&'"]/g, (char) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&#39;', '"': '&quot;' }[char]!));
}

export function hours(seconds: number | null): string {
  if (seconds === null) return '—';
  return `${Math.round(seconds / 360) / 10}h`;
}

export function duration(seconds: number | null): string {
  if (seconds === null) return 'Unknown length';
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  return minutes < 60 ? `${minutes} min` : `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

// Sub-hour amounts read better in minutes ("24m", not "0.4h").
export function timeAmount(seconds: number): string {
  if (seconds < 3600) return `${Math.max(1, Math.round(seconds / 60))}m`;
  return hours(seconds);
}

export const stylesVersion = createHash('sha1').update(baseStyles).digest('hex').slice(0, 8);


// Inline SVG sparkline: one series, no axes, sized for a table cell or tile.
export function sparkline(values: number[], options: { width?: number; height?: number; color?: string; label?: string } = {}): string {
  const width = options.width ?? 96;
  const height = options.height ?? 26;
  const color = options.color ?? 'var(--accent)';
  if (!values.length || values.every((value) => !value)) {
    return `<svg class="spark" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" aria-hidden="true"><line x1="0" y1="${height - 1.5}" x2="${width}" y2="${height - 1.5}" stroke="var(--line-strong)" stroke-dasharray="2 3"/></svg>`;
  }
  const max = Math.max(...values, 1);
  const step = values.length > 1 ? width / (values.length - 1) : width;
  const points = values.map((value, index) => `${(index * step).toFixed(1)},${(height - 2 - (value / max) * (height - 4)).toFixed(1)}`);
  const area = `M0,${height} L${points.join(' L')} L${width},${height} Z`;
  return `<svg class="spark" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" role="img" aria-label="${html(options.label ?? 'trend')}"><path d="${area}" fill="${color}" fill-opacity=".14"/><polyline points="${points.join(' ')}" fill="none" stroke="${color}" stroke-width="1.6" stroke-linejoin="round" stroke-linecap="round"/></svg>`;
}

// A small "how is this computed" marker whose note shows on hover and focus.
export function info(note: string): string {
  return `<span class="info" tabindex="0" role="note" aria-label="${html(note)}" data-tip="${html(note)}">i</span>`;
}

// Change against the previous period, rendered as a signed chip.
export function delta(current: number, previous: number, format: (value: number) => string): string {
  if (!current && !previous) return '<span class="delta flat">—</span>';
  const diff = current - previous;
  if (Math.abs(diff) < 1e-9) return '<span class="delta flat">= 0</span>';
  const cls = diff > 0 ? 'up' : 'down';
  return `<span class="delta ${cls}">${diff > 0 ? '▲' : '▼'} ${html(format(Math.abs(diff)))}</span>`;
}

export function sum(values: number[], from: number, to: number): number {
  let total = 0;
  for (let index = Math.max(0, from); index < Math.min(values.length, to); index += 1) total += values[index] ?? 0;
  return total;
}

export type PageKey = 'home' | 'now' | 'platforms' | 'profile' | 'cards' | 'stats' | 'search' | 'api';

const adaptiveMediaScript = `<script>
  (() => {
    const applyRatio = (image) => {
      if (!image.naturalWidth || !image.naturalHeight) return;
      const naturalRatio = image.naturalWidth / image.naturalHeight;
      const displayedRatio = Math.min(2, Math.max(0.5, naturalRatio));
      image.style.setProperty('--media-ratio', String(displayedRatio));
    };
    document.querySelectorAll('img[data-adaptive-media]').forEach((image) => {
      if (image.complete) applyRatio(image);
      else image.addEventListener('load', () => applyRatio(image), { once: true });
    });
  })();
</script>`;

const navigation: Array<{ key: PageKey; label: string; href: string }> = [
  { key: 'home', label: 'Home', href: '/' },
  { key: 'now', label: 'Now', href: '/now' },
  { key: 'stats', label: 'Time', href: '/stats' },
  { key: 'platforms', label: 'Platforms', href: '/platforms' },
  { key: 'profile', label: 'Archive', href: '/profile' },
  { key: 'cards', label: 'Cards', href: '/cards' },
];

const themeInit = `<script>(()=>{let t=null;try{t=localStorage.getItem('infovore-theme')}catch{}if(t!=='light'&&t!=='dark')t=matchMedia('(prefers-color-scheme: dark)').matches?'dark':'light';document.documentElement.dataset.theme=t})()</script>`;
const themeToggleScript = `<script>document.getElementById('theme-toggle').addEventListener('click',()=>{const r=document.documentElement;const n=r.dataset.theme==='dark'?'light':'dark';r.dataset.theme=n;try{localStorage.setItem('infovore-theme',n)}catch{}})</script>`;
const themeToggle = `<button class="theme-toggle" id="theme-toggle" type="button" aria-label="Toggle colour theme" title="Toggle theme"><svg class="icon-sun" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="4"/><path d="M12 2v2m0 16v2M4.9 4.9l1.4 1.4m11.4 11.4 1.4 1.4M2 12h2m16 0h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></svg><svg class="icon-moon" viewBox="0 0 24 24" aria-hidden="true"><path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/></svg></button>`;

export function shell(title: string, body: string, active: PageKey, extraStyles = ''): string {
  const nav = navigation.map((item) =>
    `<a href="${item.href}"${item.key === active ? ' aria-current="page"' : ''}>${item.label}</a>`
  ).join('');
  const description = "Sky's personal infoboard for everything watched, read, played, heard, attended, and moved.";
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="description" content="${description}">
  <meta property="og:type" content="website"><meta property="og:title" content="${html(title)} · infovore"><meta property="og:description" content="${description}"><meta property="og:image" content="${html(config.publicBaseUrl)}/og.png?v=life-rings-muted">
  <meta name="twitter:card" content="summary_large_image"><meta name="twitter:title" content="${html(title)} · infovore"><meta name="twitter:description" content="${description}"><meta name="twitter:image" content="${html(config.publicBaseUrl)}/og.png?v=life-rings-muted">
  <link rel="icon" type="image/png" sizes="32x32" href="/favicon.png?v=muted"><link rel="apple-touch-icon" sizes="180x180" href="/apple-touch-icon.png?v=muted"><meta name="theme-color" media="(prefers-color-scheme: light)" content="#f4f3ef"><meta name="theme-color" media="(prefers-color-scheme: dark)" content="#0e0f12"><link rel="alternate" type="application/rss+xml" title="infovore" href="/feed.xml"><title>${html(title)} · infovore</title>
  ${themeInit}<link rel="preload" href="/fonts/Figtree-Regular.ttf" as="font" type="font/ttf" crossorigin><link rel="stylesheet" href="/styles.css?v=${stylesVersion}">${extraStyles ? `<style>${extraStyles}</style>` : ''}</head><body>
  <header class="site-header"><div class="site-header-inner"><a class="site-brand" href="/"><img class="brand-mark" src="/logos/infovore.png?v=muted" alt="" width="36" height="36"><span><strong>infovore</strong><small>Sky's personal infoboard</small></span></a><nav class="site-nav" aria-label="Primary">${nav}</nav><div class="site-tools"><form class="site-search" action="/search" role="search"><input type="search" name="q" placeholder="Search the archive" aria-label="Search the archive" autocomplete="off"><button type="submit" aria-label="Search"><svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></svg></button></form><a class="site-search-link" href="/search" aria-label="Search"><svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></svg></a>${themeToggle}</div></div></header>
  <main class="site-main">${body}</main>
  <footer class="site-footer"><div class="footer-about"><a class="site-brand" href="/"><img class="brand-mark" src="/logos/infovore.png?v=muted" alt="" width="36" height="36"><strong>infovore</strong></a><p>Sky's media, activities, and plans gathered into one personal home.</p></div>
  <div class="footer-group"><span>Explore</span><a href="/">Home</a><a href="/now">Now</a><a href="/platforms">Platforms</a></div>
  <div class="footer-group"><span>Reflect</span><a href="/profile">Archive</a><a href="/stats">Time</a><a href="/wrapped">Wrapped</a><a href="/cards">Cards</a></div>
  <div class="footer-group"><span>Data</span><a href="/search">Search</a><a href="/api">API</a><a href="/feed.xml">RSS</a><a href="/status">Status</a><a href="https://github.com/skyhong2002/infovore">Source</a></div></footer>
  ${themeToggleScript}${adaptiveMediaScript}</body></html>`;
}

export function sourceLabel(source: string): string {
  return ({ backloggd: 'Backloggd', kitsu: 'Kitsu', statsfm: 'stats.fm', simkl: 'Simkl', goodreads: 'Goodreads', youtube: 'YouTube', health: 'Health', dayflow: 'Dayflow', computai: 'ComputAI', events: 'Manual' } as Record<string, string>)[source] ?? source;
}

// Coarse relative age for the present view: "today", "12 days ago", "4 months ago".
export function relativeAge(iso: string | null, now = new Date()): string {
  const parsed = Date.parse(iso ?? '');
  if (!Number.isFinite(parsed)) return '';
  const days = Math.floor((now.getTime() - parsed) / 86_400_000);
  if (days <= 0) return 'today';
  if (days === 1) return 'yesterday';
  if (days < 30) return `${days} days ago`;
  if (days < 365) { const months = Math.round(days / 30); return `${months} ${months === 1 ? 'month' : 'months'} ago`; }
  const years = Math.round(days / 365);
  return `${years} ${years === 1 ? 'year' : 'years'} ago`;
}

type CardContext = 'current' | 'paused' | 'queued' | undefined;

function activityCard(activity: Activity, context?: CardContext, now = new Date()): string {
  const when = activity.occurredAt ?? activity.firstSeenAt;
  if (activity.source === 'health') {
    const date = dateFormat('en', { timeZone: 'Asia/Taipei', year: 'numeric', month: 'short', day: 'numeric' }).format(new Date(when));
    const clock = activity.occurredAtPrecision === 'exact'
      ? dateFormat('en-GB', { timeZone: 'Asia/Taipei', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(when)) : '';
    const summary = healthActivityMeta(activity);
    return `<article class="card entry health-activity" id="activity-${html(activity.id)}"><img src="/logos/healthconnect.png" alt="Health Connect logo" width="48" height="48"><div><span class="pill">Health · ${html(activity.status)}</span><h3><a href="/platforms/health${activity.status === 'sleep' ? '#sleep' : ''}">${html(activity.title)}</a></h3><div class="muted health-activity-summary" title="${html(summary)}">${html(summary)}</div><time datetime="${html(when)}">${html(date)}${clock ? ` · ${clock} GMT+8${activity.status === 'sleep' ? ' · 醒來' : ''}` : ' · 每日彙總'}</time></div></article>`;
  }
  const date = /^\d{4}-\d{2}-\d{2}/.test(when)
    ? dateFormat('en', { year: 'numeric', month: 'short', day: 'numeric' }).format(new Date(when))
    : when;
  const progress = activity.extra.watchedEpisodes != null && activity.extra.totalEpisodes
    ? `${activity.extra.watchedEpisodes}/${activity.extra.totalEpisodes} ep`
    : activity.extra.progress ? `progress ${activity.extra.progress}` : '';
  const next = activity.extra.nextToWatch ? `next ${activity.extra.nextToWatch}` : '';
  const age = relativeAge(when, now);
  const meta = context === 'current' || context === 'paused'
    ? [sourceLabel(activity.source), progress, next, age ? `last progress ${age}` : date].filter(Boolean).join(' · ')
    : context === 'queued'
      ? [sourceLabel(activity.source), activity.extra.author ? `by ${activity.extra.author}` : '', age ? `added ${age}` : ''].filter(Boolean).join(' · ')
      : [activity.source, activity.status, activity.extra.venue, date].filter(Boolean).join(' · ');
  return `<article class="card entry${context ? ` entry-${context}` : ''}" id="activity-${activity.id}">${activity.image ? `<img data-adaptive-media src="${html(activity.image)}" alt="">` : '<div></div>'}<div><span class="pill">${html(activity.mediaKind)}</span><h3>${html(activity.title)}</h3><div class="muted">${html(meta)}</div></div></article>`;
}


export interface SearchFilters {
  query: string;
  source: string;
  kind: string;
}

export function searchPage(ownerName: string, filters: SearchFilters, page: ActivityPage, bySource: Record<string, number>, kinds: string[]): string {
  const params = (overrides: Partial<SearchFilters> & { offset?: number }) => {
    const next = { ...filters, ...overrides };
    const query = new URLSearchParams();
    if (next.query) query.set('q', next.query);
    if (next.source) query.set('source', next.source);
    if (next.kind) query.set('kind', next.kind);
    if (overrides.offset) query.set('offset', String(overrides.offset));
    const text = query.toString();
    return `/search${text ? `?${text}` : ''}`;
  };
  const active = Boolean(filters.query || filters.source || filters.kind);
  const intro = `<section class="page-intro"><div><div class="eyebrow">Archive search</div><h1>Search</h1><p>Find anything ${html(ownerName)} has watched, read, played, heard or attended — titles, artists, channels, venues and tags across every connected platform.</p></div><div class="page-intro-aside">${page.total ? `${page.total.toLocaleString('en')} matching public entries.` : 'Public entries only; raw health and daily computer records stay out of the index.'}</div></section>
    <div class="context-line"><a href="/">Home</a><span>→</span><a href="/profile">Archive</a><span>→</span><strong>Search</strong></div>`;
  const form = `<form class="search-form" action="/search" role="search"><input type="search" name="q" value="${html(filters.query)}" placeholder="Try an artist, a game, a book, a channel…" aria-label="Search the archive" autofocus>${filters.source ? `<input type="hidden" name="source" value="${html(filters.source)}">` : ''}${filters.kind ? `<input type="hidden" name="kind" value="${html(filters.kind)}">` : ''}<button type="submit">Search</button></form>`;
  const sources = Object.entries(bySource).sort((a, b) => b[1] - a[1]);
  const sourceChips = `<div class="search-filters" aria-label="Filter by platform"><a href="${params({ source: '', offset: 0 })}"${filters.source ? '' : ' aria-current="true"'}>All platforms</a>${sources.map(([source, count]) =>
    `<a href="${params({ source, offset: 0 })}"${filters.source === source ? ' aria-current="true"' : ''}>${html(sourceLabel(source))} <small>${count.toLocaleString('en')}</small></a>`).join('')}</div>`;
  const kindChips = kinds.length ? `<div class="search-filters" aria-label="Filter by kind"><a href="${params({ kind: '', offset: 0 })}"${filters.kind ? '' : ' aria-current="true"'}>All kinds</a>${kinds.map((kind) =>
    `<a href="${params({ kind, offset: 0 })}"${filters.kind === kind ? ' aria-current="true"' : ''}>${html(kind)}</a>`).join('')}</div>` : '';
  const results = page.data.length
    ? `<div class="grid">${page.data.map((activity) => activityCard(activity)).join('')}</div>`
    : `<div class="empty">${active ? 'Nothing matched. Try a shorter word, or clear a filter.' : 'Type something above, or pick a platform to browse.'}</div>`;
  const previous = page.offset > 0 ? `<a class="button" href="${params({ offset: Math.max(0, page.offset - page.limit) })}">← Newer</a>` : '<span></span>';
  const next = page.offset + page.limit < page.total ? `<a class="button" href="${params({ offset: page.offset + page.limit })}">Older →</a>` : '';
  const pager = page.total > page.limit ? `<nav class="pager" aria-label="Pagination">${previous}<span class="muted">${page.offset + 1}–${Math.min(page.total, page.offset + page.limit)} of ${page.total.toLocaleString('en')}</span>${next}</nav>` : '';
  return shell(`${ownerName} · search${filters.query ? ` · ${filters.query}` : ''}`, intro + form + sourceChips + kindChips + results + pager, 'search');
}

export interface ApiDocs {
  baseUrl: string;
  sources: string[];
  cards: string[];
}

export function apiPage(ownerName: string, docs: ApiDocs): string {
  const row = (path: string, description: string, params = '') => `<tr><td><code>${html(path)}</code></td><td>${description}${params ? `<br><span class="muted">${params}</span>` : ''}</td></tr>`;
  const intro = `<section class="page-intro"><div><div class="eyebrow">Data access</div><h1>API</h1><p>Everything on this site is also available as JSON, RSS and image cards. Read-only, no key, no rate limit beyond good manners.</p></div><div class="page-intro-aside">Base URL <code>${html(docs.baseUrl)}</code></div></section>
    <div class="context-line"><a href="/">Home</a><span>→</span><strong>API</strong><span>→</span><a href="/status">Status</a></div>`;
  const rules = `<section class="card"><p class="muted">All endpoints are <code>GET</code> and return UTF-8 JSON unless noted. Times are ISO 8601 in UTC; "a day" means a Taipei (UTC+8) calendar day. Only <em>public</em> activities are exposed: raw health samples, private events and Dayflow screen text never leave the server. Responses are not cached by the server, but the data behind them refreshes hourly, so please do not poll faster than that. Content belongs to the original platforms; credit "${html(ownerName)} · infovore" when you reuse it.</p></section>`;
  const activities = `<h2>Activities</h2><table>
    <thead><tr><th>Endpoint</th><th>Returns</th></tr></thead><tbody>
    ${row('/api/activities.json', 'A page of public activities, newest first, as <code>{ data, total, limit, offset }</code>.', 'Query: <code>q</code> text match on title and metadata · <code>source</code> platform id · <code>kind</code> media kind · <code>status</code> · <code>since</code>/<code>until</code> ISO instants · <code>limit</code> (1–500, default 100) · <code>offset</code>')}
    ${row('/feed.json', 'The latest 100 activities in the same shape.', 'Query: <code>limit</code>')}
    ${row('/feed.xml', 'RSS 2.0 feed of the latest 100 activities.')}
    ${row('/api/wrapped/<year>.json', 'A year-in-review summary: totals by source and kind, most active titles, average rating.', 'Years 2000–2200')}
    </tbody></table>`;
  const time = `<h2>Time</h2><table>
    <thead><tr><th>Endpoint</th><th>Returns</th></tr></thead><tbody>
    ${row('/api/time-spent.json', 'Recorded time per platform across seven windows (<code>last24h</code>, <code>last28d</code>, <code>day</code>, <code>week</code>, <code>month</code>, <code>year</code>, <code>allTime</code>) in seconds, each marked <code>measured</code> or <code>estimated</code>, plus <code>daily</code>: seconds per Taipei day for the last 28 days per source.')}
    </tbody></table>`;
  const mirrors = `<h2>Platform mirrors</h2><p class="muted">The last snapshot pulled from each connected platform, as <code>{ fetchedAt, data }</code> where <code>data</code> carries <code>profile</code>, <code>stats</code>, <code>entries</code> and a platform-specific <code>extra</code>.</p><table>
    <thead><tr><th>Endpoint</th><th>Returns</th></tr></thead><tbody>
    ${docs.sources.map((source) => row(`/api/${source}.json`, `${html(sourceLabel(source))} snapshot.`)).join('')}
    </tbody></table>`;
  const cards = `<h2>Cards</h2><p class="muted">Rendered share cards, in <code>.svg</code> (vector), <code>.png</code> and <code>.webp</code>. Pass <code>?scale=2</code> for retina rasters where supported.</p><table>
    <thead><tr><th>Endpoint</th><th>Returns</th></tr></thead><tbody>
    ${['now', 'word-cloud', 'word-cloud-plain', 'activity-rhythm', ...docs.cards].map((card) => row(`/card/${card}.svg`, `${html(card)} card`)).join('')}
    </tbody></table>`;
  const service = `<h2>Service</h2><table>
    <thead><tr><th>Endpoint</th><th>Returns</th></tr></thead><tbody>
    ${row('/status', 'Collector status: refresh schedule, database counts, last fetch and error per source, card list.')}
    ${row('/healthz', '<code>healthy</code>, <code>degraded</code> or <code>unhealthy</code> (HTTP 503) from source freshness.')}
    ${row('/mcp', 'Model Context Protocol endpoint (POST) exposing the archive as tools for AI agents.')}
    </tbody></table>`;
  const examples = `<h2>Examples</h2><pre><code># Everything with "Daft Punk" in it, last 90 days
curl -s '${html(docs.baseUrl)}/api/activities.json?q=Daft%20Punk&since=2026-07-06T00:00:00Z' | jq '.data[] | {title, source, occurredAt}'

# Hours per platform this month
curl -s '${html(docs.baseUrl)}/api/time-spent.json' | jq '.sources[] | {source, hours: (.windows.month / 3600 | floor)}'

# Embed a card
&lt;img src="${html(docs.baseUrl)}/card/now.webp" width="520" alt="What ${html(ownerName)} is up to"&gt;</code></pre>`;
  return shell(`${ownerName} · API`, `<div class="api-doc">${intro}${rules}${activities}${time}${mirrors}${cards}${service}${examples}</div>`, 'api');
}

export interface NowExtras {
  paused?: Activity[];
  queued?: Activity[];
  now?: Date;
}

export function nowPage(ownerName: string, current: Activity[], upcoming: Activity[], recent: Activity[], extras: NowExtras = {}): string {
  const now = extras.now ?? new Date();
  const paused = extras.paused ?? [];
  const queued = extras.queued ?? [];
  const section = (title: string, description: string, entries: Activity[], context?: CardContext, trailer = '') => `<section class="content-section"><div class="section-heading"><div><h2>${title}</h2><p>${description}</p></div><span>${entries.length} entries</span></div>${entries.length ? `<div class="grid">${entries.map((activity) => activityCard(activity, context, now)).join('')}</div>` : '<div class="empty">Nothing here yet.</div>'}${trailer}</section>`;
  const pausedBlock = paused.length
    ? `<details class="paused" id="paused"><summary class="details-toggle">Paused · ${paused.length} ${paused.length === 1 ? 'title' : 'titles'} still marked in progress but untouched for over ${STALE_AFTER_DAYS} days</summary><div class="grid">${paused.map((activity) => activityCard(activity, 'paused', now)).join('')}</div></details>`
    : '';
  const intro = `<section class="page-intro"><div><div class="eyebrow">Present view</div><h1>Now</h1><p>A short-term view of what ${html(ownerName)} is in the middle of, what is lined up next, and what just happened.</p></div><div class="page-intro-aside">In progress means touched within the last ${STALE_AFTER_DAYS} days; games count as playing for ${PLAYING_WINDOW_DAYS} days after a session.</div></section>
    <div class="context-line"><a href="/">Home</a><span>→</span><strong>Now</strong><span>→</span><a href="/profile">Long-term archive</a></div>`;
  return shell(`${ownerName} · now`, intro
    + section('In progress', 'Playing, watching and reading right now, newest progress first.', current, 'current', pausedBlock)
    + section('Up next', 'Watchlists, planned anime and manga, and the to-read shelf, newest additions first.', queued, 'queued')
    + section('Upcoming events', 'Ticketed and planned real-world activities.', upcoming)
    + section('Just happened', 'Recent media, sleep, exercise and daily steps. High-frequency sources are sampled.', recent), 'now',
    '.paused{margin-top:14px}.paused>.details-toggle{border:1px solid var(--line);border-radius:var(--radius-sm);border-top:1px solid var(--line)}.paused[open]>.details-toggle{border-radius:var(--radius-sm) var(--radius-sm) 0 0}.paused>.grid{border:1px solid var(--line);border-top:0;border-radius:0 0 var(--radius-sm) var(--radius-sm);padding:12px}.entry-paused{opacity:.75}');
}

export function profilePage(ownerName: string, total: number, bySource: Record<string, number>, latest: Activity[]): string {
  const stats = Object.entries(bySource).map(([source, count]) => `<a class="metric-card" href="/platforms/${html(source)}"><span class="pill">${html(sourceLabel(source))}</span><span class="count">${count}</span></a>`).join('');
  const year = new Date().getUTCFullYear();
  const intro = `<section class="page-intro"><div><div class="eyebrow">Long-term view</div><h1>The archive</h1><p>Every durable entry collected for ${html(ownerName)}, summarized across sources without losing the original platform context.</p></div><div class="page-intro-aside">${total} public activities and counting.</div></section>
    <div class="context-line"><a href="/">Home</a><span>→</span><strong>Archive</strong><span>→</span><a href="/wrapped/${year}">${year} Wrapped</a></div>
    <div class="archive-actions"><a class="archive-action" href="/platforms"><strong>Browse by platform →</strong><span>Open the source-specific mirrors behind these totals.</span></a>
    <a class="archive-action" href="/wrapped/${year}"><strong>Open ${year} Wrapped →</strong><span>Turn the year's activity into a compact retrospective.</span></a></div>`;
  const overview = `<section><div class="section-heading"><div><div class="eyebrow">Coverage</div><h2>Activity by source</h2></div><span>${Object.keys(bySource).length} active sources</span></div><div class="metric-grid"><div class="metric-card"><span class="pill">All sources</span><span class="count">${total}</span></div>${stats}</div></section>`;
  const latestSection = `<section class="content-section"><div class="section-heading"><div><div class="eyebrow">Archive edge</div><h2>Latest additions</h2></div><a href="/">Back to the infoboard →</a></div><div class="grid">${latest.map((activity) => activityCard(activity)).join('')}</div></section>`;
  return shell(`${ownerName} · archive`, intro + overview + latestSection, 'profile');
}

export function wrappedPage(ownerName: string, summary: WrappedSummary): string {
  const max = Math.max(1, ...Object.values(summary.byKind));
  const kinds = Object.entries(summary.byKind).map(([kind, count]) => `<div class="card"><div><span class="pill">${html(kind)}</span> <strong>${count}</strong></div><div class="bar"><span style="width:${Math.round(count / max * 100)}%"></span></div></div>`).join('');
  const titles = summary.topTitles.map((item) => `<div class="card"><span class="pill">${html(item.kind)}</span><h3>${html(item.title)}</h3><div class="muted">${item.count} activities</div></div>`).join('');
  const intro = `<section class="page-intro"><div><div class="eyebrow">Archive · annual view</div><h1>${summary.year} Wrapped</h1><p>A year-sized summary of ${html(ownerName)}'s cross-media activity, derived from the same entries in the archive.</p></div><div class="page-intro-aside">A reflection layer—not a separate collection.</div></section>
    <div class="context-line"><a href="/">Home</a><span>→</span><a href="/profile">Archive</a><span>→</span><strong>${summary.year} Wrapped</strong></div>`;
  const headline = `<div class="metric-grid"><div class="metric-card"><span class="pill">Activities</span><span class="count">${summary.totalActivities}</span></div><div class="metric-card"><span class="pill">Average rating</span><span class="count">${summary.averageRating ?? '—'}</span></div></div>`;
  const media = `<section class="content-section"><div class="section-heading"><h2>Across media</h2></div>${kinds ? `<div class="grid">${kinds}</div>` : '<div class="empty">No dated activity has been collected for this year yet.</div>'}</section>`;
  const top = `<section class="content-section"><div class="section-heading"><h2>Most active titles</h2></div>${titles ? `<div class="grid">${titles}</div>` : '<div class="empty">No titles to rank yet.</div>'}</section>`;
  return shell(`${ownerName} · ${summary.year} Wrapped`, intro + headline + media + top, 'profile');
}
