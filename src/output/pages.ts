import type { Activity } from '../data/types.js';
import type { WrappedSummary } from '../data/database.js';

export function html(value: unknown): string {
  return String(value ?? '').replace(/[<>&'"]/g, (char) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&#39;', '"': '&quot;' }[char]!));
}

const styles = `
  :root{color-scheme:dark}*{box-sizing:border-box}body{background:#0d0e11;color:#e8eaed;margin:0 auto;padding:36px 18px 64px;max-width:980px;font:15px/1.55 Inter,system-ui,sans-serif}
  a{color:#9bc3ff}header{display:flex;align-items:baseline;justify-content:space-between;gap:20px;margin-bottom:34px}nav{display:flex;gap:14px}h1{font-size:30px;margin:0}h2{font-size:17px;margin:34px 0 14px;color:#b9c0ca}.muted{color:#7f8996}.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:12px}
  .card{background:#15171c;border:1px solid #252a32;border-radius:13px;padding:15px}.entry{display:grid;grid-template-columns:52px minmax(0,1fr);gap:13px;align-items:center}.entry img{width:52px;height:70px;object-fit:cover;border-radius:7px;background:#222}.entry h3{font-size:15px;margin:0 0 4px}.pill{font-size:11px;color:#aab4c1;text-transform:uppercase;letter-spacing:.08em}.count{font-size:28px;font-weight:700}.bar{height:8px;background:#252a32;border-radius:9px;overflow:hidden}.bar span{display:block;height:100%;background:#78a9ff}.empty{padding:30px;border:1px dashed #343b46;border-radius:12px;color:#818b98}@media(max-width:560px){body{padding-top:24px}header{align-items:flex-start;flex-direction:column;margin-bottom:26px}nav{flex-wrap:wrap}.grid{grid-template-columns:1fr}}
  .feed-intro{display:flex;justify-content:space-between;align-items:end;gap:24px;padding-bottom:22px;border-bottom:1px solid #292d34}.feed-intro p{max-width:620px;margin:0}.feed-count{color:#aeb6c1;white-space:nowrap}.activity-list{display:flex;flex-direction:column}.activity-row{display:grid;grid-template-columns:112px 58px minmax(0,1fr);gap:18px;align-items:center;padding:18px 0;border-bottom:1px solid #242830}.activity-row time{align-self:start;color:#aeb6c1;font-size:13px;line-height:1.4}.activity-row time span{display:block;color:#69727f;font-size:12px}.activity-cover{width:58px;height:78px;object-fit:cover;border-radius:6px;background:#1c2026}.activity-cover.placeholder{display:block}.activity-main{min-width:0}.activity-labels{display:flex;align-items:center;gap:8px;margin-bottom:5px}.source-label{color:#82b1ff;font-size:11px;font-weight:700;letter-spacing:.09em;text-transform:uppercase}.kind-label{color:#69727f;font-size:11px;text-transform:uppercase}.activity-main h2{color:#f2f3f5;font-size:17px;line-height:1.35;margin:0 0 5px}.activity-meta{color:#8a939f;font-size:13px}.activity-tag{display:inline-block;border:1px solid #343b46;border-radius:999px;color:#aeb6c1;font-size:11px;line-height:1.4;padding:1px 7px}.rating{color:#e9b873}.feed-footer{margin-top:24px;color:#6f7884;font-size:13px}
  @media(max-width:560px){.feed-intro{align-items:flex-start;flex-direction:column}.feed-count{white-space:normal}.activity-row{grid-template-columns:48px minmax(0,1fr);gap:13px}.activity-row time{grid-column:1/-1}.activity-cover{width:48px;height:66px}.activity-main h2{font-size:16px}}
`;

