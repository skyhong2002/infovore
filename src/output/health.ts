import type { HealthConnectExtra } from '../health/types.js';
import type { SourceSnapshot } from '../data/types.js';
import { h, renderCard } from './render.js';

const C = {
  bg: '#071611',
  panel: '#10251d',
  text: '#f0fff8',
  dim: '#92ad9f',
  accent: '#4ade80',
  blue: '#60a5fa',
  border: '#214336',
};

function amount(value: number): string {
  return new Intl.NumberFormat('en').format(value);
}

export async function buildHealthCard(data: SourceSnapshot<HealthConnectExtra>): Promise<string> {
  const daily = data.extra.daily.slice(0, 7);
  const today = daily[0];
  const maxSteps = Math.max(1, ...daily.map((day) => day.steps));
  const metric = (label: string, value: string, color = C.accent) => h(
    'div',
    { style: { display: 'flex', flexDirection: 'column', backgroundColor: C.panel, border: `1px solid ${C.border}`, borderRadius: 10, padding: '12px 14px', width: 108 } },
    h('span', { style: { color: C.dim, fontSize: 10, textTransform: 'uppercase', letterSpacing: 1 } }, label),
    h('span', { style: { color, fontSize: 20, fontWeight: 700, marginTop: 5 } }, value),
  );
  const bars = [...daily].reverse().map((day) => h(
    'div',
    { style: { display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'flex-end', width: 54, height: 112 } },
    h('span', { style: { color: C.text, fontSize: 9, marginBottom: 4 } }, amount(day.steps)),
    h('div', { style: { backgroundColor: C.accent, borderRadius: 4, display: 'flex', width: 28, height: Math.max(4, Math.round(day.steps / maxSteps * 70)) } }),
    h('span', { style: { color: C.dim, fontSize: 9, marginTop: 5 } }, day.day.slice(5)),
  ));
  const node = h(
    'div',
    { style: { width: '100%', height: '100%', display: 'flex', flexDirection: 'column', backgroundColor: C.bg, border: `1px solid ${C.border}`, borderRadius: 8, padding: '22px 24px', fontFamily: 'Inter' } },
    h(
      'div',
      { style: { display: 'flex', alignItems: 'center' } },
      h('div', { style: { alignItems: 'center', backgroundColor: C.accent, borderRadius: 10, color: C.bg, display: 'flex', fontSize: 22, fontWeight: 700, height: 38, justifyContent: 'center', marginRight: 10, width: 38 } }, '♥'),
      h('div', { style: { display: 'flex', flexDirection: 'column' } },
        h('span', { style: { color: C.text, fontSize: 19, fontWeight: 700 } }, 'Health Connect'),
        h('span', { style: { color: C.dim, fontSize: 10, marginTop: 2 } }, `${amount(data.stats.records ?? 0)} private records · latest ${today?.day ?? '—'}`),
      ),
      h('span', { style: { color: C.text, fontSize: 13, fontWeight: 700, marginLeft: 'auto' } }, data.profile.name),
    ),
    h('div', { style: { display: 'flex', gap: 10, marginTop: 18 } },
      metric('Latest steps', today ? amount(today.steps) : '—'),
      metric('Exercise', today?.exerciseSeconds ? `${Math.round(today.exerciseSeconds / 60)}m` : '—', C.blue),
      metric('Sleep', today?.sleepSeconds ? `${(today.sleepSeconds / 3600).toFixed(1)}h` : '—', '#c084fc'),
      metric('Heart', today?.heartRateAverage ? `${today.heartRateAverage} bpm` : '—', '#fb7185'),
    ),
    h('div', { style: { display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between', marginTop: 18 } }, ...bars),
  );
  return renderCard(node, 520, 350);
}
