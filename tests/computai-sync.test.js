import assert from 'node:assert/strict';
import test from 'node:test';
import { toReport } from '../scripts/computai-sync.mjs';
import { computaiReportSchema } from '../src/computai/types.ts';

// Shaped like `computai --card --json`, including the fields that must stay on the Mac.
const card = {
  period: '30d', tokens: 6996205815, api_equivalent_usd: 6880.14, value_ratio: 11.5, cache_savings_usd: 44837.24,
  rank: 'AI OVERLORD', level: 189, badges: ['MAXED OUT'], persona: 'night_owl', devices: 5,
  ops: { agent_hours: 205.1, peak_parallel: 6, longest_run: 52855, prompts: 57974, cache_hit_pct: 96,
    fleet: [{ source: 'codex', pct: 68 }, { source: 'claude', pct: 32 }] },
  models: [{ model: 'gpt-6-astra', tokens: 3440341365, share_pct: 49 }, { model: 'claude-opus-5-5', tokens: 1618104317, share_pct: 23 }],
  pulse: Array.from({ length: 30 }, (_, i) => i * 1e6),
};

test('ComputAI sync sends only the aggregates the schema accepts', () => {
  const report = toReport(card, { deviceId: 'mbp', now: new Date('2026-10-04T08:00:00Z') });
  assert.equal(computaiReportSchema.safeParse(report).success, true);
  assert.doesNotMatch(JSON.stringify(report), /usd|value_ratio|OVERLORD|189|MAXED|night_owl|prompts|longest/i);
  assert.equal(report.daily.length, 30);
  assert.deepEqual(report.models[0], { model: 'gpt-6-astra', sharePct: 49 });
  assert.throws(() => toReport({ ...card, period: 'month' }, { deviceId: 'mbp' }));
});

test('ComputAI work segments follow the five-minute rule without exposing paths or session ids', async () => {
  const { toSegments } = await import('../scripts/computai-sync.mjs');
  const row = (ts, extra = {}) => ({ source: 'codex', session: 'secret-session-id', subagent: 0, device: '', project: '/Users/me/work/alpha', ts, tokens: 100, requests: 1, ...extra });
  const segments = toSegments([
    row(1000), row(1200), row(1499), row(1900),
    { ...row(1000), device: 'abc123', session: '', project: 'beta' }, { ...row(1100), device: 'abc123', session: '', project: 'gamma' },
  ].sort((a, b) => [a.source, a.device, a.session, a.subagent, a.project].join().localeCompare([b.source, b.device, b.session, b.subagent, b.project].join()) || a.ts - b.ts),
  { machineNames: { abc123: 'mini' }, localMachine: 'my mac' });
  const local = segments.filter((s) => s.machine === 'my-mac');
  assert.deepEqual(local.map((s) => [s.start, s.end, s.requests, s.tokens]), [
    ['1970-01-01T00:16:40.000Z', '1970-01-01T00:25:59.000Z', 3, 300],
    ['1970-01-01T00:31:40.000Z', '1970-01-01T00:32:40.000Z', 1, 100],
  ]);
  assert.equal(local[0].project, 'alpha');
  assert.match(local[0].session, /^[a-f0-9]{12}$/);
  assert.deepEqual(segments.filter((s) => s.machine === 'mini').map((s) => [s.project, s.session]), [['beta', ''], ['gamma', '']]);
  assert.doesNotMatch(JSON.stringify(segments), /secret-session-id|\/Users/);
});
