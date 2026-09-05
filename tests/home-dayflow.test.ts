import assert from 'node:assert/strict';
import test from 'node:test';
import { load } from 'cheerio';
import { Repository } from '../src/data/database.js';
import { homePage, type HomepageData } from '../src/output/home.js';

const home: HomepageData = {
  ownerName: 'Sky', avatar: '', lastUpdated: null, allActivities: [], recentActivities: [],
  sourceHighlights: [], timeSpent: null, publicActivityCount: 0, connectedSources: 1,
};

test('homepage exposes both Dayflow pools even without recent activity entries', () => {
  const repository = new Repository(':memory:');
  try {
    const dayflow = repository.dayflow.snapshot('Sky', new Date('2026-09-06T04:00:00Z'));
    dayflow.extra.keywordPools = {
      all: [{ name: 'Discord', mentions: 30 }, { name: '<Garmin>', mentions: 5 }],
      distinctive: [{ name: '<Garmin>', mentions: 5, historicalMentions: 1, recentDays: 2,
        historicalDays: 1, lift: 3, score: 2 }],
      recentFrom: '2026-08-31', recentTo: '2026-09-06', baselineFrom: '2026-06-02', baselineTo: '2026-08-30',
      recentDays: 6, baselineDays: 80, recentActivities: 90, baselineActivities: 1000, status: 'ready',
    };
    const page = load(homePage({ ...home, dayflow }));
    assert.equal(page('#dayflow .home-dayflow-panel').length, 3);
    assert.match(page('#dayflow').text(), /Discord/);
    assert.match(page('.home-dayflow-distinctive').text(), /<Garmin>/);
    assert.doesNotMatch(page('.home-dayflow-distinctive').text(), /Discord/);
    assert.equal(page('#dayflow garmin').length, 0);
    assert.match(page('#dayflow').text(), /80 recorded baseline days/);
    assert.equal(page('#dayflow a').attr('href'), '/platforms/dayflow');
    assert.equal(page('#recent .home-recent-item').length, 0);
    assert.equal(page('.home-metric-value').first().text(), '—');
  } finally { repository.close(); }
});

test('homepage hides disabled Dayflow and explains empty sync and insufficient history', () => {
  assert.equal(load(homePage(home))('#dayflow').length, 0);
  const repository = new Repository(':memory:');
  try {
    const page = load(homePage({ ...home, dayflow: repository.dayflow.snapshot('Sky') }));
    assert.match(page('#dayflow').text(), /Waiting for the first Dayflow sync/);
    assert.match(page('#dayflow').text(), /More history is needed/);
    assert.match(page('#dayflow').text(), /No recent keywords yet/);
  } finally { repository.close(); }
});
