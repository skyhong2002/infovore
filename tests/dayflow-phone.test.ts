import assert from 'node:assert/strict';
import test from 'node:test';
import { Repository } from '../src/data/database.js';
import { buildSegments, type PhoneObservationRow, type PhoneSegment } from '../src/dayflow/phone-store.js';
import { fallbackCategory, fallbackPhoneCards, pickImages, promptTimeline, summarizePhoneSegment } from '../src/dayflow/phone-summarize.js';
import { DayflowPhoneWorker } from '../src/dayflow/phone-worker.js';
import type { PhoneObservationBatch } from '../src/dayflow/phone-types.js';
import { dayflowDay, type DayflowBatch } from '../src/dayflow/types.js';
import { platformPage } from '../src/output/platforms.js';

const PHONE_TOKEN = 'test-dayflow-phone-token-with-at-least-32-chars';
const TINY_JPEG = Buffer.from('ffd8ffe000104a46494600010100000100010000ffd9', 'hex').toString('base64');
const at = (base: number, minutes: number) => new Date(base + minutes * 60_000).toISOString();

function batchAt(base: number, minutes: number[], extra: Partial<PhoneObservationBatch['observations'][number]> = {}): PhoneObservationBatch {
  return { schemaVersion: 1, deviceId: 'pixel-test', observations: minutes.map((m) => ({
    id: `obs-${base}-${m}-${extra.package ?? 'x'}`.replace(/[^a-zA-Z0-9-]/g, '-'), capturedAt: at(base, m),
    package: 'com.google.android.youtube', appLabel: 'YouTube', text: 'SECRET SCREEN TEXT 口琴教學', blocked: false,
    image: TINY_JPEG, ...extra,
  })) };
}

const row = (capturedAt: number, i: number, extra: Partial<PhoneObservationRow> = {}): PhoneObservationRow => ({
  id: `r${i}`, capturedAt, package: 'com.example', appLabel: 'Example', text: `text ${i}`, blocked: false, image: null, attempts: 0, ...extra,
});

test('phone segments split on screen-off gaps and length, and wait to settle', () => {
  const t0 = Date.parse('2026-11-10T10:00:00+08:00');
  const rows = [0, 1, 2, 10, 11].map((m, i) => row(t0 + m * 60_000, i));
  const settled = buildSegments('d', rows, t0 + 60 * 60_000);
  assert.deepEqual(settled.map((s) => s.observations.length), [3, 2]);
  assert.equal(settled[0].end, t0 + 3 * 60_000);
  // The newest run is still open: the phone may not have uploaded it yet.
  assert.deepEqual(buildSegments('d', rows, t0 + 12 * 60_000).map((s) => s.observations.length), [3]);
  const long = Array.from({ length: 30 }, (_, i) => row(t0 + i * 60_000, i));
  assert.deepEqual(buildSegments('d', long, t0 + 24 * 3600_000).map((s) => s.observations.length), [20, 10]);
});

test('phone summarizer validates contiguous ranges and samples screenshots', async () => {
  const t0 = Date.parse('2026-11-10T10:00:00+08:00');
  const observations = Array.from({ length: 10 }, (_, i) => row(t0 + i * 60_000, i, { image: Buffer.from('img'), text: i === 3 ? 'text 2' : `text ${i}` }));
  observations[2].text = 'text 2';
  observations[5] = { ...observations[5], blocked: true, text: '', image: null };
  const segment: PhoneSegment = { deviceId: 'd', start: t0, end: t0 + 10 * 60_000, observations };
  assert.ok(pickImages(segment).length <= 6 && !pickImages(segment).includes(5));
  const timeline = promptTimeline(segment);
  assert.match(timeline, /#3 .*same screen/);
  assert.match(timeline, /#5 .*blocked/);
  let request: { messages: Array<{ content: unknown }> } | null = null;
  const reply = (cards: unknown) => (async (_url: unknown, init?: RequestInit) => {
    request = JSON.parse(String(init?.body));
    return new Response(JSON.stringify({ model: 'gpt-test', choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({ cards }) } }] }));
  }) as typeof fetch;
  const config = { baseUrl: 'http://gateway/v1', apiKey: 'k', model: 'sky-quality' };
  const ok = await summarizePhoneSegment(segment, config, reply([
    { first: 0, last: 4, title: '看口琴教學', summary: 's', category: 'Learning' },
    { first: 5, last: 9, title: '回訊息', summary: 's', category: 'Communication' },
  ]));
  assert.equal(ok.model, 'gpt-test');
  assert.deepEqual(ok.cards.map((c) => [c.start, c.end]), [[t0, t0 + 5 * 60_000], [t0 + 5 * 60_000, t0 + 10 * 60_000]]);
  const images = (request!.messages[1].content as Array<{ type: string }>).filter((p) => p.type === 'image_url');
  assert.ok(images.length >= 1 && images.length <= 6);
  await assert.rejects(summarizePhoneSegment(segment, config, reply([{ first: 0, last: 3, title: 't', summary: '', category: 'Work' }])));
  await assert.rejects(summarizePhoneSegment(segment, config, reply([{ first: 1, last: 9, title: 't', summary: '', category: 'Work' }])));
});

