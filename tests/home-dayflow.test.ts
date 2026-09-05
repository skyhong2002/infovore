import assert from 'node:assert/strict';
import test from 'node:test';
import { load } from 'cheerio';
import { activityFromEntry } from '../src/data/activity.js';
import { Repository } from '../src/data/database.js';
import { homePage, type HomepageData } from '../src/output/home.js';

const home: HomepageData = {
  ownerName: 'Sky', avatar: '', lastUpdated: null, allActivities: [], recentActivities: [],
  sourceHighlights: [], timeSpent: null, publicActivityCount: 0, connectedSources: 1,
};

test('Dayflow joins platform highlights, time rows and recent activity without a standalone section', () => {
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
    const activity = activityFromEntry({ source: 'dayflow', sourceItemId: 'day:2026-09-05',
      image: '/logos/dayflow.png', rating: null, kind: 'computer', title: 'Computer activity', activityAt: '2026-09-05',
      extra: { activeMinutes: 60, idleMinutes: 30 } }, '2026-09-05T04:00:00+08:00');
    dayflow.extra.daily = [{ day: '2026-09-05', trackedMinutes: 90, activeMinutes: 60,
      idleMinutes: 30, errorMinutes: 0, categories: [], keywords: [{ name: '<Garmin>', mentions: 2 }] }];
    const page = load(homePage({ ...home, dayflow, sourceHighlights: [activity],
      recentActivities: [activity], allActivities: [activity] }));
    assert.equal(page('#dayflow, .home-dayflow-panel').length, 0);
    const tile = page('.home-platform-tile[href="/platforms/dayflow"]');
    assert.match(tile.text(), /Distinctive: <Garmin>/);
    assert.match(tile.text(), /Recent: Discord/);
    assert.equal(page('garmin').length, 0);
    assert.match(page('[data-source="dayflow"]').text(), /Dayflow · active.*1h/);
    assert.equal(page('#recent a').first().attr('href'), '/profile');
    assert.equal(page('#recent .home-recent-title').attr('href'), '/platforms/dayflow');
    assert.match(page('#recent .home-keywords').text(), /<Garmin>/);
    assert.equal(page('[data-hour]').length, 0, 'daily summaries must not invent hourly events');
    assert.equal(page('.home-metric-value').first().text(), '—', 'computer time must not double-count media time');
  } finally { repository.close(); }
});

test('empty or disabled Dayflow does not invent homepage sections or time rows', () => {
  assert.equal(load(homePage(home))('#dayflow').length, 0);
  const repository = new Repository(':memory:');
  try {
    const page = load(homePage({ ...home, dayflow: repository.dayflow.snapshot('Sky') }));
    assert.equal(page('#dayflow, [data-source="dayflow"], .home-keywords').length, 0);
  } finally { repository.close(); }
});
