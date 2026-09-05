import assert from 'node:assert/strict';
import test from 'node:test';
import { load } from 'cheerio';
import { Repository } from '../src/data/database.js';
import { homePage, type HomepageData } from '../src/output/home.js';

const home: HomepageData = {
  ownerName: 'Sky', avatar: '', lastUpdated: null, allActivities: [], recentActivities: [],
  sourceHighlights: [], timeSpent: null, publicActivityCount: 0, connectedSources: 1,
};

test('homepage omits Health when unavailable and labels missing data when connected', () => {
  assert.equal(load(homePage(home))('#health').length, 0);
  const repository = new Repository(':memory:');
  try {
    const page = load(homePage({ ...home, health: repository.healthConnectSnapshot('Sky') }));
    assert.equal(page('#health').length, 1);
    assert.match(page('#health').text(), /尚未收到睡眠紀錄/);
    assert.match(page('.home-health-movement').text(), /運動 未提供/);
    assert.match(page('.home-health-movement').text(), /步數 未提供/);
    assert.equal(page('.sleep-row').length, 0);
  } finally { repository.close(); }
});

test('homepage shows seven historical sleep days independently of its activity feed', () => {
  const repository = new Repository(':memory:');
  try {
    const at = (day: number, hour: number) => new Date(Date.UTC(2026, 6, day, hour)).toISOString();
    repository.ingestHealthConnect({ syncId: 'homepage-health', deviceId: 'private-device',
      observedAt: at(11, 0), deletedRecordIds: [], records: Array.from({ length: 10 }, (_, i) => ({
        id: `private-sleep-${i}`, dataType: 'sleep_session', dataOrigin: 'private-origin',
        startTime: at(i + 1, 15), endTime: at(i + 1, 23), lastModifiedTime: at(i + 1, 23),
        payload: { notes: 'private-note', stages: [
          { startTime: at(i + 1, 15), endTime: at(i + 1, 18), stage: 5 },
          { startTime: at(i + 1, 18), endTime: at(i + 1, 23), stage: 6 },
        ] },
      })),
    });
    const snapshot = repository.healthConnectSnapshot('Sky', new Date('2026-09-05T00:00:00Z'));
    const rendered = homePage({ ...home, health: snapshot });
    const page = load(rendered);
    assert.equal(page('#health .sleep-row').length, 7);
    assert.equal(page('#health .sleep-row[open]').length, 0);
    assert.equal(page('#health .sleep-row').first().find('time').attr('datetime'), '2026-07-11');
    assert.equal(page('#health .sleep-row').last().find('time').attr('datetime'), '2026-07-05');
    assert.match(page('.sleep-stats').text(), /23:00/);
    assert.match(page('.sleep-stats').text(), /07:00/);
    assert.match(page('.sleep-stats').text(), /8h 0m/);
    assert.equal(page('.home-health-notes:not([open])').length, 1);
    assert.ok(page('.sleep-segment.deep').length > 0);
    assert.equal(page('.home-health-head img').attr('src'), '/logos/healthconnect.png');
    assert.equal(page('.home-health-head a').attr('href'), '/platforms/health#sleep');
    assert.doesNotMatch(rendered, /private-note|private-sleep|private-device|private-origin/);
    assert.equal(snapshot.extra.sleep?.days.length, 10, 'homepage does not truncate the shared snapshot');
  } finally { repository.close(); }
});
