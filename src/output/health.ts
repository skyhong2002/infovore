import type { HealthConnectExtra } from '../health/types.js';
import type { SourceSnapshot } from '../data/types.js';
import { h, logo, renderCard } from './render.js';

const C = {
  bg: '#111418',
  panel: '#1e232b',
  text: '#e2e5eb',
  dim: '#b5becb',
  accent: '#a8c7fa',
  blue: '#67d5c3',
  border: '#343b46',
};

function amount(value: number): string {
  return new Intl.NumberFormat('en').format(value);
}

function compact(value: number): string {
  return new Intl.NumberFormat('en', {
    notation: 'compact',
    maximumFractionDigits: 1,
  }).format(value);
}

function duration(seconds: number): string {
  if (seconds < 3600) return `${Math.round(seconds / 60)}m`;
  return `${(seconds / 3600).toFixed(1)}h`;
}

export async function buildHealthCard(data: SourceSnapshot<HealthConnectExtra>): Promise<string> {
  const sleepDays = data.extra.sleep?.days ?? [];
  const latestSleep = sleepDays[0];
  const averageSleep = sleepDays.length ? sleepDays.reduce((sum, day) => sum + day.sessionSeconds, 0) / sleepDays.length : 0;
  const daily = data.extra.daily.slice(0, 7);
  const stepDays = daily.filter((day) => day.steps > 0);
  const maxSteps = Math.max(1, ...stepDays.map((day) => day.steps));
  const coverage = data.extra.coverage ?? {};
  const available = [
    ['Steps', 'steps'],
    ['Exercise', 'exercise_session'],
    ['Distance', 'distance'],
    ['Calories', 'total_calories_burned'],
    ['Heart', 'heart_rate'],
    ['Sleep', 'sleep_session'],
    ['Weight', 'weight'],
    ['Body fat', 'body_fat'],
  ].filter(([, type]) => (coverage[type] ?? 0) > 0);
  const waiting = 8 - available.length;
  const metric = (label: string, value: string, color = C.accent) => h(
    'div',
    { style: { display: 'flex', flexDirection: 'column', backgroundColor: C.panel, border: `1px solid ${C.border}`, borderRadius: 10, padding: '12px 14px', width: 108 } },
    h('span', { style: { color: C.dim, fontSize: 10, textTransform: 'uppercase', letterSpacing: 1 } }, label),
    h('span', { style: { color, fontSize: 20, fontWeight: 700, marginTop: 5 } }, value),
  );
  const bars = [...stepDays].reverse().map((day) => h(
    'div',
    { style: { display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'flex-end', width: 54, height: 112 } },
    h('span', { style: { color: C.text, fontSize: 9, marginBottom: 4 } }, amount(day.steps)),
    h('div', { style: { backgroundColor: C.accent, borderRadius: 4, display: 'flex', width: 28, height: Math.max(4, Math.round(day.steps / maxSteps * 70)) } }),
    h('span', { style: { color: C.dim, fontSize: 9, marginTop: 5 } }, day.day.slice(5)),
  ));
  const coverageChips = available.map(([label, type]) => h(
    'div',
    { style: { alignItems: 'center', backgroundColor: C.panel, border: `1px solid ${C.border}`, borderRadius: 999, color: C.dim, display: 'flex', fontSize: 10, padding: '6px 10px' } },
    h('span', { style: { color: C.accent, fontWeight: 700, marginRight: 5 } }, '✓'),
    `${label} ${compact(coverage[type] ?? 0)}`,
  ));
  const lower = stepDays.length > 0
    ? h(
      'div',
      { style: { display: 'flex', flexDirection: 'column', marginTop: 18 } },
      h('div', { style: { color: C.dim, fontSize: 10, letterSpacing: 1, textTransform: 'uppercase' } }, 'Recent step days'),
      h('div', { style: { alignItems: 'flex-end', display: 'flex', justifyContent: 'space-between', marginTop: 6 } }, ...bars),
    )
    : h(
      'div',
      { style: { backgroundColor: C.panel, border: `1px solid ${C.border}`, borderRadius: 12, display: 'flex', flexDirection: 'column', marginTop: 18, padding: '12px 14px' } },
      h('div', { style: { alignItems: 'center', display: 'flex' } },
        h('span', { style: { color: C.dim, fontSize: 10, letterSpacing: 1, textTransform: 'uppercase' } }, 'Sync coverage'),
        h('span', { style: { color: C.dim, fontSize: 10, marginLeft: 'auto' } }, waiting ? `${waiting} data types not available yet` : 'All data types available'),
      ),
      h('div', { style: { display: 'flex', flexWrap: 'wrap', gap: 7, marginTop: 10 } }, ...coverageChips),
    );
  const node = h(
    'div',
    { style: { width: '100%', height: '100%', display: 'flex', flexDirection: 'column', backgroundColor: C.bg, border: `1px solid ${C.border}`, borderRadius: 18, padding: '22px 24px', fontFamily: 'Roboto' } },
    h(
      'div',
      { style: { display: 'flex', alignItems: 'center' } },
      h('div', { style: { alignItems: 'center', backgroundColor: '#ffffff', borderRadius: 10, display: 'flex', height: 38, justifyContent: 'center', marginRight: 10, width: 38 } },
        h('img', { src: logo('healthconnect'), alt: 'Health Connect logo', width: 30, height: 30 }),
      ),
      h('div', { style: { display: 'flex', flexDirection: 'column' } },
        h('span', { style: { color: C.text, fontSize: 19, fontWeight: 700 } }, 'Health Connect'),
        h('span', { style: { color: C.dim, fontSize: 10, marginTop: 2 } }, `${amount(data.stats.records ?? 0)} records · ${amount(data.stats.trackedDays ?? 0)} tracked days`),
      ),
      h('span', { style: { color: C.text, fontSize: 13, fontWeight: 700, marginLeft: 'auto' } }, data.profile.name),
    ),
    h('div', { style: { display: 'flex', flexDirection: 'column', marginTop: 18 } },
      h('span', { style: { color: C.accent, fontSize: 12, fontWeight: 700, marginBottom: 8 } }, 'Sleep · session duration'),
      latestSleep ? h('div', { style: { display: 'flex', gap: 10 } },
        metric('Latest sleep', duration(latestSleep.sessionSeconds)),
        metric('Wake-up day', latestSleep.day.slice(5)),
        metric('Avg / day', duration(averageSleep)),
        metric('Sleep records', amount(data.extra.sleep?.totalSessions ?? 0)),
      ) : h('span', { style: { color: C.dim, fontSize: 12 } }, 'No sleep records received. Use the sleep-only sync in the app.'),
      latestSleep ? h('span', { style: { color: C.dim, fontSize: 10, marginTop: 6 } }, `${latestSleep.day} · average over ${sleepDays.length} recorded days · includes awake time`) : null,
    ),
    h('div', { style: { display: 'flex', gap: 10, marginTop: 18 } },
      metric('Total steps', compact(data.stats.totalSteps ?? 0)),
      metric('Daily average', compact(data.stats.averageDailySteps ?? 0)),
      metric('Workouts', amount(data.stats.workouts ?? 0), C.blue),
      metric('Active time', duration(data.stats.totalExerciseSeconds ?? 0), C.blue),
    ),
    lower,
  );
  return renderCard(node, 520, 300);
}