test('phone fallback cards group app runs without reading screen text', () => {
  const t0 = Date.parse('2026-11-10T10:00:00+08:00');
  const segment: PhoneSegment = { deviceId: 'd', start: t0, end: t0 + 4 * 60_000, observations: [
    row(t0, 0, { package: 'jp.naver.line.android', appLabel: 'LINE' }), row(t0 + 60_000, 1, { package: 'jp.naver.line.android', appLabel: 'LINE' }),
    row(t0 + 120_000, 2, { package: 'com.google.android.apps.nexuslauncher', appLabel: 'Pixel Launcher' }),
    row(t0 + 180_000, 3, { package: 'com.instagram.android', appLabel: 'Instagram' })] };
  const cards = fallbackPhoneCards(segment);
  assert.deepEqual(cards.map((c) => [c.category, c.end - c.start]), [['Communication', 120_000], ['Idle', 60_000], ['Social media', 60_000]]);
  assert.ok(!JSON.stringify(cards).includes('text '));
  assert.equal(fallbackCategory('com.example.pipeline'), 'Life admin');
});

test('phone observations stay private, summarize into a separate Phone section and keep computer time unchanged', async () => {
  const repo = new Repository(':memory:');
  try {
    const now = new Date();
    const base = +now - 90 * 60_000;
    const first = repo.dayflow.phone.ingest(batchAt(base, [0, 1, 2]));
    assert.deepEqual(first, { accepted: 3, duplicates: 0 });
    assert.deepEqual(repo.dayflow.phone.ingest(batchAt(base, [0, 1, 2, 3])), { accepted: 1, duplicates: 3 });
    const computer: DayflowBatch = { schemaVersion: 1, deviceId: 'test-mac', day: dayflowDay(now), observedAt: now.toISOString(),
      timeZone: 'Asia/Taipei', dayBoundaryHour: 4, categories: [{ name: 'Work', color_hex: '#abcdef', is_idle: false, is_system: false }],
      cards: [{ record_id: 1, start: at(+now, -30), end: at(+now, -20), title: 'Mac work', category: 'Work', duration_minutes: 10 }] };
    if (Date.parse(computer.cards[0].start) >= Date.parse(`${computer.day}T04:00:00+08:00`)) repo.dayflow.ingest(computer);
    const before = repo.dayflow.snapshot('Sky', now);
    const revision = repo.dayflow.status().revision;

    let calls = 0;
    const worker = new DayflowPhoneWorker(repo.dayflow.phone, { baseUrl: 'http://gateway/v1', apiKey: 'k', model: 'sky-quality' }, async (segment) => {
      calls++;
      return { model: 'gpt-test', cards: [{ start: segment.start, end: segment.end, title: 'SECRET TITLE 看口琴教學', summary: 'SECRET SUMMARY', category: 'Learning', apps: ['YouTube'] }] };
    });
    assert.equal(await worker.tick(now), 1);
    assert.equal(calls, 1);
    assert.equal(await worker.tick(now), 0, 'processed observations are not summarized twice');
    assert.ok(repo.dayflow.status().revision > revision, 'phone cards invalidate the Dayflow snapshot cache');
    assert.equal(repo.dayflow.phone.status().pending, 0);
    // Re-sent observations after summarizing are still duplicates.
    assert.deepEqual(repo.dayflow.phone.ingest(batchAt(base, [0])), { accepted: 0, duplicates: 1 });

    const snapshot = repo.dayflow.snapshot('Sky', now);
    assert.equal(snapshot.stats.todayMinutes, before.stats.todayMinutes, 'phone time never merges into computer time');
    assert.deepEqual(snapshot.extra.categories, before.extra.categories);
    const phone = snapshot.extra.phone!;
    const phoneMinutes = phone.daily.reduce((sum, d) => sum + d.trackedMinutes, 0);
    assert.ok(Math.abs(phoneMinutes - 4) < 0.01, `expected 4 phone minutes, got ${phoneMinutes}`);
    assert.equal(phone.categories[0].name, 'Learning');
    const page = platformPage('Sky', { source: 'dayflow', title: 'Dayflow', description: 'Computer activity', accent: '#abcdef' }, snapshot, now.toISOString());
    assert.match(page, /href="\/platforms\/phone"/);
    assert.doesNotMatch(JSON.stringify(snapshot), /SECRET|YouTube|pixel-test|看口琴/);
    assert.doesNotMatch(page, /SECRET|pixel-test|看口琴|com\.google/);
  } finally { repo.close(); }
});

