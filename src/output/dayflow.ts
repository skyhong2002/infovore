import type { DayflowExtra, DayflowSnapshot } from '../dayflow/types.js';
import { h, logo, renderCard, truncate } from './render.js';
import { html, timeAmount } from './pages.js';

const duration = (minutes: number) => timeAmount(Math.round(minutes * 60));
export function dayflowDetails(extra: DayflowExtra): string {
  const daily = extra.daily.filter((d) => d.trackedMinutes + d.errorMinutes > 0).slice(0, 30);
  const max = Math.max(1, ...daily.map((d) => d.trackedMinutes));
  return `<section><div class="platform-section-heading"><h2>Categories this week</h2><span>Monday–Sunday · 4am boundary</span></div>
    <div class="platform-tags">${extra.categories.map((c) => `<span><i style="display:inline-block;width:8px;height:8px;background:${html(c.color)};margin-right:6px"></i>${html(c.name)} · ${html(duration(c.minutes))}</span>`).join('') || '<span>No activity this week</span>'}</div></section>
    <section><div class="platform-section-heading"><h2>Recent recorded days</h2><span>Asia/Taipei · 4am–4am</span></div>
    <div class="health-days">${daily.map((d) => `<article class="health-day"><time datetime="${d.day}">${d.day}</time><div class="health-step-track" style="display:flex;height:10px">${d.categories.map((c) => `<span title="${html(c.name)}: ${html(duration(c.minutes))}" style="width:${c.minutes / max * 100}%;background:${html(c.color)};border-radius:0"></span>`).join('')}</div><strong>${html(duration(d.trackedMinutes))}</strong><p>${html(duration(d.activeMinutes))} active · ${html(duration(d.idleMinutes))} idle${d.errorMinutes ? ` · ${html(duration(d.errorMinutes))} analysis unavailable` : ''}</p></article>`).join('') || '<div class="empty">Waiting for the first Dayflow sync.</div>'}</div>
    <div class="platform-note">Computer time includes idle time and excludes analysis errors. Active means non-idle, not a focus score. It may overlap music and video time, so it is shown separately from cross-platform totals. Activity titles, summaries and app names remain private. Missing days are not treated as zero.</div></section>`;
}

export async function buildDayflowCard(data: DayflowSnapshot): Promise<string> {
  const days = data.extra.daily.filter((d) => d.trackedMinutes + d.errorMinutes > 0).slice(0, 7).reverse();
  const max = Math.max(1, ...days.map((d) => d.trackedMinutes));
  const text = (value: string, style: Record<string, unknown> = {}) => h('span', { style: { display: 'flex', ...style } }, value);
  const row = (children: unknown[], style: Record<string, unknown> = {}) => h('div', { style: { display: 'flex', ...style } }, ...children);
  return renderCard(h('div', { style: { width: 520, height: '100%', display: 'flex', flexDirection: 'column', backgroundColor: '#141923', color: '#edf0f7', fontFamily: 'Inter', padding: 24, gap: 16 } },
    row([h('img', { src: logo('dayflow'), width: 40, height: 40 }),
      row([text('DAYFLOW', { fontSize: 13, color: '#b5adff', fontWeight: 700 }), text(truncate(data.profile.name, 32), { fontSize: 20, fontWeight: 700 })], { flexDirection: 'column', gap: 4 })], { gap: 12, alignItems: 'center' }),
    row([text(`${data.stats.weeklyHours}h this week`, { fontSize: 25, fontWeight: 700 }), text(`${data.stats.weeklyActiveHours}h active`, { fontSize: 13, color: '#b9c3d6' })], { justifyContent: 'space-between', alignItems: 'baseline' }),
    text('RECENT RECORDED DAYS', { color: '#b9c3d6', fontSize: 10, letterSpacing: 1 }),
    ...days.map((d) => row([
      text(d.day.slice(5), { width: 52, fontSize: 12 }),
      row(d.categories.map((c) => h('div', { style: { display: 'flex', height: 14, width: 310 * c.minutes / max, backgroundColor: c.color } })), { width: 310, backgroundColor: '#252c3d', height: 14 }),
      text(duration(d.trackedMinutes), { width: 86, fontSize: 12, justifyContent: 'flex-end' }),
    ], { alignItems: 'center', gap: 10 })),
    ...(!days.length ? [text('Waiting for Dayflow activity', { color: '#b9c3d6', fontSize: 14 })] : []),
    row(data.extra.categories.slice(0, 6).map((c) => row([
      h('div', { style: { display: 'flex', width: 8, height: 8, backgroundColor: c.color } }), text(`${truncate(c.name, 23)} ${duration(c.minutes)}`, { fontSize: 10 }),
    ], { gap: 6, alignItems: 'center' })), { gap: 12, flexWrap: 'wrap' }),
    text('Taipei · 4am–4am · Computer time may overlap other platforms', { color: '#b9c3d6', fontSize: 9 }),
  ), 520, 470);
}
