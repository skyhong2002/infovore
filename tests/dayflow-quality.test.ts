import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Repository } from '../src/data/database.js';
import { classifyQualityTitles, cleanQualityTitle, qualityHash, type QualityLabel } from '../src/dayflow/quality.js';
import { DayflowQualityWorker } from '../src/dayflow/quality-worker.js';
import type { DayflowBatch } from '../src/dayflow/types.js';
import { keywordPools } from '../src/dayflow/pools.js';
import { dayflowDetails, buildDayflowKeywordsCard } from '../src/output/dayflow.js';

const now = new Date('2026-11-07T12:00:00+08:00');
const config = { baseUrl: 'http://gateway.test/v1/', apiKey: 'private-key', model: 'sky-quality' };
const batch = (day: string, titles: string[], startId = 0): DayflowBatch => ({
  schemaVersion: 1, deviceId: 'private-mac', day, observedAt: now.toISOString(),
  timeZone: 'Asia/Taipei', dayBoundaryHour: 4, categories: [],
  cards: titles.map((title, i) => ({ record_id: startId + i, title, summary: 'PRIVATE SUMMARY Discord', apps: ['private-app'],
    category: 'Work', start: `${day}T12:00:00+08:00`, end: `${day}T12:30:00+08:00`, duration_minutes: 30 })),
});
const label = (name: string, kind: QualityLabel['kind'] = 'topic', confidence = 0.95): QualityLabel => ({ name, kind, confidence });
const reply = (results: unknown, finishReason = 'stop') => new Response(JSON.stringify({ model: 'resolved-quality-model',
  choices: [{ finish_reason: finishReason, message: { content: JSON.stringify({ results }) } }] }));

// The fixture intentionally includes generic narration, tools, and equivalent
// activities with different titles; the API fixture supplies semantic evidence.
test('semantic provider sends only sanitized titles and validates per-title results', async () => {
  const title = '修改樂譜 https://private.example/hidden person@secret.example /Users/sky/hidden ghp_privatecredential123';
  let sent = '';
  const fetchImpl: typeof fetch = async (url, init) => {
    assert.equal(url, 'http://gateway.test/v1/chat/completions');
    sent = String(init?.body);
    const body = JSON.parse(sent);
    assert.equal(body.model, 'sky-quality');
    assert.equal(body.response_format.json_schema.strict, true);
    assert.deepEqual(JSON.parse(body.messages[1].content).activities, [{ id: 0, title: '修改樂譜' }]);
    return reply([{ id: 0, labels: [label('樂譜整理'), label('零散'), label('person@example.com')] }]);
  };
  const result = await classifyQualityTitles([{ hash: qualityHash(title), title }], [], config, fetchImpl);
  assert.deepEqual(result, { labels: [[label('樂譜整理')]], model: 'resolved-quality-model' });
  assert.doesNotMatch(sent, /private\.example|secret\.example|Users|ghp_|private-mac|PRIVATE SUMMARY/);
  assert.equal(qualityHash('MuseScore 樂譜'), qualityHash('ＭuseScore  樂譜'));
  assert.equal(cleanQualityTitle('短暫 /private/path ```code``` token_abcdefghijklmnop'), '短暫');
});

test('incomplete, duplicate, unknown, malformed and truncated model results fail rather than misattribute labels', async () => {
  const inputs = ['a', 'b'].map((title) => ({ title, hash: qualityHash(title) }));
  for (const results of [[], [{ id: 0, labels: [] }, { id: 0, labels: [] }],
    [{ id: 0, labels: [] }, { id: 2, labels: [] }],
    [{ id: 0, labels: [label('unsupported', 'topic', 1.5)] }, { id: 1, labels: [] }]]) {
    await assert.rejects(classifyQualityTitles(inputs, [], config, async () => reply(results)));
  }
  await assert.rejects(classifyQualityTitles(inputs, [], config, async () => reply([], 'length')));
  await assert.rejects(classifyQualityTitles(inputs, [], config, async () => new Response('not JSON')));
  await assert.rejects(classifyQualityTitles(inputs, [], config, async () => new Response('private API body', { status: 503 })), /HTTP 503/);
});

