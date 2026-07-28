import { DEFAULT_ENDPOINT, mergeQueue, retryDelayMs } from './queue.js';

const QUEUE_KEY = 'captureQueue';
const SETTINGS_KEY = 'captureSettings';
const STATUS_KEY = 'captureStatus';
let queueMutation = Promise.resolve();
let flushPromise = null;

async function settings() {
  const stored = await chrome.storage.local.get(SETTINGS_KEY);
  return {
    endpoint: DEFAULT_ENDPOINT,
    token: '',
    enabled: true,
    ...(stored[SETTINGS_KEY] ?? {}),
  };
}

async function updateStatus(patch) {
  const stored = await chrome.storage.local.get([STATUS_KEY, QUEUE_KEY]);
  await chrome.storage.local.set({
    [STATUS_KEY]: {
      ...(stored[STATUS_KEY] ?? {}),
      ...patch,
      pending: (stored[QUEUE_KEY] ?? []).length,
    },
  });
}

async function updateBadge(pending) {
  await chrome.action.setBadgeBackgroundColor({ color: '#b9472e' });
  await chrome.action.setBadgeText({ text: pending ? String(Math.min(99, pending)) : '' });
}

async function enqueue(payload) {
  const operation = queueMutation.then(async () => {
    const stored = await chrome.storage.local.get(QUEUE_KEY);
    const queue = mergeQueue(stored[QUEUE_KEY], payload);
    await chrome.storage.local.set({ [QUEUE_KEY]: queue });
    await updateBadge(queue.length);
  });
  queueMutation = operation.catch(() => {});
  await operation;
  void flushQueue();
}

async function send(item, config) {
  const response = await fetch(config.endpoint, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${config.token}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify(item.payload),
  });
  if (response.ok) return { ok: true };
  let detail = `HTTP ${response.status}`;
  try {
    const body = await response.json();
    if (body?.error) detail = `${detail}: ${body.error}`;
  } catch {
    // The status code is enough when the response is not JSON.
  }
  return {
    ok: false,
    permanent: response.status === 400,
    auth: response.status === 401 || response.status === 403,
    detail,
  };
}

async function runFlush() {
  const config = await settings();
  const stored = await chrome.storage.local.get(QUEUE_KEY);
  const queue = Array.isArray(stored[QUEUE_KEY]) ? stored[QUEUE_KEY] : [];
  if (!config.enabled || !config.token) {
    await updateStatus({
      configured: Boolean(config.token),
      lastError: config.enabled ? 'Capture token is not configured' : '',
    });
    await updateBadge(queue.length);
    return;
  }

  const remaining = [];
  let lastSuccessAt = null;
  let lastError = '';
  for (const item of queue) {
    if (item.nextAttemptAt > Date.now()) {
      remaining.push(item);
      continue;
    }
    try {
      const result = await send(item, config);
      if (result.ok) {
        lastSuccessAt = new Date().toISOString();
        continue;
      }
      lastError = result.detail;
      if (result.permanent) continue;
      const attempts = Number(item.attempts ?? 0) + 1;
      remaining.push({
        ...item,
        attempts,
        nextAttemptAt: Date.now() + retryDelayMs(attempts),
      });
      if (result.auth) {
        remaining.push(...queue.slice(queue.indexOf(item) + 1));
        break;
      }
    } catch (error) {
      const attempts = Number(item.attempts ?? 0) + 1;
      remaining.push({
        ...item,
        attempts,
        nextAttemptAt: Date.now() + retryDelayMs(attempts),
      });
      lastError = error instanceof Error ? error.message : String(error);
    }
  }
  await chrome.storage.local.set({
    [QUEUE_KEY]: remaining,
    [STATUS_KEY]: {
      configured: true,
      pending: remaining.length,
      lastSuccessAt: lastSuccessAt
        ?? (await chrome.storage.local.get(STATUS_KEY))[STATUS_KEY]?.lastSuccessAt
        ?? null,
      lastError,
    },
  });
  await updateBadge(remaining.length);
}

function flushQueue() {
  if (!flushPromise) {
    const operation = queueMutation.then(runFlush);
    queueMutation = operation.catch(() => {});
    flushPromise = operation.finally(() => {
      flushPromise = null;
    });
  }
  return flushPromise;
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === 'capture' && message.payload) {
    enqueue(message.payload)
      .then(() => sendResponse({ queued: true }))
      .catch((error) => sendResponse({ queued: false, error: String(error) }));
    return true;
  }
  if (message?.type === 'flush') {
    flushQueue()
      .then(() => sendResponse({ ok: true }))
      .catch((error) => sendResponse({ ok: false, error: String(error) }));
    return true;
  }
  return false;
});

chrome.runtime.onInstalled.addListener(async () => {
  const stored = await chrome.storage.local.get(SETTINGS_KEY);
  if (!stored[SETTINGS_KEY]) {
    await chrome.storage.local.set({
      [SETTINGS_KEY]: { endpoint: DEFAULT_ENDPOINT, token: '', enabled: true },
    });
    await chrome.runtime.openOptionsPage();
  }
  await chrome.alarms.create('flush-captures', { periodInMinutes: 1 });
  void flushQueue();
});

chrome.runtime.onStartup.addListener(async () => {
  await chrome.alarms.create('flush-captures', { periodInMinutes: 1 });
  void flushQueue();
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === 'flush-captures') void flushQueue();
});