function shell(title: string, body: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><link rel="alternate" type="application/rss+xml" title="infovore" href="/feed.xml"><title>${html(title)} · infovore</title><style>${styles}</style></head><body><header><div><h1>${html(title)}</h1><div class="muted">infovore · a personal cross-media lifelog</div></div><nav><a href="/">home</a><a href="/cards">cards</a><a href="/profile">profile</a><a href="/now">now</a><a href="/wrapped">wrapped</a></nav></header>${body}</body></html>`;
}

function sourceLabel(source: string): string {
  return ({ backloggd: 'Backloggd', kitsu: 'Kitsu', statsfm: 'stats.fm', simkl: 'Simkl', goodreads: 'Goodreads', events: 'Manual' } as Record<string, string>)[source] ?? source;
}

function activityWhen(activity: Activity): { date: string; time: string; datetime: string } {
  const raw = activity.occurredAt ?? activity.firstSeenAt;
  if (activity.occurredAtPrecision === 'label') return { date: raw, time: '', datetime: '' };
  const parsed = new Date(raw);
  if (Number.isNaN(parsed.getTime())) return { date: raw, time: '', datetime: '' };
  const date = new Intl.DateTimeFormat('en', {
    timeZone: 'Asia/Taipei', year: 'numeric', month: 'short', day: 'numeric',
  }).format(parsed);
  const time = activity.occurredAtPrecision === 'exact'
    ? new Intl.DateTimeFormat('en', { timeZone: 'Asia/Taipei', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(parsed)
    : '';
  return { date, time, datetime: parsed.toISOString() };
}

function activityMeta(activity: Activity): string {
  const details: string[] = [];
  const add = (value: unknown) => details.push(html(value));
  if (activity.status) add(activity.status.replaceAll('_', ' '));
  if (activity.extra.artist) add(activity.extra.artist);
  else if (activity.extra.author) add(`by ${activity.extra.author}`);
  if (activity.extra.watchedEpisodes != null && activity.extra.totalEpisodes != null) {
    add(`${activity.extra.watchedEpisodes}/${activity.extra.totalEpisodes} episodes`);
  } else if (activity.extra.progress) {
    add(`progress ${activity.extra.progress}`);
  }
  if (activity.extra.platform) add(activity.extra.platform);
  if (activity.extra.playtime) add(activity.extra.playtime);
  if (activity.extra.venue) add(activity.extra.venue);
  if (activity.extra.year) add(activity.extra.year);
  if (Array.isArray(activity.extra.tags)) {
    details.push(activity.extra.tags.map((tag) => `<span class="activity-tag">${html(tag)}</span>`).join(' '));
  }
  if (activity.rating) {
    details.push(`<span class="rating">★ ${html(activity.rating.value)}/${html(activity.rating.scale)}</span>`);
  }
  return details.join(' · ');
}

function activityRow(activity: Activity): string {
  const when = activityWhen(activity);
  const time = `<time${when.datetime ? ` datetime="${html(when.datetime)}"` : ''}>${html(when.date)}${when.time ? `<span>${html(when.time)} GMT+8</span>` : ''}</time>`;
  const cover = activity.image
    ? `<img class="activity-cover" src="${html(activity.image)}" alt="" loading="lazy">`
    : '<span class="activity-cover placeholder" aria-hidden="true"></span>';
  return `<article class="activity-row" id="activity-${activity.id}">${time}${cover}<div class="activity-main"><div class="activity-labels"><span class="source-label">${html(sourceLabel(activity.source))}</span><span class="kind-label">${html(activity.mediaKind)}</span></div><h2>${html(activity.title)}</h2><div class="activity-meta">${activityMeta(activity)}</div></div></article>`;
}

export function homePage(ownerName: string, activities: Activity[], total: number, lastUpdated: string | null): string {
  const intro = `<section class="feed-intro"><p class="muted">The latest entries from every connected platform for ${html(ownerName)}, together in one chronological stream.</p><div class="feed-count">Showing ${activities.length} of ${total} entries</div></section>`;
  const timeline = activities.length
    ? `<main class="activity-list">${activities.map(activityRow).join('')}</main>`
    : '<div class="empty">No activity has been collected yet.</div>';
  const footer = `<div class="feed-footer">${lastUpdated ? `Last synced ${html(lastUpdated)} · ` : ''}<a href="/feed.xml">RSS</a> · <a href="/api/activities.json">JSON</a> · <a href="/status">status</a></div>`;
  return shell('Recent activity', intro + timeline + footer);
}

function activityCard(activity: Activity): string {
  const when = activity.occurredAt ?? activity.firstSeenAt;
  const date = /^\d{4}-\d{2}-\d{2}/.test(when)
    ? new Intl.DateTimeFormat('en', { year: 'numeric', month: 'short', day: 'numeric' }).format(new Date(when))
    : when;
  const meta = [activity.source, activity.status, activity.extra.venue, date].filter(Boolean).join(' · ');
  return `<article class="card entry" id="activity-${activity.id}">${activity.image ? `<img src="${html(activity.image)}" alt="">` : '<div></div>'}<div><span class="pill">${html(activity.mediaKind)}</span><h3>${html(activity.title)}</h3><div class="muted">${html(meta)}</div></div></article>`;
}

export function nowPage(ownerName: string, current: Activity[], upcoming: Activity[], recent: Activity[]): string {
  const section = (title: string, entries: Activity[]) => `<h2>${title}</h2>${entries.length ? `<div class="grid">${entries.map(activityCard).join('')}</div>` : '<div class="empty">Nothing here yet.</div>'}`;
  return shell(`${ownerName} · now`, section('Currently', current) + section('Upcoming events', upcoming) + section('Recent activity', recent));
}

export function profilePage(ownerName: string, total: number, bySource: Record<string, number>, latest: Activity[]): string {
  const stats = Object.entries(bySource).map(([source, count]) => `<div class="card"><div class="pill">${html(source)}</div><div class="count">${count}</div></div>`).join('');
  return shell(ownerName, `<p class="muted">Playing, watching, reading, listening, and showing up — collected into one durable timeline.</p><h2>Activity archive</h2><div class="grid"><div class="card"><div class="pill">total activities</div><div class="count">${total}</div></div>${stats}</div><h2>Latest</h2><div class="grid">${latest.map(activityCard).join('')}</div>`);
}

export function wrappedPage(ownerName: string, summary: WrappedSummary): string {
  const max = Math.max(1, ...Object.values(summary.byKind));
  const kinds = Object.entries(summary.byKind).map(([kind, count]) => `<div class="card"><div><span class="pill">${html(kind)}</span> <strong>${count}</strong></div><div class="bar"><span style="width:${Math.round(count / max * 100)}%"></span></div></div>`).join('');
  const titles = summary.topTitles.map((item) => `<div class="card"><span class="pill">${html(item.kind)}</span><h3>${html(item.title)}</h3><div class="muted">${item.count} activities</div></div>`).join('');
  return shell(`${ownerName} · ${summary.year} Wrapped`, `<div class="grid"><div class="card"><div class="pill">activities</div><div class="count">${summary.totalActivities}</div></div><div class="card"><div class="pill">average rating</div><div class="count">${summary.averageRating ?? '—'}</div></div></div><h2>Across media</h2>${kinds ? `<div class="grid">${kinds}</div>` : '<div class="empty">No dated activity has been collected for this year yet.</div>'}<h2>Most active titles</h2><div class="grid">${titles}</div>`);
}
