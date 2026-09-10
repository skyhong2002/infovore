import type { Activity } from '../data/types.js';
import { h, renderCard, textFont, timeAgo, toDataUri, truncate } from './render.js';
import { sourceLabel } from './pages.js';

// A cross-source "present view" card: what is in progress, what is coming up,
// and the latest item from each platform. Reads only public Activity rows,
// so it inherits every visibility rule the timeline already applies.
export interface NowCardInput {
  current: Activity[];
  upcoming: Activity[];
  recent: Activity[];
  updated: string | null;
}

const C = { bg: '#18191f', panel: '#22242b', line: '#2c2e36', text: '#f4f5f7', dim: '#92949c', soft: '#b8bbc4', accent: '#a8c7fa', warm: '#f59b45' };
const row = (children: unknown[], style: Record<string, unknown> = {}) => h('div', { style: { display: 'flex', ...style } }, ...children);
const text = (value: string, style: Record<string, unknown> = {}) => h('span', { style: { display: 'flex', fontFamily: textFont(value, 'Inter'), ...style } }, value);

const taipeiDate = new Intl.DateTimeFormat('en', { timeZone: 'Asia/Taipei', month: 'short', day: 'numeric' });
const taipeiClock = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Taipei', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });

function statusLabel(activity: Activity): string {
  return ({ current: 'watching', reading: 'reading', watching: 'watching', playing: 'playing' } as Record<string, string>)[activity.status ?? ''] ?? activity.status ?? '';
}

function eventWhen(activity: Activity): string {
  if (!activity.occurredAt) return 'date to be announced';
  const date = new Date(activity.occurredAt);
  const day = taipeiDate.format(date);
  return activity.occurredAtPrecision === 'exact' ? `${day} · ${taipeiClock.format(date)}` : day;
}

function detail(activity: Activity): string {
  const extra = activity.extra;
  const value = extra.artist ?? extra.author ?? extra.platform ?? extra.venue ?? extra.channel ?? '';
  return Array.isArray(value) ? value.join(', ') : String(value);
}

function thumb(uri: string, size: { w: number; h: number }, radius = 4) {
  return uri
    ? h('img', { src: uri, width: size.w, height: size.h, style: { borderRadius: radius, objectFit: 'cover', flexShrink: 0 } })
    : row([], { width: size.w, height: size.h, borderRadius: radius, backgroundColor: C.line, flexShrink: 0 });
}

function heading(label: string, count: number) {
  return row([
    text(label, { fontSize: 11, fontWeight: 700, color: C.accent, letterSpacing: 2 }),
    text(count ? `${count}` : 'nothing yet', { fontSize: 11, color: C.dim }),
  ], { justifyContent: 'space-between', alignItems: 'center', marginTop: 20, marginBottom: 8, paddingBottom: 6, borderBottom: `1px solid ${C.line}` });
}

function mediaRow(activity: Activity, image: string, meta: string) {
  return row([
    thumb(image, activity.mediaKind === 'music' || activity.mediaKind === 'video' ? { w: 44, h: 44 } : { w: 40, h: 56 }),
    row([
      text(truncate(activity.title, 44), { fontSize: 13, fontWeight: 700, color: C.text, lineHeight: 1.3 }),
      text(truncate(meta, 60), { fontSize: 10, color: C.soft, marginTop: 3 }),
    ], { flexDirection: 'column', justifyContent: 'center', marginLeft: 12, minWidth: 0 }),
  ], { alignItems: 'center', backgroundColor: C.panel, borderRadius: 6, padding: '8px 10px', marginBottom: 6 });
}

export async function buildNowCard(owner: string, input: NowCardInput): Promise<string> {
  const current = input.current.slice(0, 4);
  const upcoming = input.upcoming.slice(0, 3);
  const recent = input.recent.slice(0, 5);
  const images = await Promise.all([...current, ...recent].map((activity) => toDataUri(activity.image)));
  const currentImages = images.slice(0, current.length);
  const recentImages = images.slice(current.length);

  const node = row([
    row([text('INFOVORE · NOW', { color: C.accent, fontSize: 10, fontWeight: 700, letterSpacing: 2 }), text(truncate(owner, 32), { color: C.dim, fontSize: 11 })], { justifyContent: 'space-between' }),
    text('Right now', { fontSize: 30, fontWeight: 700, marginTop: 14 }),
    text(input.updated ? `Synced ${input.updated} · Taipei` : 'Waiting for the first sync', { fontSize: 11, color: C.dim, marginTop: 7 }),

    heading('IN PROGRESS', current.length),
    ...current.map((activity, i) => mediaRow(activity, currentImages[i], [sourceLabel(activity.source), statusLabel(activity), detail(activity)].filter(Boolean).join(' · '))),
    ...(current.length ? [] : [text('No book, show or game marked as in progress.', { fontSize: 11, color: C.dim })]),

    heading('UP NEXT', upcoming.length),
    ...upcoming.map((activity) => row([
      row([], { width: 6, height: 6, borderRadius: 3, backgroundColor: C.warm, marginTop: 5, marginRight: 10, flexShrink: 0 }),
      row([
        text(truncate(activity.title, 48), { fontSize: 13, fontWeight: 700, color: C.text, lineHeight: 1.3 }),
        text(truncate([eventWhen(activity), String(activity.extra.venue ?? '')].filter(Boolean).join(' · '), 60), { fontSize: 10, color: C.soft, marginTop: 3 }),
      ], { flexDirection: 'column', minWidth: 0 }),
    ], { alignItems: 'flex-start', marginBottom: 8 })),
    ...(upcoming.length ? [] : [text('No upcoming events on the calendar.', { fontSize: 11, color: C.dim })]),

    heading('JUST HAPPENED', recent.length),
    ...recent.map((activity, i) => row([
      thumb(recentImages[i], { w: 28, h: 28 }, 3),
      text(truncate(activity.title, 40), { fontSize: 12, color: C.text, marginLeft: 10, minWidth: 0 }),
      text(`${sourceLabel(activity.source)} · ${activity.occurredAt ? timeAgo(activity.occurredAt) : ''}`.replace(/ · $/, ''), { fontSize: 10, color: C.dim, marginLeft: 'auto', paddingLeft: 10, whiteSpace: 'nowrap' }),
    ], { alignItems: 'center', marginBottom: 6 })),
    ...(recent.length ? [] : [text('Nothing recorded yet.', { fontSize: 11, color: C.dim })]),

    text('Public entries only · Health and computer time stay on their own cards', { color: C.dim, fontSize: 10, marginTop: 16 }),
  ], { width: 520, height: '100%', flexDirection: 'column', padding: 24, backgroundColor: C.bg, color: C.text, fontFamily: 'Inter' });

  return renderCard(node, 520, 900);
}
