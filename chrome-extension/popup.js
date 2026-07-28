async function render() {
  const stored = await chrome.storage.local.get([
    'captureSettings',
    'captureQueue',
    'captureStatus',
  ]);
  const settings = stored.captureSettings ?? {};
  const status = stored.captureStatus ?? {};
  const configured = Boolean(settings.token);
  document.querySelector('#state').textContent = !settings.enabled
    ? 'Capture paused'
    : configured ? 'Capture active' : 'Setup required';
  document.querySelector('#pending').textContent = String(
    status.pending ?? stored.captureQueue?.length ?? 0
  );
  document.querySelector('#last-sync').textContent = status.lastSuccessAt
    ? new Date(status.lastSuccessAt).toLocaleString()
    : 'Never';
  document.querySelector('#error').textContent = status.lastError ?? '';
}

document.querySelector('#sync').addEventListener('click', async () => {
  await chrome.runtime.sendMessage({ type: 'flush' });
  await render();
});
document.querySelector('#options').addEventListener('click', () => {
  void chrome.runtime.openOptionsPage();
});

void render();