test('background topics persist, invalidate readers, group across days and leave public projections free of private evidence', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'infovore-quality-')), path = join(dir, 'data.sqlite');
  const writer = new Repository(path, { dayflowQuality: true }), reader = new Repository(path, { dayflowQuality: true });
  try {
    writer.dayflow.ingest(batch('2026-11-05', ['零散查看樂譜', '在 MuseScore 調整《A Stormy Sea》'], 1));
    writer.dayflow.ingest(batch('2026-11-06', ['零散查看樂譜', 'HarpScore 匯出《A Stormy Sea》'], 10));
    const revision = reader.dayflow.status().revision;
    assert.equal(reader.dayflow.snapshot('Sky', now).extra.keywordQuality?.mode, 'local');
    const worker = new DayflowQualityWorker(writer.dayflow, config, async (inputs) => ({
      model: 'resolved-quality-model', labels: inputs.map(({ title }) => title.includes('零散') ? [] : [
        label('樂譜整理'), label('A Stormy Sea', 'work'), label('MuseScore', 'tool'), label('不確定的主題', 'topic', 0.4),
      ]),
    }));
    await worker.tick(now);
    assert.ok(reader.dayflow.status().revision > revision);
    const snapshot = reader.dayflow.snapshot('Sky', now);
    assert.equal(snapshot.extra.keywordQuality?.mode, 'ai');
    assert.equal(snapshot.extra.keywordQuality?.classifiedActivities, 4);
    assert.deepEqual(snapshot.extra.keywordPools?.all.map((term) => [term.name, term.mentions]), [['A Stormy Sea', 2], ['樂譜整理', 2]]);
    assert.deepEqual(reader.dayflow.cloudTerms('2026-11-01', now).map((term) => [term.name, term.days, term.seconds]),
      [['A Stormy Sea', 2, 3600], ['樂譜整理', 2, 3600]]);
    const page = dayflowDetails(snapshot.extra), card = await buildDayflowKeywordsCard(snapshot);
    for (const output of [JSON.stringify(snapshot), page, card]) {
      assert.doesNotMatch(output, /PRIVATE SUMMARY|private-mac|private-app|record_id|title_hash|confidence|不確定的主題|MuseScore/);
    }
    assert.match(page, /topics recurring across days/);
    assert.deepEqual(writer.dayflow.quality.pending(writer.dayflow.batchesSince('2026-11-01'), now), [], 'empty results are also cached');
    // A changed title cannot reuse the old classification. Removing one day's
    // evidence drops a topic below the public two-day threshold immediately.
    writer.dayflow.ingest({ ...batch('2026-11-06', ['全新內容'], 10), observedAt: new Date(+now + 1000).toISOString() });
    assert.deepEqual(reader.dayflow.cloudTerms('2026-11-01', now), []);
    assert.deepEqual(reader.dayflow.snapshot('Sky', now).extra.keywordPools?.all, []);
  } finally { writer.close(); reader.close(); }
  const reopened = new Repository(path, { dayflowQuality: true });
  try { assert.equal(reopened.dayflow.snapshot('Sky', now).extra.keywordQuality?.mode, 'ai'); }
  finally { reopened.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('failure cooldown, serial admission and the shared worker lease preserve ingestion and last-good topics', async () => {
  const repo = new Repository(':memory:', { dayflowQuality: true });
  try {
    repo.dayflow.ingest(batch('2026-11-06', ['一個具體主題'], 1));
    let release!: () => void, calls = 0;
    const worker = new DayflowQualityWorker(repo.dayflow, config, async () => {
      calls++;
      await new Promise<void>((resolve) => { release = resolve; });
      throw new Error('private API text');
    });
    const running = worker.tick(now);
    await worker.tick(now);
    assert.equal(calls, 1);
    assert.equal(repo.dayflow.quality.acquire(+now), false);
    assert.equal(repo.dayflow.ingest(batch('2026-11-05', ['另一個主題'], 20)).updated, 1, 'ingestion stays usable while AI is pending');
    release(); await running;
    const pending = repo.dayflow.quality.pending(repo.dayflow.batchesSince('2026-11-01'), new Date());
    assert.equal(pending.length, 1, 'failed title is cooled down but other work remains eligible');
    assert.ok(repo.dayflow.quality.acquire(Date.now()));
    repo.dayflow.quality.release();
  } finally { repo.close(); }
});

test('unclassified history cannot masquerade as a historical baseline for distinctive topics', () => {
  const repo = new Repository(':memory:', { dayflowQuality: true });
  try {
    for (let i = 1; i <= 20; i++) repo.dayflow.ingest(batch(`2026-10-${String(i).padStart(2,'0')}`, ['Discord', 'YouTube', 'Gmail'], i * 10));
    repo.dayflow.ingest(batch('2026-11-05', ['研究新專案'], 1000));
    repo.dayflow.ingest(batch('2026-11-06', ['研究新專案'], 1010));
    repo.dayflow.quality.save([{ hash: qualityHash('研究新專案'), title: '研究新專案' }], [[label('新專案','project')]], 'sky-quality', 'resolved', now);
    const pools = repo.dayflow.snapshot('Sky', now).extra.keywordPools!;
    assert.equal(pools.status, 'insufficient_history');
    assert.equal(pools.baselineActivities, 0);
    assert.deepEqual(pools.all, [{ name: '新專案', mentions: 2 }]);
    assert.deepEqual(pools.distinctive, []);
  } finally { repo.close(); }
});


test('pending replacement titles cannot revive old labels through overlapping imports or fallback', () => {
  const repo = new Repository(':memory:', { dayflowQuality: true });
  try {
    const old = batch('2026-11-05', ['舊的主題'], 1);
    const recent = batch('2026-11-06', ['尚未分類的新主題'], 1);
    repo.dayflow.ingest(old);
    repo.dayflow.quality.save([{ hash: qualityHash('舊的主題'), title: '舊的主題' }], [[label('原有主題')]], 'sky-quality', 'resolved', now);
    repo.dayflow.ingest(recent);
    const lookup = (title: string) => title === '舊的主題' ? [label('原有主題')] : null;
    assert.equal(keywordPools([old, recent], now, lookup).recentActivities, 0);
    assert.equal(repo.dayflow.snapshot('Sky', now).extra.keywordQuality?.mode, 'ai');
    assert.deepEqual(repo.dayflow.cloudTerms('2026-11-01', now), []);
  } finally { repo.close(); }
});

test('model outage preserves already classified topics without resurrecting local narration', async () => {
  const repo = new Repository(':memory:', { dayflowQuality: true });
  try {
    repo.dayflow.ingest(batch('2026-11-05', ['已保存的研究'], 1));
    repo.dayflow.ingest(batch('2026-11-06', ['已保存的研究', '零散瀏覽新內容'], 10));
    repo.dayflow.quality.save([{ hash: qualityHash('已保存的研究'), title: '已保存的研究' }], [[label('研究規劃')]], 'sky-quality', 'resolved', now);
    const before = repo.dayflow.cloudTerms('2026-11-01', now);
    const revision = repo.dayflow.status().revision;
    await new DayflowQualityWorker(repo.dayflow, config, async () => { throw new Error('outage'); }).tick(now);
    assert.deepEqual(repo.dayflow.cloudTerms('2026-11-01', now), before);
    assert.equal(repo.dayflow.status().revision, revision);
    assert.deepEqual(repo.dayflow.snapshot('Sky', now).extra.keywordPools?.all, [{ name: '研究規劃', mentions: 2 }]);
  } finally { repo.close(); }
});
