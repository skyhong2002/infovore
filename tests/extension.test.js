import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { mergeQueue, retryDelayMs } from '../chrome-extension/queue.js';

await import('../chrome-extension/history.js');

test('Chrome extension manifest is least-privilege and captures YouTube SPA pages', () => {
  const manifest = JSON.parse(readFileSync(
    new URL('../chrome-extension/manifest.json', import.meta.url),
    'utf8',
  ));
  assert.equal(manifest.manifest_version, 3);
  assert.equal(manifest.version, '1.6.0');
  assert.deepEqual(manifest.permissions.sort(), ['alarms', 'storage']);
  assert.deepEqual(manifest.host_permissions, ['https://infovore.skyhong.tw/*']);
  assert.deepEqual(manifest.content_scripts[0].matches, [
    'https://infovore.skyhong.tw/platforms/youtube*',
  ]);
  assert.deepEqual(manifest.content_scripts[0].js, ['dashboard.js']);
  assert.deepEqual(manifest.content_scripts[1].matches, ['https://www.youtube.com/*']);
  assert.deepEqual(manifest.content_scripts[1].js, ['history.js', 'content.js']);
  assert.equal(manifest.background.type, 'module');
});

test('dashboard bridge exposes import status without exposing capture credentials', () => {
  const source = readFileSync(
    new URL('../chrome-extension/dashboard.js', import.meta.url),
    'utf8',
  );
  assert.match(source, /history-import-start/);
  assert.match(source, /history-import-cancel/);
  assert.match(source, /historyImportStatus/);
  assert.doesNotMatch(source, /captureSettings|captureToken|authorization|Bearer/);
});

test('history import reports long-running completion without holding the start message open', () => {
  const background = readFileSync(
    new URL('../chrome-extension/background.js', import.meta.url),
    'utf8',
  );
  const content = readFileSync(
    new URL('../chrome-extension/content.js', import.meta.url),
    'utf8',
  );
  assert.match(content, /history-import-complete/);
  assert.match(content, /history-import-error/);
  assert.match(content, /sendResponse\(\{ ok: true, started: true \}\)/);
  assert.match(background, /status\.scanId !== scanId \|\| status\.state !== 'running'/);
  assert.match(background, /finishHistoryImport\(message\.scanId/);
  assert.doesNotMatch(background, /videos: result\.videos/);
});

test('history import tabs close after completion, cancellation, errors, and extension reloads', () => {
  const background = readFileSync(
    new URL('../chrome-extension/background.js', import.meta.url),
    'utf8',
  );
  assert.match(background, /chrome\.tabs\.remove\(tabId\)/);
  assert.match(background, /void closeHistoryImportTab\(tabId\)/);
  assert.match(background, /await closeHistoryImportTab\(status\.tabId\)/);
  assert.match(background, /chrome\.tabs\.query\(\{\s+url: 'https:\/\/www\.youtube\.com\/feed\/history\*'/);
  assert.match(background, /await closeHistoryImportTabs\(\)/);
  assert.match(background, /historyImport\.state === 'running'/);
  assert.match(background, /await closeHistoryImportTab\(historyImport\.tabId\)/);
});

test('capture retry queue keeps only the newest cumulative session update', () => {
  const first = {
    sessionId: 'capture-session-123456',
    actualWatchedSeconds: 30,
  };
  const second = {
    sessionId: 'capture-session-123456',
    actualWatchedSeconds: 65,
  };
  const initial = mergeQueue([], first, 1_000);
  assert.equal(initial.length, 1);
  const replaced = mergeQueue(initial, second, 2_000);
  assert.equal(replaced.length, 1);
  assert.equal(replaced[0].payload.actualWatchedSeconds, 65);
  assert.equal(replaced[0].attempts, 0);
  assert.equal(replaced[0].nextAttemptAt, 2_000);
  assert.equal(retryDelayMs(1), 30_000);
  assert.equal(retryDelayMs(20), 6 * 60 * 60_000);
});

test('history helper parses duration and merges duplicate resume progress', () => {
  Object.defineProperty(globalThis, 'location', {
    configurable: true,
    value: { origin: 'https://www.youtube.com' },
  });
  const helper = globalThis.infovoreYoutubeHistory;
  assert.equal(helper.parseDurationText('9:35:04'), 34_504);
  assert.equal(helper.parseDurationText('12:34'), 754);
  assert.equal(helper.parseDurationText('LIVE'), null);

  const lockup = ({ progress, resume, duration }) => ({
    querySelector(selector) {
      if (selector.startsWith('h3 a')) {
        return { href: 'https://www.youtube.com/watch?v=ABCDEFGHIJK' };
      }
      if (selector.startsWith('.ytThumbnail')) {
        return { getAttribute: () => `width: ${progress}%` };
      }
      if (selector.includes('[href*="t="]')) {
        return { href: `https://www.youtube.com/watch?v=ABCDEFGHIJK&t=${resume}s` };
      }
      return null;
    },
    querySelectorAll(selector) {
      return selector === '.ytBadgeShapeText'
        ? [{ textContent: duration }]
        : [];
    },
  });
  const items = helper.collectProgress({
    querySelectorAll: () => [
      lockup({ progress: 30, resume: 90, duration: '10:00' }),
      lockup({ progress: 40, resume: 120, duration: '10:00' }),
    ],
  });
  assert.deepEqual(items, [{
    videoId: 'ABCDEFGHIJK',
    progressPercent: 40,
    resumeSeconds: 120,
    durationSeconds: 600,
  }]);
  assert.deepEqual(helper.collectProgressFromRoots([
    lockup({ progress: 25, resume: 75, duration: '10:00' }),
  ]), [{
    videoId: 'ABCDEFGHIJK',
    progressPercent: 25,
    resumeSeconds: 75,
    durationSeconds: 600,
  }]);
});

test('history import processes only newly added lockups and stops after an idle window', () => {
  const source = readFileSync(
    new URL('../chrome-extension/content.js', import.meta.url),
    'utf8',
  );
  assert.match(source, /new MutationObserver/);
  assert.match(source, /collectProgressFromRoots\(roots\)/);
  assert.match(source, /pendingRoots\.clear\(\)/);
  assert.match(source, /idlePasses >= 20/);
  assert.doesNotMatch(source, /infovoreYoutubeHistory\.collectProgress\(\)/);
});
