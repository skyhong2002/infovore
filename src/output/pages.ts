import type { Activity } from '../data/types.js';
import type { WrappedSummary } from '../data/database.js';

export function html(value: unknown): string {
  return String(value ?? '').replace(/[<>&'"]/g, (char) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&#39;', '"': '&quot;' }[char]!));
}

const styles = `
  :root{color-scheme:dark}*{box-sizing:border-box}body{background:#0d0e11;color:#e8eaed;margin:0 auto;padding:36px 18px 64px;max-width:980px;font:15px/1.55 Inter,system-ui,sans-serif}
  a{color:#9bc3ff}header{display:flex;align-items:baseline;justify-content:space-between;gap:20px;margin-bottom:34px}nav{display:flex;gap:14px}h1{font-size:30px;margin:0}h2{font-size:17px;margin:34px 0 14px;color:#b9c0ca}.muted{color:#7f8996}.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:12px}
  .card{background:#15171c;border:1px solid #252a32;border-radius:13px;padding:15px}.entry{display:grid;grid-template-columns:52px minmax(0,1fr);gap:13px;align-items:center}.entry img{width:52px;height:70px;object-fit:cover;border-radius:7px;background:#222}.entry h3{font-size:15px;margin:0 0 4px}.pill{font-size:11px;color:#aab4c1;text-transform:uppercase;letter-spacing:.08em}.count{font-size:28px;font-weight:700}.bar{height:8px;background:#252a32;border-radius:9px;overflow:hidden}.bar span{display:block;height:100%;background:#78a9ff}.empty{padding:30px;border:1px dashed #343b46;border-radius:12px;color:#818b98}@media(max-width:560px){body{padding-top:24px}header{align-items:flex-start;flex-direction:column;margin-bottom:26px}nav{flex-wrap:wrap}.grid{grid-template-columns:1fr}}`;

function shell(title: string, body: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${html(title)} · infovore</title><style>${styles}</style></head><body><header><div><h1>${html(title)}</h1><div class="muted">infovore · a personal cross-media lifelog</div></div><nav><a href="/">cards</a><a href="/profile">profile</a><a href="/now">now</a><a href="/wrapped">wrapped</a></nav></header>${body}</body></html>`;
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