test('phone ingestion falls back to app-run cards without a model', async () => {
  const repo = new Repository(':memory:');
  try {
    const base = Date.now() - 3 * 3600_000;
    repo.dayflow.phone.ingest(batchAt(base, [0, 1], { package: 'org.telegram.messenger', appLabel: 'Telegram' }));
    assert.equal(await new DayflowPhoneWorker(repo.dayflow.phone, null).tick(), 1);
    assert.equal(repo.dayflow.snapshot('Sky').extra.phone?.categories[0]?.name, 'Communication');
  } finally { repo.close(); }
});

test('phone HTTP ingestion uses its own token and validates privacy rules', async () => {
  const repo = new Repository(':memory:');
  try {
    const { createIngestApp } = await import('../src/ingest.js');
    const ingest = createIngestApp(repo);
    const send = (value: unknown, token = PHONE_TOKEN) => ingest.request('/api/ingest/dayflow-phone/observations', {
      method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify(value),
    });
    const good = batchAt(Date.now() - 60_000, [0]);
    assert.equal((await send(good, 'test-dayflow-token-with-at-least-32-characters')).status, 401);
    const blockedWithText = { ...good, observations: [{ ...good.observations[0], blocked: true }] };
    const rejected = await send(blockedWithText);
    assert.equal(rejected.status, 400);
    assert.doesNotMatch(await rejected.text(), /SECRET/);
    const response = await send(good);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { ok: true, accepted: 1, duplicates: 0 });
    const status = await ingest.request('/api/ingest/dayflow-phone/status', { headers: { authorization: `Bearer ${PHONE_TOKEN}` } });
    assert.equal(((await status.json()) as { pending: number }).pending, 1);
    // The phone token cannot write computer Dayflow days.
    const mac = await ingest.request('/api/ingest/dayflow/status', { headers: { authorization: `Bearer ${PHONE_TOKEN}` } });
    assert.equal(mac.status, 401);
  } finally { repo.close(); }
});

test('a storage failure after validation answers 503 so the phone keeps its batch', async () => {
  const repo = new Repository(':memory:');
  const quiet = console.error;
  try {
    const { createIngestApp } = await import('../src/ingest.js');
    const ingest = createIngestApp(repo);
    const send = (value: unknown) => ingest.request('/api/ingest/dayflow-phone/observations', {
      method: 'POST', headers: { authorization: `Bearer ${PHONE_TOKEN}`, 'content-type': 'application/json' }, body: JSON.stringify(value),
    });
    console.error = () => {};
    repo.dayflow.phone.ingest = () => { throw new Error('synthetic storage outage'); };
    const failed = await send(batchAt(Date.now() - 60_000, [0]));
    assert.equal(failed.status, 503);
    const body = await failed.json() as { retryable: boolean; error: string };
    assert.equal(body.retryable, true);
    assert.doesNotMatch(body.error, /synthetic/);
    // Malformed input is still a permanent 400.
    assert.equal((await send({ nope: true })).status, 400);
  } finally {
    console.error = quiet;
    repo.close();
  }
});
