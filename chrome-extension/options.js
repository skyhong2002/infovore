const SETTINGS_KEY = 'captureSettings';
const DEFAULT_ENDPOINT = 'https://infovore.skyhong.tw/api/ingest/youtube/capture';
const form = document.querySelector('#settings');
const endpoint = document.querySelector('#endpoint');
const token = document.querySelector('#token');
const enabled = document.querySelector('#enabled');
const result = document.querySelector('#result');

async function load() {
  const stored = await chrome.storage.local.get(SETTINGS_KEY);
  const settings = stored[SETTINGS_KEY] ?? {};
  endpoint.value = settings.endpoint ?? DEFAULT_ENDPOINT;
  token.value = settings.token ?? '';
  enabled.checked = settings.enabled ?? true;
}

function values() {
  const url = new URL(endpoint.value);
  if (
    url.protocol !== 'https:'
    || url.hostname !== 'infovore.skyhong.tw'
    || url.pathname !== '/api/ingest/youtube/capture'
  ) {
    throw new Error('Endpoint must be the infovore YouTube capture endpoint');
  }
  if (token.value.length < 32) throw new Error('Capture token must contain at least 32 characters');
  return {
    endpoint: url.toString().replace(/\/$/, ''),
    token: token.value,
    enabled: enabled.checked,
  };
}

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  try {
    await chrome.storage.local.set({ [SETTINGS_KEY]: values() });
    result.textContent = 'Settings saved.';
    await chrome.runtime.sendMessage({ type: 'flush' });
  } catch (error) {
    result.textContent = error instanceof Error ? error.message : String(error);
  }
});

document.querySelector('#test').addEventListener('click', async () => {
  try {
    const settings = values();
    result.textContent = 'Testing connection...';
    const statusUrl = settings.endpoint.replace(/\/capture$/, '/capture/status');
    const response = await fetch(statusUrl, {
      headers: { authorization: `Bearer ${settings.token}` },
    });
    if (!response.ok) throw new Error(`Connection failed: HTTP ${response.status}`);
    result.textContent = 'Connection ready.';
  } catch (error) {
    result.textContent = error instanceof Error ? error.message : String(error);
  }
});

void load();
