import assert from 'node:assert/strict';
import test from 'node:test';
import { buildCloudTerms, buildWordCloudCard, layoutCloud, wordCloudNode, type CloudTerm } from '../src/output/cloud.js';
import { logo } from '../src/output/render.js';
import type { Activity } from '../src/data/types.js';

function activity(overrides: Partial<Activity>): Activity {
  return {
    id: 'a', dedupeKey: 'a', source: 'statsfm', sourceItemId: null, type: 'music.play', mediaKind: 'music',
    title: 'Track', image: '', status: null, occurredAt: '2026-09-01T00:00:00Z', occurredAtPrecision: 'exact',
    rating: null, visibility: 'public', extra: {}, firstSeenAt: '2026-09-01T00:00:00Z', lastSeenAt: '2026-09-01T00:00:00Z',
    ...overrides,
  };
}

test('cloud terms merge artists, measured playtime, and channels into attention weights', () => {
  const activities: Activity[] = [
    activity({ extra: { artist: 'Yasunori Mitsuda, Millennial Fair', durationMs: 240_000 } }),
    activity({ extra: { artist: 'Yasunori Mitsuda', durationMs: 240_000 } }),
    activity({ extra: { artist: 'yasunori mitsuda', durationMs: 240_000 } }),
    activity({ source: 'backloggd', mediaKind: 'game', title: 'Theatrhythm', extra: { playtime: '9h 0m' } }),
    activity({ source: 'backloggd', mediaKind: 'game', title: 'Theatrhythm', extra: { playtime: '1h 0m' } }),
    activity({ source: 'simkl', mediaKind: 'movie', title: 'The Odyssey', extra: {} }),
    activity({ source: 'youtube', mediaKind: 'video', title: 'Ignored', extra: { channel: 'Someone' } }),
    activity({ source: 'kitsu', mediaKind: 'anime', title: 'Hidden', visibility: 'private' }),
    activity({ source: 'health', mediaKind: 'fitness', title: 'Sleep', extra: {} }),
    activity({ source: 'dayflow', mediaKind: 'computer', title: 'Coding', extra: {} }),
  ];
  const terms = buildCloudTerms(activities, [
    { name: 'Theo - t3.gg', watches: 6, estimatedWatchSeconds: 5 * 3600 },
    { name: 'Unknown channel', watches: 9, estimatedWatchSeconds: 9000 },
  ]);
  const byLabel = Object.fromEntries(terms.map((term) => [term.label, term]));
  assert.deepEqual(terms.map((term) => term.label), ['Theatrhythm', 'Theo - t3.gg', 'The Odyssey', 'Yasunori Mitsuda', 'Millennial Fair']);
  assert.equal(byLabel.Theatrhythm.weight, 1);
  assert.equal(byLabel.Theatrhythm.count, 2);
  assert.equal(byLabel['Yasunori Mitsuda'].count, 3);
  assert.equal(byLabel['Yasunori Mitsuda'].weight, 0.02);
  assert.equal(byLabel['The Odyssey'].weight, 0.2);
  assert.equal(byLabel['Theo - t3.gg'].source, 'youtube');
  assert.equal(byLabel['Theo - t3.gg'].weight, 0.5);
  assert.ok(!('Ignored' in byLabel) && !('Hidden' in byLabel) && !('Someone' in byLabel));
  assert.ok(!('Sleep' in byLabel) && !('Coding' in byLabel));
});

test('cloud terms take Dayflow keywords and Health workouts through pre-aggregated extras', () => {
  const terms = buildCloudTerms([
    activity({ source: 'backloggd', mediaKind: 'game', title: 'Theatrhythm', extra: { playtime: '10h 0m' } }),
  ], [], [
    { source: 'dayflow', kind: 'computer', label: 'Documentation', count: 12, seconds: 5 * 3600 },
    { source: 'dayflow', kind: 'computer', label: '  ', count: 3, seconds: 3600 },
    { source: 'health', kind: 'fitness', label: 'Walking', count: 78, seconds: 45 * 3600 },
    { source: 'health', kind: 'fitness', label: 'Cycling', count: 0, seconds: 0 },
  ]);
  assert.deepEqual(terms.map((term) => [term.label, term.source, term.weight]), [
    ['Walking', 'health', 1], ['Theatrhythm', 'backloggd', 0.222], ['Documentation', 'dayflow', 0.111],
  ]);
});

test('cloud layout keeps every placed term inside the box without overlaps', () => {
  const terms: CloudTerm[] = Array.from({ length: 40 }, (_, index) => ({
    label: index % 3 === 0 ? `頻道${index}` : `Term number ${index}`, source: 'statsfm', kind: 'music',
    count: 40 - index, weight: (40 - index) / 40,
  }));
  const placed = layoutCloud(terms, 476, 300);
  assert.ok(placed.length >= 24, `placed ${placed.length}`);
  assert.equal(placed[0].label, '頻道0');
  assert.ok(placed[0].fontSize > placed.at(-1)!.fontSize);
  for (const term of placed) {
    assert.ok(term.x >= 0 && term.y >= 0 && term.x + term.width <= 476 && term.y + term.height <= 300, term.label);
    for (const other of placed) {
      if (other === term) continue;
      const apart = term.x + term.width <= other.x || other.x + other.width <= term.x
        || term.y + term.height <= other.y || other.y + other.height <= term.y;
      assert.ok(apart, `${term.label} overlaps ${other.label}`);
    }
  }
});

test('word cloud card renders terms and an empty state', async () => {
  const terms: CloudTerm[] = [
    { label: 'Cy Leo', source: 'statsfm', kind: 'music', count: 91, weight: 1 },
    { label: 'ヨルシカ', source: 'statsfm', kind: 'music', count: 81, weight: 0.5 },
    { label: 'Theatrhythm Final Bar Line', source: 'backloggd', kind: 'game', count: 1, weight: 0.4 },
  ];
  // Satori outlines text into paths, so the copy is checked on the element
  // tree and the SVG only for shape.
  const tree = JSON.stringify(wordCloudNode(terms, { days: 28, ownerName: 'Sky' }));
  assert.match(tree, /3 things across 2 platforms/);
  assert.match(tree, /What Sky has been into/);
  assert.match(tree, /last 28 days/);
  assert.ok(tree.includes(JSON.stringify(logo('infovore'))), 'header carries the infovore mark');
  assert.match(tree, /Noto Sans JP.*"position":"absolute","top":\d+,"whiteSpace":"nowrap"\},"children":"ヨルシカ"/);
  const svg = await buildWordCloudCard(terms, { days: 28, ownerName: 'Sky' });
  assert.match(svg, /^<svg width="520" height="\d+"/);
  const empty = JSON.stringify(wordCloudNode([]));
  assert.match(empty, /Nothing recorded in the last 28 days yet/);
  assert.match(empty, /Waiting for activity/);
  assert.match(await buildWordCloudCard([]), /^<svg width="520"/);
});
