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
  assert.deepEqual(manifest.permissions.sort(), ['alarms', 'storage']);
  assert.deepEqual(manifest.host_permissions, ['https://infovore.skyhong.tw/*']);
  assert.deepEqual(manifest.content_scripts[0].matches, ['https://www.youtube.com/*']);
  assert.equal(manifest.background.type, 'module');
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
});
