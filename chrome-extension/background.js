import { DEFAULT_ENDPOINT, mergeQueue, retryDelayMs } from './queue.js';

const QUEUE_KEY = 'captureQueue';
const SETTINGS_KEY = 'captureSettings';
const STATUS_KEY = 'captureStatus';
const HISTORY_STATUS_KEY = 'historyImportStatus';
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

function progressEndpoint(endpoint) {
  return endpoint.replace(/\/capture$/, '/progress');
}

async function sendProgressBatch(payload) {
  const config = await settings();
  if (!config.enabled || !config.token) throw new Error('Capture token is not configured');
  let lastError = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const response = await fetch(progressEndpoint(config.endpoint), {
        method: 'POST',
        headers: {
          authorization: `Bearer ${config.token}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify(payload),
      });
      if (response.ok) return await response.json();
      const body = await response.json().catch(() => ({}));
      throw new Error(body?.error || `Progress import failed: HTTP ${response.status}`);
    } catch (error) {
      lastError = error;
      if (attempt < 2) await new Promise((resolve) => setTimeout(resolve, 1000 * (2 ** attempt)));
    }
  }
  throw lastError;
}

async function historyStatus(patch) {
  const stored = await chrome.storage.local.get(HISTORY_STATUS_KEY);
  await chrome.storage.local.set({
    [HISTORY_STATUS_KEY]: {
      ...(stored[HISTORY_STATUS_KEY] ?? {}),
      ...patch,
    },
  });
}

async function waitForTab(tabId) {
  const current = await chrome.tabs.get(tabId);
  if (current.status === 'complete') return;
  await new Promise((resolve) => {
    const listener = (updatedId, changeInfo) => {
      if (updatedId !== tabId || changeInfo.status !== 'complete') return;
      chrome.tabs.onUpdated.removeListener(listener);
      resolve();
    };
    chrome.tabs.onUpdated.addListener(listener);
  });
}

async function startHistoryImport() {
  const config = await settings();
  if (!config.enabled || !config.token) throw new Error('Capture token is not configured');
  const stored = await chrome.storage.local.get(HISTORY_STATUS_KEY);
  if (stored[HISTORY_STATUS_KEY]?.state === 'running') {
    throw new Error('A history import is already running');
  }
  const scanId = crypto.randomUUID();
  const observedAt = new Date().toISOString();
  const tab = await chrome.tabs.create({
    active: true,
    url: 'https://www.youtube.com/feed/history',
  });
  if (!tab.id) throw new Error('Could not open YouTube History');
  await historyStatus({
    state: 'running',
    scanId,
    observedAt,
    tabId: tab.id,
    videos: 0,
    pass: 0,
    lastError: '',
  });
  void (async () => {
    try {
      await waitForTab(tab.id);
      const result = await chrome.tabs.sendMessage(tab.id, {
        type: 'start-history-import',
        scanId,
        observedAt,
      });
      if (!result?.ok) throw new Error(result?.error || 'YouTube History import failed');
    } catch (error) {
      const storedStatus = await chrome.storage.local.get(HISTORY_STATUS_KEY);
      if (storedStatus[HISTORY_STATUS_KEY]?.state === 'cancelled') return;
      await historyStatus({
        state: 'error',
        completedAt: new Date().toISOString(),
        lastError: error instanceof Error ? error.message : String(error),
      });
    }
  })();
  return { scanId, observedAt, tabId: tab.id };
}

async function cancelHistoryImport() {
  const stored = await chrome.storage.local.get(HISTORY_STATUS_KEY);
  const status = stored[HISTORY_STATUS_KEY] ?? {};
  if (status.tabId) {
    await chrome.tabs.sendMessage(status.tabId, { type: 'cancel-history-import' }).catch(() => {});
  }
  await historyStatus({
    state: 'cancelled',
    completedAt: new Date().toISOString(),
    lastError: '',
  });
}

async function finishHistoryImport(scanId, patch) {
  const stored = await chrome.storage.local.get(HISTORY_STATUS_KEY);
  const status = stored[HISTORY_STATUS_KEY] ?? {};
  if (status.scanId !== scanId || status.state !== 'running') return false;
  await historyStatus({
    ...patch,
    completedAt: new Date().toISOString(),
  });
  return true;
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
  if (message?.type === 'history-import-start') {
    startHistoryImport()
      .then((result) => sendResponse({ ok: true, ...result }))
      .catch((error) => {
        sendResponse({ ok: false, error: error instanceof Error ? error.message : String(error) });
      });
    return true;
  }
  if (message?.type === 'history-import-cancel') {
    cancelHistoryImport()
      .then(() => sendResponse({ ok: true }))
      .catch((error) => sendResponse({ ok: false, error: String(error) }));
    return true;
  }
  if (message?.type === 'history-progress-batch' && message.payload) {
    sendProgressBatch(message.payload)
      .then((result) => sendResponse({ ok: true, result }))
      .catch((error) => sendResponse({
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      }));
    return true;
  }
  if (message?.type === 'history-import-progress') {
    historyStatus({
      state: 'running',
      videos: message.videos,
      pass: message.pass,
    })
      .then(() => sendResponse({ ok: true }))
      .catch((error) => sendResponse({ ok: false, error: String(error) }));
    return true;
  }
  if (message?.type === 'history-import-complete') {
    finishHistoryImport(message.scanId, {
      state: 'complete',
      videos: message.videos,
      lastError: '',
    })
      .then((updated) => sendResponse({ ok: true, updated }))
      .catch((error) => sendResponse({ ok: false, error: String(error) }));
    return true;
  }
  if (message?.type === 'history-import-error') {
    finishHistoryImport(message.scanId, {
      state: 'error',
      lastError: String(message.error || 'YouTube History import failed'),
    })
      .then((updated) => sendResponse({ ok: true, updated }))
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
