import type { Activity } from '../data/types.js';
import type { WrappedSummary } from '../data/database.js';
import { config } from '../config.js';
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

export type PageKey = 'home' | 'now' | 'platforms' | 'profile' | 'cards' | 'stats';

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
  <header class="site-header"><div class="site-header-inner"><a class="site-brand" href="/"><img class="brand-mark" src="/logos/infovore.png?v=muted" alt="" width="36" height="36"><span><strong>infovore</strong><small>Sky's personal infoboard</small></span></a><nav class="site-nav" aria-label="Primary">${nav}</nav><div class="site-tools">${themeToggle}</div></div></header>
  <main class="site-main">${body}</main>
  <footer class="site-footer"><div class="footer-about"><a class="site-brand" href="/"><img class="brand-mark" src="/logos/infovore.png?v=muted" alt="" width="36" height="36"><strong>infovore</strong></a><p>Sky's media, activities, and plans gathered into one personal home.</p></div>
  <div class="footer-group"><span>Explore</span><a href="/">Home</a><a href="/now">Now</a><a href="/platforms">Platforms</a></div>
  <div class="footer-group"><span>Reflect</span><a href="/profile">Archive</a><a href="/stats">Time</a><a href="/wrapped">Wrapped</a><a href="/cards">Cards</a></div>
  <div class="footer-group"><span>Data</span><a href="/feed.xml">RSS</a><a href="/api/activities.json">JSON</a><a href="/status">Status</a><a href="https://github.com/skyhong2002/infovore">Source</a></div></footer>
  ${themeToggleScript}${adaptiveMediaScript}</body></html>`;
}

export function sourceLabel(source: string): string {
  return ({ backloggd: 'Backloggd', kitsu: 'Kitsu', statsfm: 'stats.fm', simkl: 'Simkl', goodreads: 'Goodreads', youtube: 'YouTube', health: 'Health', dayflow: 'Dayflow', computai: 'ComputAI', events: 'Manual' } as Record<string, string>)[source] ?? source;
}

function activityCard(activity: Activity): string {
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
  const meta = [activity.source, activity.status, activity.extra.venue, date].filter(Boolean).join(' · ');
  return `<article class="card entry" id="activity-${activity.id}">${activity.image ? `<img data-adaptive-media src="${html(activity.image)}" alt="">` : '<div></div>'}<div><span class="pill">${html(activity.mediaKind)}</span><h3>${html(activity.title)}</h3><div class="muted">${html(meta)}</div></div></article>`;
}

export function nowPage(ownerName: string, current: Activity[], upcoming: Activity[], recent: Activity[]): string {
  const section = (title: string, description: string, entries: Activity[]) => `<section class="content-section"><div class="section-heading"><div><h2>${title}</h2><p>${description}</p></div><span>${entries.length} entries</span></div>${entries.length ? `<div class="grid">${entries.map(activityCard).join('')}</div>` : '<div class="empty">Nothing here yet.</div>'}</section>`;
  const intro = `<section class="page-intro"><div><div class="eyebrow">Present view</div><h1>Now</h1><p>A short-term view of what ${html(ownerName)} is in the middle of, what is coming next, and what just happened.</p></div><div class="page-intro-aside">For the full personal overview, return home.</div></section>
    <div class="context-line"><a href="/">Home</a><span>→</span><strong>Now</strong><span>→</span><a href="/profile">Long-term archive</a></div>`;
  return shell(`${ownerName} · now`, intro + section('Currently', 'Media with an active reading, watching, or playing status.', current) + section('Upcoming events', 'Ticketed and planned real-world activities.', upcoming) + section('Just happened', 'Recent media, sleep, exercise and daily steps. High-frequency sources are sampled.', recent), 'now');
}

export function profilePage(ownerName: string, total: number, bySource: Record<string, number>, latest: Activity[]): string {
  const stats = Object.entries(bySource).map(([source, count]) => `<a class="metric-card" href="/platforms/${html(source)}"><span class="pill">${html(sourceLabel(source))}</span><span class="count">${count}</span></a>`).join('');
  const year = new Date().getUTCFullYear();
  const intro = `<section class="page-intro"><div><div class="eyebrow">Long-term view</div><h1>The archive</h1><p>Every durable entry collected for ${html(ownerName)}, summarized across sources without losing the original platform context.</p></div><div class="page-intro-aside">${total} public activities and counting.</div></section>
    <div class="context-line"><a href="/">Home</a><span>→</span><strong>Archive</strong><span>→</span><a href="/wrapped/${year}">${year} Wrapped</a></div>
    <div class="archive-actions"><a class="archive-action" href="/platforms"><strong>Browse by platform →</strong><span>Open the source-specific mirrors behind these totals.</span></a>
    <a class="archive-action" href="/wrapped/${year}"><strong>Open ${year} Wrapped →</strong><span>Turn the year's activity into a compact retrospective.</span></a></div>`;
  const overview = `<section><div class="section-heading"><div><div class="eyebrow">Coverage</div><h2>Activity by source</h2></div><span>${Object.keys(bySource).length} active sources</span></div><div class="metric-grid"><div class="metric-card"><span class="pill">All sources</span><span class="count">${total}</span></div>${stats}</div></section>`;
  const latestSection = `<section class="content-section"><div class="section-heading"><div><div class="eyebrow">Archive edge</div><h2>Latest additions</h2></div><a href="/">Back to the infoboard →</a></div><div class="grid">${latest.map(activityCard).join('')}</div></section>`;
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
